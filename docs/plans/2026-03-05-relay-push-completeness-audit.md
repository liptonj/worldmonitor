# Relay-Push Completeness Audit & Fix

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Wire the relay-push architecture end-to-end so pushed payloads actually update the UI — all `apply*` stubs in data-loader must render the same way the corresponding `load*` methods do, two missing `applyPush` panel methods must be added, and deployment env vars must be verified.

**Architecture:** The relay broadcasts JSON payloads (the raw Vercel API response body) to subscribed clients on named channels. `App.ts` receives each payload and calls `dataLoader.applyXxx(payload)` or `panel.applyPush(payload)`. These methods must mirror the rendering logic of their `loadXxx` counterparts — but without the `fetch` step. On connect, the relay replays its last cached payload per channel (`sendCachedPayloads`), so the first push is the initial data load.

**Tech Stack:** TypeScript, `src/app/data-loader.ts`, panel components in `src/components/`, `src/App.ts`, `scripts/ais-relay.cjs`, Vercel, Railway.

---

## Audit Summary

| Category | Finding | Status |
|---|---|---|
| Build | `npm run build` passes, 0 TypeScript errors | ✅ |
| Tests | 562/562 pass | ✅ |
| WebSocket client | `relay-push.ts` connects, subscribes, dispatches | ✅ |
| Relay cron | All channels scheduled with `scheduleWarmAndBroadcast` | ✅ |
| App.ts wiring | `setupRelayPush()` subscribes all channels + calls handlers | ✅ |
| `apply*` stubs | All 19 methods in `data-loader.ts` are empty no-ops | ❌ **critical** |
| `StrategicRiskPanel.applyPush` | Not implemented — subscription silently discarded | ❌ |
| `StrategicPosturePanel.applyPush` | Not implemented — subscription silently discarded | ❌ |
| `VITE_WS_RELAY_URL` | Set locally, **not in `vercel.json`** (must be Vercel env var) | ⚠️ verify |
| `VERCEL_APP_URL` | Relay defaults to `worldmonitor.app` if unset | ⚠️ verify |
| Extra relay channels | `gulf-quotes`, `tech-events`, `oref`, `iran-events`, `gps-interference`, `eonet`, `gdacs`, `config:news-sources`, `config:feature-flags` are broadcast but not subscribed in App.ts | ℹ️ low priority |

---

## Key Pattern: apply* vs load*

Each `apply*` method receives the raw Vercel API response body as `payload`. Strip the fetch and error-handling boilerplate from the corresponding `load*` method, type-assert the payload, and run the same rendering calls.

```typescript
// load* pattern (current):
async loadBisData(): Promise<void> {
  try {
    const dashboard = await fetchBisDashboard();       // ← relay replaces this
    economicPanel?.updateBis({ ...dashboard });
    this.ctx.statusPanel?.updateApi('BIS', { status: hasData ? 'ok' : 'error' });
    dataFreshness.recordUpdate('bis', count);
  } catch (e) {
    this.ctx.statusPanel?.updateApi('BIS', { status: 'error' });
  }
}

// apply* target pattern:
applyBisData(payload: unknown): void {
  if (!payload || typeof payload !== 'object') return;
  const dashboard = payload as GetBisPolicyRatesResponse;   // or your type
  const economicPanel = this.ctx.panels['economic'] as EconomicPanel;
  const data: BisData = {
    policyRates: dashboard.policyRates ?? [],
    exchangeRates: dashboard.exchangeRates ?? [],
    creditToGdp: dashboard.creditGdp ?? [],
    fetchedAt: new Date(),
  };
  economicPanel?.updateBis(data);
  const hasData = data.policyRates.length > 0;
  this.ctx.statusPanel?.updateApi('BIS', { status: hasData ? 'ok' : 'error' });
  if (hasData) dataFreshness.recordUpdate('bis', data.policyRates.length);
}
```

Relay API path for each channel (from `scripts/ais-relay.cjs`):

