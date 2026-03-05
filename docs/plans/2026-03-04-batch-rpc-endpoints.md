# Batch RPC Endpoints Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reduce startup network requests from ~100 to under 15 by adding server-side batch RPCs that aggregate multiple existing per-item RPC calls into a single round-trip.

**Architecture:** Each domain (FRED, BIS, Trade, Supply Chain, HAPI) gets one new "dashboard" or "bulk" RPC that the server handles by fanning out to its existing cached individual handlers in parallel. The client replaces N individual calls with 1 batch call. No new upstream HTTP calls are added — each sub-handler already has Redis caching. Proto files must be updated + code regenerated (via `make generate`) before implementing client-side changes.

**Tech Stack:** TypeScript, protobuf (sebuf/buf), Next.js Edge runtime, Redis caching (`cachedFetchJson`), existing RPC handler pattern.

---

## Background: How the RPC system works

Each domain follows this pattern:
1. `proto/worldmonitor/<domain>/v1/service.proto` — declares the service + RPCs
2. `proto/worldmonitor/<domain>/v1/<message>.proto` — declares request/response messages
3. `make generate` — regenerates `src/generated/client/.../service_client.ts` and `src/generated/server/.../service_server.ts`
4. `server/worldmonitor/<domain>/v1/handler.ts` — implements the handler interface
5. `server/worldmonitor/<domain>/v1/<rpc>.ts` — per-RPC implementation file
6. `src/services/<domain>/index.ts` — client-side service wrapper with circuit breaker
7. `src/app/data-loader.ts` — calls client service during startup

**Savings per batch:**
- FRED: 7 → 1 (7 series fetched with individual `getFredSeries` calls)
- BIS: 3 → 1 (3 BIS endpoints: policy rates, exchange rates, credit)
- Trade: 4 → 1 (4 endpoints: restrictions, tariff trends, flows, barriers)
- Supply Chain: 3 → 1 (3 endpoints: shipping rates, chokepoints, critical minerals)
- HAPI: 20 → 1 (20 country codes, server already fetches all countries in a single upstream request)

**Total: ~37 requests → 5 requests** for those domains.

---

## Implementation Notes

- Run `make generate` after every proto change — this regenerates TypeScript types in `src/generated/`
- Regenerated files are committed; do not manually edit `src/generated/`
- Keep the existing individual RPCs — do not remove them (backward compat)
- Server batch handlers use `Promise.allSettled` over existing handler calls — no new Redis keys needed
- Each task is independently testable and committable
- Tests use source-text assertions (like existing tests) since mocking the full RPC stack is heavyweight

---

## Task 1: FRED Batch — `GetFredDashboard`

**Savings: 7 requests → 1**

**Files:**
- Create: `proto/worldmonitor/economic/v1/get_fred_dashboard.proto`
- Modify: `proto/worldmonitor/economic/v1/service.proto`
- Run: `make generate` (updates `src/generated/`)
- Create: `server/worldmonitor/economic/v1/get-fred-dashboard.ts`
- Modify: `server/worldmonitor/economic/v1/handler.ts`
- Modify: `src/services/economic/index.ts`
- Modify: `src/app/data-loader.ts`
- Create: `tests/fred-dashboard-batch.test.mjs`

**Step 1: Write the failing test**

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('FRED dashboard batch', () => {
  it('proto defines GetFredDashboard RPC', () => {
    const proto = readFileSync('proto/worldmonitor/economic/v1/service.proto', 'utf-8');
    assert.ok(proto.includes('GetFredDashboard'), 'missing GetFredDashboard in service.proto');
  });

  it('server handler exports getFredDashboard', () => {
    const src = readFileSync('server/worldmonitor/economic/v1/handler.ts', 'utf-8');
    assert.ok(src.includes('getFredDashboard'), 'missing getFredDashboard in handler');
  });

  it('client service exports fetchFredDashboard replacing individual fetches', () => {
    const src = readFileSync('src/services/economic/index.ts', 'utf-8');
    assert.ok(src.includes('fetchFredDashboard'), 'missing fetchFredDashboard in economic service');
  });

  it('data-loader uses fetchFredDashboard instead of fetchFredData', () => {
    const src = readFileSync('src/app/data-loader.ts', 'utf-8');
    assert.ok(src.includes('fetchFredDashboard'), 'data-loader should use fetchFredDashboard');
    assert.ok(!src.includes('fetchFredData('), 'data-loader should not call fetchFredData directly');
  });
});
```

Run: `npx tsx --test tests/fred-dashboard-batch.test.mjs`
Expected: FAIL (none of these exist yet).

**Step 2: Create the proto message file**

Create `proto/worldmonitor/economic/v1/get_fred_dashboard.proto`:

```proto
syntax = "proto3";

package worldmonitor.economic.v1;

import "worldmonitor/economic/v1/economic_data.proto";

// GetFredDashboardRequest requests all FRED dashboard series in one call.
message GetFredDashboardRequest {}