| Channel | Vercel API path | `load*` method to mirror |
|---|---|---|
| `news:full/tech/finance/happy` | `/api/news/v1/list-feed-digest?variant=…&lang=en` | `loadNews` → `tryFetchDigest` |
| `markets` | `/api/market/v1/get-market-dashboard` | `loadMarkets` |
| `predictions` | `/api/prediction/v1/list-prediction-markets` | `loadPredictions` |
| `fred` | `/api/economic/v1/get-fred-series` | `loadFredData` |
| `oil` | `/api/economic/v1/get-energy-prices` | `loadOilData` |
| `bis` | `/api/economic/v1/get-bis-policy-rates` | `loadBisData` |
| `intelligence` | `/api/intelligence/v1/get-global-intel-digest` | `loadIntelligence` |
| `pizzint` | `/api/intelligence/v1/get-pizzint-status` | `loadPizzInt` |
| `trade` | `/api/trade/v1/get-trade-barriers` | `loadTradePolicy` |
| `supply-chain` | `/api/supply-chain/v1/get-chokepoint-status` | `loadSupplyChain` |
| `natural` | `/api/wildfire/v1/list-fire-detections` | `loadNatural` |
| `cyber` | `/api/cyber/v1/list-cyber-threats` | `loadCyberThreats` |
| `cables` | `/api/infrastructure/v1/get-cable-health` | `loadCableHealth` |
| `flights` | `/api/aviation/v1/list-airport-delays` | `loadFlightDelays` |
| `ais` | relay pushes live vessel snapshot | `loadAisSignals` (subset) |
| `weather` | `/api/weather/v1/get-alerts` | `loadWeatherAlerts` |
| `spending` | `/api/spending/v1/get-spending-summary` | `loadSpending` |
| `giving` | `/api/giving/v1/get-giving-summary` | `loadGiving` |
| `telegram` | `/api/telegram-feed?limit=50` | `loadTelegramIntel` |

---

## Task 1 — Implement `applyNewsDigest`

Most visited channel; highest risk if broken.

**Files:**
- Modify: `src/app/data-loader.ts:2114` (`applyNewsDigest` stub)
- Test: `tests/relay-push-apply-stubs.test.mjs` (new)

**Step 1: Write the failing test**

```javascript
// tests/relay-push-apply-stubs.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('apply* stubs are implemented', () => {
  it('applyNewsDigest is not empty', () => {
    const src = readFileSync('src/app/data-loader.ts', 'utf-8');
    const match = src.match(/applyNewsDigest\(_payload[^)]*\)[^{]*\{([^}]*)\}/s);
    assert.ok(match && match[1].trim().length > 0, 'applyNewsDigest must not be empty');
  });
});
```

**Step 2: Run test to verify it fails**

```bash
node --test tests/relay-push-apply-stubs.test.mjs
```

Expected: FAIL — `applyNewsDigest must not be empty`

**Step 3: Implement**

Look at `loadNews` (line ~440 in data-loader.ts) for how it processes digest data. The relay sends the `ListFeedDigestResponse` shape directly.

```typescript
applyNewsDigest(payload: unknown): void {
  if (!payload || typeof payload !== 'object') return;
  const data = payload as import('@/server/worldmonitor/news/v1/list-feed-digest').ListFeedDigestResponse;
  this.processDigestData(data);   // extract the rendering logic from loadNews into processDigestData
}
```

Key: Extract the shared rendering into a private `processDigestData(data: ListFeedDigestResponse): void` helper that both `loadNews` (after `tryFetchDigest`) and `applyNewsDigest` call. Do not duplicate logic.

**Step 4: Run tests**

```bash
node --test tests/relay-push-apply-stubs.test.mjs
node --test tests/data-loader-phased-startup.test.mjs
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/app/data-loader.ts tests/relay-push-apply-stubs.test.mjs
git commit -m "feat: implement applyNewsDigest — wire relay news push to UI"
```

---

## Task 2 — Implement `applyMarkets`

Markets channel feeds `MarketPanel`, `HeatmapPanel`, `CommoditiesPanel`, `CryptoPanel`.

**Files:**
- Modify: `src/app/data-loader.ts` (`applyMarkets` stub ~line 2115)
- Test: `tests/relay-push-apply-stubs.test.mjs` (extend)

**Step 1: Extend the failing test**

Add to `tests/relay-push-apply-stubs.test.mjs`:
```javascript
it('applyMarkets is not empty', () => {
  const src = readFileSync('src/app/data-loader.ts', 'utf-8');
  const match = src.match(/applyMarkets\(_payload[^)]*\)[^{]*\{([^}]*)\}/s);
  assert.ok(match && match[1].trim().length > 0, 'applyMarkets must not be empty');
});
```

**Step 2: Verify it fails**

```bash
node --test tests/relay-push-apply-stubs.test.mjs
```

**Step 3: Implement**

Look at `loadMarkets` (line 786). The relay payload is the `GetMarketDashboardResponse`.

```typescript
applyMarkets(payload: unknown): void {
  if (!payload || typeof payload !== 'object') return;
  const dashboard = payload as GetMarketDashboardResponse;
  this.renderMarketDashboard(dashboard);   // extract rendering from loadMarkets
}
```

Extract a `private renderMarketDashboard(dashboard: GetMarketDashboardResponse): void` helper and call it from both `loadMarkets` and `applyMarkets`.

**Step 4: Run tests**

```bash
node --test tests/relay-push-apply-stubs.test.mjs
```

**Step 5: Commit**

```bash
git add src/app/data-loader.ts tests/relay-push-apply-stubs.test.mjs
git commit -m "feat: implement applyMarkets — wire relay market push to UI panels"
```

---

## Task 3 — Implement economic stubs: `applyBisData`, `applyFredData`, `applyOilData`

**Files:**
- Modify: `src/app/data-loader.ts`
- Test: `tests/relay-push-apply-stubs.test.mjs` (extend)

**Step 1: Add three failing tests**

```javascript
for (const name of ['applyBisData', 'applyFredData', 'applyOilData']) {
  it(`${name} is not empty`, () => {
    const src = readFileSync('src/app/data-loader.ts', 'utf-8');
    const re = new RegExp(`${name}\\(_payload[^)]*\\)[^{]*\\{([^}]*)\\}`, 's');
    const match = src.match(re);
    assert.ok(match && match[1].trim().length > 0, `${name} must not be empty`);
  });
}
```

**Step 2: Implement each**

- `applyBisData` → mirrors `loadBisData`; calls `economicPanel.updateBis(data)`. Payload type: `GetBisDashboardResponse`.
- `applyFredData` → mirrors `loadFredData`; calls panel update methods. Payload type: `GetFredSeriesResponse`.
- `applyOilData` → mirrors `loadOilData`; calls panel update methods. Payload type: `GetEnergyPricesResponse`.

Pattern: extract `private renderBisData(dashboard)`, `private renderFredData(data)`, `private renderOilData(data)` helpers; call from both `load*` and `apply*`.

**Step 3: Run tests, commit**

```bash
node --test tests/relay-push-apply-stubs.test.mjs && \
git add src/app/data-loader.ts tests/relay-push-apply-stubs.test.mjs && \
git commit -m "feat: implement applyBisData/applyFredData/applyOilData relay stubs"
```

---

## Task 4 — Implement intelligence/strategic stubs: `applyIntelligence`, `applyPizzInt`, `applyTradePolicy`, `applySupplyChain`

**Files:**
- Modify: `src/app/data-loader.ts`
- Test: `tests/relay-push-apply-stubs.test.mjs` (extend)

Same pattern: add failing tests → extract `private render*` helpers → implement `apply*` → run tests → commit.

```bash
git commit -m "feat: implement intelligence/strategic relay apply stubs"
```

---

## Task 5 — Implement operational stubs: `applyAisSignals`, `applyCableHealth`, `applyFlightDelays`, `applyWeatherAlerts`

**Files:**
- Modify: `src/app/data-loader.ts`
- Test: `tests/relay-push-apply-stubs.test.mjs` (extend)

**Note on `applyAisSignals`:** The relay broadcasts the live AIS vessel snapshot (not a Vercel API call — the relay polls AIS directly and emits `broadcastToChannel('ais', lastSnapshot)` at line 3867 of `ais-relay.cjs`). Look at what `lastSnapshot` contains and mirror `loadAisSignals` rendering logic.