// GetFredDashboardResponse contains all FRED series for the dashboard.
message GetFredDashboardResponse {
  // All available FRED series (WALCL, FEDFUNDS, T10Y2Y, UNRATE, CPIAUCSL, DGS10, VIXCLS).
  repeated FredSeries series = 1;
}
```

**Step 3: Register in service.proto**

Add to `proto/worldmonitor/economic/v1/service.proto` (import + RPC):

```proto
import "worldmonitor/economic/v1/get_fred_dashboard.proto";
```

And inside the service block:

```proto
  // GetFredDashboard retrieves all FRED dashboard series in a single batch call.
  rpc GetFredDashboard(GetFredDashboardRequest) returns (GetFredDashboardResponse) {
    option (sebuf.http.config) = {path: "/get-fred-dashboard", method: HTTP_METHOD_GET};
  }
```

**Step 4: Regenerate**

```bash
make generate
```

Expected: `src/generated/client/worldmonitor/economic/v1/service_client.ts` and `src/generated/server/worldmonitor/economic/v1/service_server.ts` now include `GetFredDashboard`.

**Step 5: Create the server handler**

Create `server/worldmonitor/economic/v1/get-fred-dashboard.ts`:

```typescript
/**
 * RPC: getFredDashboard -- batch fetch all 7 FRED dashboard series in parallel.
 * Fans out to the existing getFredSeries handler (with its Redis caching) for each series.
 * Returns all series in a single response.
 */