```bash
git commit -m "feat: implement operational relay apply stubs (ais/cables/flights/weather)"
```

---

## Task 6 — Implement remaining stubs: `applyNatural`, `applyCyberThreats`, `applyPredictions`, `applySpending`, `applyGiving`, `applyTelegramIntel`

**Files:**
- Modify: `src/app/data-loader.ts`
- Test: `tests/relay-push-apply-stubs.test.mjs` (extend)

```bash
git commit -m "feat: implement remaining relay apply stubs (natural/cyber/predictions/spending/giving/telegram)"
```

---

## Task 7 — Add `applyPush` to `StrategicRiskPanel` and `StrategicPosturePanel`

App.ts already subscribes to `strategic-risk` and `strategic-posture` channels and calls `panel.applyPush(payload)`. Neither panel implements this method — the subscriptions silently no-op.

**Files:**
- Modify: `src/components/StrategicRiskPanel.ts`
- Modify: `src/components/StrategicPosturePanel.ts`
- Test: `tests/relay-push-apply-stubs.test.mjs` (extend)

**Step 1: Add failing tests**

```javascript
it('StrategicRiskPanel has applyPush', () => {
  const src = readFileSync('src/components/StrategicRiskPanel.ts', 'utf-8');
  assert.ok(src.includes('applyPush'), 'StrategicRiskPanel must implement applyPush');
});
it('StrategicPosturePanel has applyPush', () => {
  const src = readFileSync('src/components/StrategicPosturePanel.ts', 'utf-8');
  assert.ok(src.includes('applyPush'), 'StrategicPosturePanel must implement applyPush');
});
```

**Step 2: Run to verify fail**

```bash
node --test tests/relay-push-apply-stubs.test.mjs
```

**Step 3: Implement**

Look at how `StablecoinPanel.ts`, `ETFFlowsPanel.ts`, and `ServiceStatusPanel.ts` implement `applyPush` for reference patterns.

For `StrategicRiskPanel`: the relay broadcasts `/api/intelligence/v1/get-risk-scores`. Look at what `loadIntelligenceSignals` / `renderStrategicRisk` does with the data from that endpoint.

For `StrategicPosturePanel`: the relay broadcasts `/api/military/v1/get-theater-posture`. Look at the existing `setData` or `render` method on the panel and call it with the typed payload.

**Step 4: Run tests, commit**

```bash
node --test tests/relay-push-apply-stubs.test.mjs && \
node --test tests/relay-push-wiring.test.mjs && \
git add src/components/StrategicRiskPanel.ts src/components/StrategicPosturePanel.ts tests/relay-push-apply-stubs.test.mjs && \
git commit -m "feat: add applyPush to StrategicRiskPanel and StrategicPosturePanel"
```

---

## Task 8 — Verify deployment env vars

No code changes — this is a config verification task. Failing to do this means relay pushes don't reach the relay server.

**Step 1: Verify `VITE_WS_RELAY_URL` in Vercel**

```bash
# Check current Vercel env vars:
npx vercel env ls
```

Expected: `VITE_WS_RELAY_URL` should be present and set to `wss://relay.5ls.us`.

If missing, add it:
```bash
npx vercel env add VITE_WS_RELAY_URL production
# Enter: wss://relay.5ls.us
```

`VITE_WS_RELAY_URL` is a build-time env var (consumed by Vite). Vercel must have it set so it bakes into the bundle.

**Step 2: Verify `VERCEL_APP_URL` on Railway**

The relay uses `VERCEL_APP_URL` to know where to warm API endpoints (default: `https://worldmonitor.app`).

SSH into Railway or use Railway CLI:
```bash
railway variables | grep VERCEL_APP_URL
```

If missing or wrong, set it to the correct production URL.

**Step 3: Verify `RELAY_SHARED_SECRET` matches across environments**

- Relay (Railway): `RELAY_SHARED_SECRET=<secret>`
- Vercel: `RELAY_SHARED_SECRET=<same secret>`

Both must match. The relay sends `X-WorldMonitor-Key: <RELAY_SHARED_SECRET>` when calling Vercel warming APIs, and Vercel uses the same value to authenticate relay warmers.

**Step 4: Commit verification doc**

```bash
# Write findings to docs/ops/env-var-audit-2026-03-05.md
# Then commit
git add docs/ops/env-var-audit-2026-03-05.md
git commit -m "docs: env var audit for relay-push deployment"
```

---

## Task 9 — Wire extra relay channels to App.ts (low priority)

The relay schedules and broadcasts on these channels but `App.ts` does not subscribe to them. Data is being pushed but no client is listening.

| Channel | Relay path | Purpose |
|---|---|---|
| `gulf-quotes` | `/api/market/v1/list-gulf-quotes` | Gulf market prices |
| `tech-events` | `/api/research/v1/list-tech-events` | Tech industry events |
| `oref` | `/api/oref-alerts` | Israeli OREF alerts |
| `iran-events` | `/api/conflict/v1/list-iran-events` | Iran conflict events |
| `gps-interference` | `/api/gpsjam` | GPS jamming data |
| `eonet` | `/api/natural-events/v1/list-events` | NASA EONET events |
| `gdacs` | `/api/natural-events/v1/list-disasters` | GDACS disaster alerts |
| `config:news-sources` | `/api/config/news-sources?variant=full` | Feature config |
| `config:feature-flags` | `/api/config/feature-flags` | Feature flags |

**Files:**
- Modify: `src/App.ts` (`setupRelayPush` channel list + subscriptions)
- Modify: `src/app/data-loader.ts` (new apply* stubs for each)
- Test: extend `tests/relay-push-apply-stubs.test.mjs`

For each channel:
1. Add it to the `channels` array in `setupRelayPush()`
2. Add `subscribeRelayPush('<channel>', (p) => { void dl.applyXxx(p); })` 
3. Add `applyXxx(payload: unknown): void { ... }` implementing the rendering
4. Test and commit per channel group (don't batch all 9 in one commit)

```bash
git commit -m "feat: subscribe App.ts to extra relay channels (gulf-quotes, oref, iran-events, etc.)"
```

---

## Task 10 — End-to-end relay push integration test

After Tasks 1-7 are complete, add a test that simulates a relay push event and verifies the UI updates correctly.

**Files:**
- Create: `tests/relay-push-integration.test.mjs`
- Test: data arrives via mocked relay push → apply* method calls render method → verify side-effect

```javascript
// tests/relay-push-integration.test.mjs
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

// Verify apply* methods are not empty stubs by checking they call ctx methods.
// This is a contract test, not a render test — we verify the method body is non-trivial.
describe('relay push integration contracts', () => {
  it('all apply* methods are non-empty', () => {
    const src = readFileSync('src/app/data-loader.ts', 'utf-8');
    const applyMethods = [
      'applyNewsDigest', 'applyMarkets', 'applyPredictions', 'applyFredData',
      'applyOilData', 'applyBisData', 'applyIntelligence', 'applyPizzInt',
      'applyTradePolicy', 'applySupplyChain', 'applyNatural', 'applyCyberThreats',
      'applyCableHealth', 'applyFlightDelays', 'applyAisSignals', 'applyWeatherAlerts',
      'applySpending', 'applyGiving', 'applyTelegramIntel',
    ];
    for (const name of applyMethods) {
      const re = new RegExp(`${name}\\([^)]*\\)[^{]*\\{([^}]*)\\}`, 's');
      const match = src.match(re);
      assert.ok(match && match[1].trim().length > 0, `${name} must not be empty stub`);
    }
  });
});
```

```bash
node --test tests/relay-push-integration.test.mjs && \
git add tests/relay-push-integration.test.mjs && \
git commit -m "test: add relay push integration contract test"
```

---

## Execution Checklist

Run before calling this complete:

```bash
npm run build           # must be 0 TypeScript errors
node --test tests/relay-push-apply-stubs.test.mjs
node --test tests/relay-push-integration.test.mjs
node --test tests/relay-push-wiring.test.mjs
node --test tests/data-loader-phased-startup.test.mjs
npm run test:data       # all 562+ tests pass
```