import type {
  ServerContext,
  GetFredDashboardRequest,
  GetFredDashboardResponse,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

import { getFredSeries } from './get-fred-series';

const FRED_DASHBOARD_SERIES = [
  { id: 'WALCL', limit: 120 },
  { id: 'FEDFUNDS', limit: 120 },
  { id: 'T10Y2Y', limit: 120 },
  { id: 'UNRATE', limit: 120 },
  { id: 'CPIAUCSL', limit: 120 },
  { id: 'DGS10', limit: 120 },
  { id: 'VIXCLS', limit: 120 },
];

export async function getFredDashboard(
  ctx: ServerContext,
  _req: GetFredDashboardRequest,
): Promise<GetFredDashboardResponse> {
  const results = await Promise.allSettled(
    FRED_DASHBOARD_SERIES.map(({ id, limit }) =>
      getFredSeries(ctx, { seriesId: id, limit }),
    ),
  );

  const series = results
    .map(r => (r.status === 'fulfilled' ? r.value.series : undefined))
    .filter((s): s is NonNullable<typeof s> => s !== undefined);

  return { series };
}
```

**Step 6: Register in handler.ts**

Add to `server/worldmonitor/economic/v1/handler.ts`:

```typescript
import { getFredDashboard } from './get-fred-dashboard';
```

And add to the `economicHandler` object:

```typescript
  getFredDashboard,
```

**Step 7: Update client service**

In `src/services/economic/index.ts`, add after the existing FRED imports:

```typescript
import type { GetFredDashboardResponse } from '@/generated/client/worldmonitor/economic/v1/service_client';
```

Add a new circuit breaker and function (keep existing `fetchFredData` — do NOT remove it):

```typescript
const fredDashboardBreaker = createCircuitBreaker<GetFredDashboardResponse>({
  name: 'FRED Dashboard',
  cacheTtlMs: 60 * 60 * 1000,
  persistCache: true,
});

const emptyFredDashboard: GetFredDashboardResponse = { series: [] };

export async function fetchFredDashboard(): Promise<FredSeries[]> {
  if (!isFeatureAvailable('economicFred')) return [];
  try {
    const resp = await fredDashboardBreaker.execute(async () => {
      return client.getFredDashboard({});
    }, emptyFredDashboard);
    return resp.series as FredSeries[];
  } catch {
    return [];
  }
}
```

**Step 8: Update data-loader.ts**

In `src/app/data-loader.ts`:
- Add `fetchFredDashboard` to the import from `@/services/economic`
- Remove `fetchFredData` from that import
- In `loadFredData()`, replace `await fetchFredData()` with `await fetchFredDashboard()`

```typescript
// Before (in loadFredData):
const data = await fetchFredData();

// After:
const data = await fetchFredDashboard();
```

**Step 9: Run tests**

```bash
npx tsx --test tests/fred-dashboard-batch.test.mjs
```
Expected: PASS.

```bash
npm run typecheck
```
Expected: No new errors.

**Step 10: Commit**

```bash
git add proto/worldmonitor/economic/v1/get_fred_dashboard.proto \
        proto/worldmonitor/economic/v1/service.proto \
        src/generated/client/worldmonitor/economic/v1/service_client.ts \
        src/generated/server/worldmonitor/economic/v1/service_server.ts \
        server/worldmonitor/economic/v1/get-fred-dashboard.ts \
        server/worldmonitor/economic/v1/handler.ts \
        src/services/economic/index.ts \
        src/app/data-loader.ts \
        tests/fred-dashboard-batch.test.mjs
git commit -m "perf: add GetFredDashboard batch RPC (7→1)"
```

---

## Task 2: BIS Batch — `GetBisDashboard`

**Savings: 3 requests → 1**

**Files:**
- Create: `proto/worldmonitor/economic/v1/get_bis_dashboard.proto`
- Modify: `proto/worldmonitor/economic/v1/service.proto`
- Run: `make generate`
- Create: `server/worldmonitor/economic/v1/get-bis-dashboard.ts`
- Modify: `server/worldmonitor/economic/v1/handler.ts`
- Modify: `src/services/economic/index.ts`
- Modify: `src/app/data-loader.ts`
- Create: `tests/bis-dashboard-batch.test.mjs`

**Step 1: Write the failing test**

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('BIS dashboard batch', () => {
  it('proto defines GetBisDashboard RPC', () => {
    const proto = readFileSync('proto/worldmonitor/economic/v1/service.proto', 'utf-8');
    assert.ok(proto.includes('GetBisDashboard'), 'missing GetBisDashboard in service.proto');
  });

  it('server handler exports getBisDashboard', () => {
    const src = readFileSync('server/worldmonitor/economic/v1/handler.ts', 'utf-8');
    assert.ok(src.includes('getBisDashboard'), 'missing getBisDashboard in handler');
  });

  it('data-loader uses fetchBisDashboard (one call not three)', () => {
    const src = readFileSync('src/app/data-loader.ts', 'utf-8');
    assert.ok(src.includes('fetchBisDashboard'), 'data-loader should use fetchBisDashboard');
  });
});
```

Run: `npx tsx --test tests/bis-dashboard-batch.test.mjs`
Expected: FAIL.

**Step 2: Create the proto message file**

Create `proto/worldmonitor/economic/v1/get_bis_dashboard.proto`:

```proto
syntax = "proto3";

package worldmonitor.economic.v1;

import "worldmonitor/economic/v1/bis_data.proto";

// GetBisDashboardRequest requests all BIS dashboard data in one call.
message GetBisDashboardRequest {}

// GetBisDashboardResponse contains all BIS dashboard data.
message GetBisDashboardResponse {
  repeated BisPolicyRate policy_rates = 1;
  repeated BisExchangeRate exchange_rates = 2;
  repeated BisCreditGdp credit_gdp = 3;
}
```

**Step 3: Register in service.proto**

Add import and RPC to `proto/worldmonitor/economic/v1/service.proto`:

```proto
import "worldmonitor/economic/v1/get_bis_dashboard.proto";
```

```proto
  // GetBisDashboard retrieves all BIS dashboard data (policy rates, exchange rates, credit) in one call.
  rpc GetBisDashboard(GetBisDashboardRequest) returns (GetBisDashboardResponse) {
    option (sebuf.http.config) = {path: "/get-bis-dashboard", method: HTTP_METHOD_GET};
  }
```

**Step 4: Regenerate**

```bash
make generate
```

**Step 5: Create server handler**

Read `proto/worldmonitor/economic/v1/bis_data.proto` first to confirm `BisExchangeRate` and `BisCreditGdp` type names.

Create `server/worldmonitor/economic/v1/get-bis-dashboard.ts`:

```typescript
/**
 * RPC: getBisDashboard -- batch fetch all BIS dashboard data in parallel.
 * Fans out to the existing BIS handlers (with their Redis caching).
 */

import type {
  ServerContext,
  GetBisDashboardRequest,
  GetBisDashboardResponse,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

import { getBisPolicyRates } from './get-bis-policy-rates';
import { getBisExchangeRates } from './get-bis-exchange-rates';
import { getBisCredit } from './get-bis-credit';

export async function getBisDashboard(
  ctx: ServerContext,
  _req: GetBisDashboardRequest,
): Promise<GetBisDashboardResponse> {
  const [policyResult, eerResult, creditResult] = await Promise.allSettled([
    getBisPolicyRates(ctx, {}),
    getBisExchangeRates(ctx, {}),
    getBisCredit(ctx, {}),
  ]);

  return {
    policyRates: policyResult.status === 'fulfilled' ? policyResult.value.rates : [],
    exchangeRates: eerResult.status === 'fulfilled' ? eerResult.value.rates : [],
    creditGdp: creditResult.status === 'fulfilled' ? creditResult.value.ratios : [],
  };
}
```

**Note:** Check the field names on `GetBisPolicyRatesResponse`, `GetBisExchangeRatesResponse`, and `GetBisCreditResponse` in `src/generated/server/worldmonitor/economic/v1/service_server.ts` after `make generate` to confirm `.rates` and `.ratios` are correct.

**Step 6: Register in handler.ts**

Add to `server/worldmonitor/economic/v1/handler.ts`:

```typescript
import { getBisDashboard } from './get-bis-dashboard';
```

Add to `economicHandler`:
```typescript
  getBisDashboard,
```

**Step 7: Update client service**

In `src/services/economic/index.ts`, add after the existing BIS imports:

```typescript
import type { GetBisDashboardResponse } from '@/generated/client/worldmonitor/economic/v1/service_client';
```

Add breaker and function (keep existing BIS functions):

```typescript
const bisDashboardBreaker = createCircuitBreaker<GetBisDashboardResponse>({
  name: 'BIS Dashboard',
  cacheTtlMs: 6 * 60 * 60 * 1000,
  persistCache: true,
});

const emptyBisDashboard: GetBisDashboardResponse = { policyRates: [], exchangeRates: [], creditGdp: [] };

export async function fetchBisDashboard(): Promise<GetBisDashboardResponse> {
  try {
    return await bisDashboardBreaker.execute(async () => {
      return client.getBisDashboard({});
    }, emptyBisDashboard);
  } catch {
    return emptyBisDashboard;
  }
}
```

**Step 8: Update data-loader.ts**

Find `loadBisData()` in `src/app/data-loader.ts`. The current implementation calls `Promise.allSettled([bisPolicyBreaker..., bisEerBreaker..., bisCreditBreaker...])`.

Replace that parallel fanout with a single `fetchBisDashboard()` call:

```typescript
// Before: 3 separate calls inside loadBisData()
// After:
const resp = await fetchBisDashboard();
// then use resp.policyRates, resp.exchangeRates, resp.creditGdp
```

Add `fetchBisDashboard` to the import from `@/services/economic` in data-loader.

**Step 9: Run tests**

```bash
npx tsx --test tests/bis-dashboard-batch.test.mjs
npm run typecheck
```

**Step 10: Commit**

```bash
git add proto/worldmonitor/economic/v1/get_bis_dashboard.proto \
        proto/worldmonitor/economic/v1/service.proto \
        src/generated/client/worldmonitor/economic/v1/service_client.ts \
        src/generated/server/worldmonitor/economic/v1/service_server.ts \
        server/worldmonitor/economic/v1/get-bis-dashboard.ts \
        server/worldmonitor/economic/v1/handler.ts \
        src/services/economic/index.ts \
        src/app/data-loader.ts \
        tests/bis-dashboard-batch.test.mjs
git commit -m "perf: add GetBisDashboard batch RPC (3→1)"
```

---

## Task 3: Trade Batch — `GetTradeDashboard`

**Savings: 4 requests → 1**

**Files:**
- Create: `proto/worldmonitor/trade/v1/get_trade_dashboard.proto`
- Modify: `proto/worldmonitor/trade/v1/service.proto`
- Run: `make generate`
- Create: `server/worldmonitor/trade/v1/get-trade-dashboard.ts`
- Modify: `server/worldmonitor/trade/v1/handler.ts`
- Modify: `src/services/trade/index.ts`
- Modify: `src/app/data-loader.ts`
- Create: `tests/trade-dashboard-batch.test.mjs`

**Step 1: Write the failing test**

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('trade dashboard batch', () => {
  it('proto defines GetTradeDashboard RPC', () => {
    const proto = readFileSync('proto/worldmonitor/trade/v1/service.proto', 'utf-8');
    assert.ok(proto.includes('GetTradeDashboard'), 'missing GetTradeDashboard in service.proto');
  });

  it('server handler exports getTradeDashboard', () => {
    const src = readFileSync('server/worldmonitor/trade/v1/handler.ts', 'utf-8');
    assert.ok(src.includes('getTradeDashboard'), 'missing getTradeDashboard in handler');
  });

  it('data-loader uses fetchTradeDashboard (one call not four)', () => {
    const src = readFileSync('src/app/data-loader.ts', 'utf-8');
    assert.ok(src.includes('fetchTradeDashboard'), 'data-loader should use fetchTradeDashboard');
    assert.ok(!src.includes('fetchTradeRestrictions('), 'data-loader should not call fetchTradeRestrictions directly');
  });
});
```

Run: `npx tsx --test tests/trade-dashboard-batch.test.mjs`
Expected: FAIL.

**Step 2: Create proto message file**

Read the existing individual trade proto files to confirm field names:
- `proto/worldmonitor/trade/v1/get_trade_restrictions.proto`
- `proto/worldmonitor/trade/v1/get_tariff_trends.proto`
- `proto/worldmonitor/trade/v1/get_trade_flows.proto`
- `proto/worldmonitor/trade/v1/get_trade_barriers.proto`

Create `proto/worldmonitor/trade/v1/get_trade_dashboard.proto`:

```proto
syntax = "proto3";

package worldmonitor.trade.v1;

import "worldmonitor/trade/v1/get_trade_restrictions.proto";
import "worldmonitor/trade/v1/get_tariff_trends.proto";
import "worldmonitor/trade/v1/get_trade_flows.proto";
import "worldmonitor/trade/v1/get_trade_barriers.proto";

// GetTradeDashboardRequest requests all trade dashboard data in one call.
// Uses default parameters: top 50 restrictions, US-China tariffs/flows, top 50 barriers.
message GetTradeDashboardRequest {}

// GetTradeDashboardResponse aggregates all trade dashboard data.
message GetTradeDashboardResponse {
  GetTradeRestrictionsResponse restrictions = 1;
  GetTariffTrendsResponse tariffs = 2;
  GetTradeFlowsResponse flows = 3;
  GetTradeBarriersResponse barriers = 4;
}
```

**Step 3: Register in service.proto**

Add to `proto/worldmonitor/trade/v1/service.proto`:

```proto
import "worldmonitor/trade/v1/get_trade_dashboard.proto";
```

```proto
  // GetTradeDashboard retrieves all trade dashboard data in a single batch call.
  rpc GetTradeDashboard(GetTradeDashboardRequest) returns (GetTradeDashboardResponse) {
    option (sebuf.http.config) = {path: "/get-trade-dashboard", method: HTTP_METHOD_GET};
  }
```

**Step 4: Regenerate**

```bash
make generate
```

**Step 5: Create server handler**

Create `server/worldmonitor/trade/v1/get-trade-dashboard.ts`:

```typescript
/**
 * RPC: getTradeDashboard -- batch fetch all trade dashboard data in parallel.
 * Uses default parameters matching what data-loader.ts currently uses.
 */

import type {
  ServerContext,
  GetTradeDashboardRequest,
  GetTradeDashboardResponse,
} from '../../../../src/generated/server/worldmonitor/trade/v1/service_server';

import { getTradeRestrictions } from './get-trade-restrictions';
import { getTariffTrends } from './get-tariff-trends';
import { getTradeFlows } from './get-trade-flows';
import { getTradeBarriers } from './get-trade-barriers';

const emptyRestrictions = { restrictions: [], fetchedAt: '', upstreamUnavailable: false };
const emptyTariffs = { datapoints: [], fetchedAt: '', upstreamUnavailable: false };
const emptyFlows = { flows: [], fetchedAt: '', upstreamUnavailable: false };
const emptyBarriers = { barriers: [], fetchedAt: '', upstreamUnavailable: false };

export async function getTradeDashboard(
  ctx: ServerContext,
  _req: GetTradeDashboardRequest,
): Promise<GetTradeDashboardResponse> {
  const [restrictionsResult, tariffsResult, flowsResult, barriersResult] = await Promise.allSettled([
    getTradeRestrictions(ctx, { countries: [], limit: 50 }),
    getTariffTrends(ctx, { reportingCountry: '840', partnerCountry: '156', productSector: '', years: 10 }),
    getTradeFlows(ctx, { reportingCountry: '840', partnerCountry: '156', limit: 10 }),
    getTradeBarriers(ctx, { countries: [], productSector: '', limit: 50 }),
  ]);

  return {
    restrictions: restrictionsResult.status === 'fulfilled' ? restrictionsResult.value : emptyRestrictions,
    tariffs: tariffsResult.status === 'fulfilled' ? tariffsResult.value : emptyTariffs,
    flows: flowsResult.status === 'fulfilled' ? flowsResult.value : emptyFlows,
    barriers: barriersResult.status === 'fulfilled' ? barriersResult.value : emptyBarriers,
  };
}
```

**Step 6: Register in handler.ts**

Add import and `getTradeDashboard` to `server/worldmonitor/trade/v1/handler.ts`.

**Step 7: Update client service**

In `src/services/trade/index.ts`, add a `fetchTradeDashboard()` function using a new circuit breaker (keep existing functions).

**Step 8: Update data-loader.ts**

In `loadTradePolicy()`, replace the 4-call `Promise.allSettled` with a single `await fetchTradeDashboard()` call. Destructure the response fields to match existing rendering code.

Check `loadTradePolicy()` carefully — the current code at lines ~1896–1929 calls the 4 functions and uses their results. Keep all rendering logic, only replace the data-fetching.

**Step 9: Run tests and typecheck**

```bash
npx tsx --test tests/trade-dashboard-batch.test.mjs
npm run typecheck
```

**Step 10: Commit**

```bash
git add proto/worldmonitor/trade/v1/get_trade_dashboard.proto \
        proto/worldmonitor/trade/v1/service.proto \
        src/generated/client/worldmonitor/trade/v1/service_client.ts \
        src/generated/server/worldmonitor/trade/v1/service_server.ts \
        server/worldmonitor/trade/v1/get-trade-dashboard.ts \
        server/worldmonitor/trade/v1/handler.ts \
        src/services/trade/index.ts \
        src/app/data-loader.ts \
        tests/trade-dashboard-batch.test.mjs
git commit -m "perf: add GetTradeDashboard batch RPC (4→1)"
```

---

## Task 4: Supply Chain Batch — `GetSupplyChainDashboard`

**Savings: 3 requests → 1**

**Files:**
- Create: `proto/worldmonitor/supply_chain/v1/get_supply_chain_dashboard.proto`
- Modify: `proto/worldmonitor/supply_chain/v1/service.proto`
- Run: `make generate`
- Create: `server/worldmonitor/supply-chain/v1/get-supply-chain-dashboard.ts`
- Modify: `server/worldmonitor/supply-chain/v1/handler.ts`
- Modify: `src/services/supply-chain/index.ts`
- Modify: `src/app/data-loader.ts`
- Create: `tests/supply-chain-dashboard-batch.test.mjs`

**Step 1: Write the failing test**

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('supply chain dashboard batch', () => {
  it('proto defines GetSupplyChainDashboard RPC', () => {
    const proto = readFileSync('proto/worldmonitor/supply_chain/v1/service.proto', 'utf-8');
    assert.ok(proto.includes('GetSupplyChainDashboard'), 'missing GetSupplyChainDashboard in service.proto');
  });

  it('server handler exports getSupplyChainDashboard', () => {
    const src = readFileSync('server/worldmonitor/supply-chain/v1/handler.ts', 'utf-8');
    assert.ok(src.includes('getSupplyChainDashboard'), 'missing getSupplyChainDashboard in handler');
  });

  it('data-loader uses fetchSupplyChainDashboard (one call not three)', () => {
    const src = readFileSync('src/app/data-loader.ts', 'utf-8');
    assert.ok(src.includes('fetchSupplyChainDashboard'), 'data-loader should use fetchSupplyChainDashboard');
    assert.ok(!src.includes('fetchShippingRates()'), 'data-loader should not call fetchShippingRates directly');
  });
});
```

Run: `npx tsx --test tests/supply-chain-dashboard-batch.test.mjs`
Expected: FAIL.

**Step 2: Create proto message file**

Read existing supply chain proto files to confirm response field names:
- `proto/worldmonitor/supply_chain/v1/get_shipping_rates.proto`
- `proto/worldmonitor/supply_chain/v1/get_chokepoint_status.proto`
- `proto/worldmonitor/supply_chain/v1/get_critical_minerals.proto`

Create `proto/worldmonitor/supply_chain/v1/get_supply_chain_dashboard.proto`:

```proto
syntax = "proto3";

package worldmonitor.supply_chain.v1;

import "worldmonitor/supply_chain/v1/get_shipping_rates.proto";
import "worldmonitor/supply_chain/v1/get_chokepoint_status.proto";
import "worldmonitor/supply_chain/v1/get_critical_minerals.proto";

// GetSupplyChainDashboardRequest requests all supply chain dashboard data in one call.
message GetSupplyChainDashboardRequest {}

// GetSupplyChainDashboardResponse aggregates all supply chain dashboard data.
message GetSupplyChainDashboardResponse {
  GetShippingRatesResponse shipping = 1;
  GetChokepointStatusResponse chokepoints = 2;
  GetCriticalMineralsResponse minerals = 3;
}
```

**Step 3: Register in service.proto**

Add import and RPC to `proto/worldmonitor/supply_chain/v1/service.proto`.

**Step 4: Regenerate**

```bash
make generate
```

**Step 5: Create server handler**

Create `server/worldmonitor/supply-chain/v1/get-supply-chain-dashboard.ts`:

```typescript
/**
 * RPC: getSupplyChainDashboard -- batch fetch all supply chain dashboard data.
 */

import type {
  ServerContext,
  GetSupplyChainDashboardRequest,
  GetSupplyChainDashboardResponse,
} from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';

import { getShippingRates } from './get-shipping-rates';
import { getChokepointStatus } from './get-chokepoint-status';
import { getCriticalMinerals } from './get-critical-minerals';

export async function getSupplyChainDashboard(
  ctx: ServerContext,
  _req: GetSupplyChainDashboardRequest,
): Promise<GetSupplyChainDashboardResponse> {
  const [shippingResult, chokepointResult, mineralsResult] = await Promise.allSettled([
    getShippingRates(ctx, {}),
    getChokepointStatus(ctx, {}),
    getCriticalMinerals(ctx, {}),
  ]);

  return {
    shipping: shippingResult.status === 'fulfilled' ? shippingResult.value : { indices: [], fetchedAt: '', upstreamUnavailable: false },
    chokepoints: chokepointResult.status === 'fulfilled' ? chokepointResult.value : { chokepoints: [], fetchedAt: '', upstreamUnavailable: false },
    minerals: mineralsResult.status === 'fulfilled' ? mineralsResult.value : { minerals: [], fetchedAt: '', upstreamUnavailable: false },
  };
}
```

**Step 6: Register in handler.ts and update client**

Same pattern as Trade: add import + handler entry, add `fetchSupplyChainDashboard()` to `src/services/supply-chain/index.ts`.

**Step 7: Update data-loader.ts**

In `loadSupplyChain()`, replace the 3-call `Promise.allSettled` with `await fetchSupplyChainDashboard()`.

**Step 8: Run tests and commit**

```bash
npx tsx --test tests/supply-chain-dashboard-batch.test.mjs
npm run typecheck
git add ... && git commit -m "perf: add GetSupplyChainDashboard batch RPC (3→1)"
```

---

## Task 5: HAPI Batch — `ListAllHumanitarianSummaries`

**Savings: 20 requests → 1**

This is the highest-impact change. The server already fetches all countries in a single upstream HAPI request (when no `countryCode` filter is provided) — it just doesn't expose a batch RPC. The client currently makes 20 individual `getHumanitarianSummary` calls.

**Files:**
- Create: `proto/worldmonitor/conflict/v1/list_all_humanitarian_summaries.proto`
- Modify: `proto/worldmonitor/conflict/v1/service.proto`
- Run: `make generate`
- Create: `server/worldmonitor/conflict/v1/list-all-humanitarian-summaries.ts`
- Modify: `server/worldmonitor/conflict/v1/handler.ts`
- Modify: `src/services/conflict/index.ts`
- Modify: `src/app/data-loader.ts`
- Create: `tests/hapi-batch.test.mjs`

**Step 1: Write the failing test**

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('HAPI batch', () => {
  it('proto defines ListAllHumanitarianSummaries RPC', () => {
    const proto = readFileSync('proto/worldmonitor/conflict/v1/service.proto', 'utf-8');
    assert.ok(proto.includes('ListAllHumanitarianSummaries'), 'missing RPC in service.proto');
  });

  it('server handler exports listAllHumanitarianSummaries', () => {
    const src = readFileSync('server/worldmonitor/conflict/v1/handler.ts', 'utf-8');
    assert.ok(src.includes('listAllHumanitarianSummaries'), 'missing in handler');
  });

  it('conflict service exports fetchAllHapiSummaries', () => {
    const src = readFileSync('src/services/conflict/index.ts', 'utf-8');
    assert.ok(src.includes('fetchAllHapiSummaries'), 'missing fetchAllHapiSummaries in conflict service');
  });

  it('data-loader uses fetchAllHapiSummaries not looping fetchHapiSummary', () => {
    const src = readFileSync('src/app/data-loader.ts', 'utf-8');
    assert.ok(src.includes('fetchAllHapiSummaries'), 'data-loader should use fetchAllHapiSummaries');
    // fetchHapiSummary (singular) should no longer be called directly in data-loader
    assert.ok(!src.includes('fetchHapiSummary('), 'data-loader should not call fetchHapiSummary directly');
  });
});
```

Run: `npx tsx --test tests/hapi-batch.test.mjs`
Expected: FAIL.

**Step 2: Check existing proto types**

Read `proto/worldmonitor/conflict/v1/get_humanitarian_summary.proto` to confirm `HumanitarianCountrySummary` message name.

**Step 3: Create proto message file**

Create `proto/worldmonitor/conflict/v1/list_all_humanitarian_summaries.proto`:

```proto
syntax = "proto3";

package worldmonitor.conflict.v1;

import "worldmonitor/conflict/v1/get_humanitarian_summary.proto";

// ListAllHumanitarianSummariesRequest requests summaries for all monitored countries.
message ListAllHumanitarianSummariesRequest {}

// ListAllHumanitarianSummariesResponse contains summaries for all monitored countries.
message ListAllHumanitarianSummariesResponse {
  repeated HumanitarianCountrySummary summaries = 1;
}
```

**Step 4: Register in service.proto**

Add to `proto/worldmonitor/conflict/v1/service.proto`:

```proto
import "worldmonitor/conflict/v1/list_all_humanitarian_summaries.proto";
```

```proto
  // ListAllHumanitarianSummaries retrieves humanitarian summaries for all monitored countries.
  // Replaces 20 individual GetHumanitarianSummary calls with a single batch request.
  rpc ListAllHumanitarianSummaries(ListAllHumanitarianSummariesRequest) returns (ListAllHumanitarianSummariesResponse) {
    option (sebuf.http.config) = {path: "/list-all-humanitarian-summaries", method: HTTP_METHOD_GET};
  }
```

**Step 5: Regenerate**

```bash
make generate
```

**Step 6: Create server handler**

The key insight: `fetchHapiSummary` in `get-humanitarian-summary.ts` already fetches all countries when no country code is specified. We reuse this by calling `getHumanitarianSummary` for each country in parallel — but since they all hit Redis-cached individual entries, this is N cache reads vs. 1 upstream HTTP call (which is the current behavior).

Create `server/worldmonitor/conflict/v1/list-all-humanitarian-summaries.ts`:

```typescript
/**
 * RPC: listAllHumanitarianSummaries -- returns HAPI summaries for all 20 monitored countries.
 *
 * Implementation strategy: calls the existing getHumanitarianSummary handler in parallel for
 * all country codes. Each individual call is Redis-cached at its own key
 * (conflict:humanitarian:v1:<ISO2>) so the parallel fanout hits cache, not the upstream API.
 * This converts 20 browser→server round-trips into 1.
 */

import type {
  ServerContext,
  ListAllHumanitarianSummariesRequest,
  ListAllHumanitarianSummariesResponse,
  HumanitarianCountrySummary,
} from '../../../../src/generated/server/worldmonitor/conflict/v1/service_server';

import { getHumanitarianSummary } from './get-humanitarian-summary';

const MONITORED_COUNTRY_CODES = [
  'US', 'RU', 'CN', 'UA', 'IR', 'IL', 'TW', 'KP', 'SA', 'TR',
  'PL', 'DE', 'FR', 'GB', 'IN', 'PK', 'SY', 'YE', 'MM', 'VE',
];

export async function listAllHumanitarianSummaries(
  ctx: ServerContext,
  _req: ListAllHumanitarianSummariesRequest,
): Promise<ListAllHumanitarianSummariesResponse> {
  const results = await Promise.allSettled(
    MONITORED_COUNTRY_CODES.map(countryCode =>
      getHumanitarianSummary(ctx, { countryCode }),
    ),
  );

  const summaries: HumanitarianCountrySummary[] = results
    .map(r => (r.status === 'fulfilled' ? r.value.summary : undefined))
    .filter((s): s is HumanitarianCountrySummary => s !== undefined);

  return { summaries };
}
```

**Step 7: Register in handler.ts**

Add to `server/worldmonitor/conflict/v1/handler.ts`:

```typescript
import { listAllHumanitarianSummaries } from './list-all-humanitarian-summaries';
```

Add to `conflictHandler`:
```typescript
  listAllHumanitarianSummaries,
```

**Step 8: Update client conflict service**

In `src/services/conflict/index.ts`, add a `fetchAllHapiSummaries()` function. The existing `fetchHapiSummary()` makes 20 `client.getHumanitarianSummary()` calls. Replace with one `client.listAllHumanitarianSummaries()` call:

```typescript
import type { ListAllHumanitarianSummariesResponse } from '@/generated/client/worldmonitor/conflict/v1/service_client';

// Keep existing hapiBreaker/fallback for backward compat, add new batch breaker:
const hapiAllBreaker = createCircuitBreaker<ListAllHumanitarianSummariesResponse>({
  name: 'HDX HAPI All',
  cacheTtlMs: 10 * 60 * 1000,
  persistCache: true,
});

const emptyHapiAll: ListAllHumanitarianSummariesResponse = { summaries: [] };

export async function fetchAllHapiSummaries(): Promise<Map<string, HapiConflictSummary>> {
  const resp = await hapiAllBreaker.execute(async () => {
    return client.listAllHumanitarianSummaries({});
  }, emptyHapiAll);

  const byCode = new Map<string, HapiConflictSummary>();
  for (const summary of resp.summaries) {
    byCode.set(summary.countryCode, toHapiSummary(summary));
  }
  return byCode;
}
```

Note: `toHapiSummary` is a private function in `src/services/conflict/index.ts`. Since `fetchAllHapiSummaries` is in the same file, it can use it directly.

**Step 9: Update data-loader.ts**

Find the call to `fetchHapiSummary()` in `loadIntelligenceSignals()` (or wherever it's called). Replace it with `fetchAllHapiSummaries()`.

Add `fetchAllHapiSummaries` to the import from `@/services/conflict`.
Remove `fetchHapiSummary` from the import if it's no longer used directly.

**Step 10: Run tests and typecheck**

```bash
npx tsx --test tests/hapi-batch.test.mjs
npm run typecheck
```

**Step 11: Commit**

```bash
git add proto/worldmonitor/conflict/v1/list_all_humanitarian_summaries.proto \
        proto/worldmonitor/conflict/v1/service.proto \
        src/generated/client/worldmonitor/conflict/v1/service_client.ts \
        src/generated/server/worldmonitor/conflict/v1/service_server.ts \
        server/worldmonitor/conflict/v1/list-all-humanitarian-summaries.ts \
        server/worldmonitor/conflict/v1/handler.ts \
        src/services/conflict/index.ts \
        src/app/data-loader.ts \
        tests/hapi-batch.test.mjs
git commit -m "perf: add ListAllHumanitarianSummaries batch RPC (20→1)"
```

---

## Task 6: Increase Phase B Delay

**Savings: Phase B tasks no longer compete with first paint**

The current 50ms delay does not meaningfully yield to the browser. The Phase A tasks (news + markets) take 300–800ms to complete. Phase B starts at ~50ms after `loadAllData()` is called — essentially simultaneously.

**Files:**
- Modify: `src/app/startup-load-profile.ts`
- Modify: `tests/startup-load-profile.test.mjs`

**Step 1: Update startup load profile**

In `src/app/startup-load-profile.ts`, add a `phaseBDelayMs` field:

```typescript
export interface StartupLoadProfile {
  initialRequestBudget: number;
  phaseBDelayMs: number;
  phaseA: StartupTaskName[];
  phaseB: StartupTaskName[];
  phaseC: StartupTaskName[];
}

export function getStartupLoadProfile(_variant: string): StartupLoadProfile {
  return {
    initialRequestBudget: 10,
    phaseBDelayMs: 2000,  // 2 seconds after Phase A awaited — gives browser time to render
    phaseA: ['news', 'markets'],
    phaseB: ['predictions', 'fred', 'oil', 'bis', 'pizzint'],
    phaseC: ['intelligence', 'natural', 'weather', 'ais', 'cables', 'cyberThreats'],
  };
}
```

**Step 2: Update data-loader.ts**

In `loadAllData()`, replace the hardcoded `50` with `profile.phaseBDelayMs`:

```typescript
// Before:
setTimeout(() => { ... }, 50);

// After:
setTimeout(() => { ... }, profile.phaseBDelayMs);
```

**Step 3: Update tests**

In `tests/startup-load-profile.test.mjs`, add:
```javascript
assert.ok(profile.phaseBDelayMs >= 1000, 'phaseBDelayMs should be at least 1000ms');
assert.strictEqual(profile.phaseBDelayMs, 2000);
```

**Step 4: Run tests and commit**

```bash
npx tsx --test tests/startup-load-profile.test.mjs
git add src/app/startup-load-profile.ts src/app/data-loader.ts tests/startup-load-profile.test.mjs
git commit -m "perf: increase Phase B startup delay to 2000ms"
```

---

## Verification Checklist (Before PR)

1. `npx tsx --test tests/fred-dashboard-batch.test.mjs tests/bis-dashboard-batch.test.mjs tests/trade-dashboard-batch.test.mjs tests/supply-chain-dashboard-batch.test.mjs tests/hapi-batch.test.mjs`
2. `npm run typecheck`
3. Manual startup count check:
   - Open DevTools Network tab, disable cache
   - Hard reload the app
   - Count requests in the first 200ms: should be 2 (news digest + market dashboard)
   - Count requests at 200ms–2000ms: should be 0 (Phase A still running)
   - Count requests at 2000ms+: should be ~5 Phase B batch calls + maps
   - Total within 5s: target under 15

---

## Expected Result After All Tasks

| Domain | Before | After |
|--------|--------|-------|
| FRED | 7 | 1 |
| BIS | 3 | 1 |
| Trade policy | 4 | 1 |
| Supply chain | 3 | 1 |
| HAPI | 20 | 1 |
| Phase B delay | 50ms | 2000ms |
| **Total (these domains)** | **37** | **5** |
| **Net savings** | | **−32 requests** |
