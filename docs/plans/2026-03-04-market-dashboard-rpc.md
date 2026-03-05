# GetMarketDashboard RPC Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Consolidate 4 sequential market RPCs into a single `GetMarketDashboard` call that fetches all symbol config from Supabase once and fans out to upstream APIs in parallel.

**Architecture:** New proto message → generated client/server → single handler that calls `getAllMarketSymbols()` once, then `Promise.allSettled` for Finnhub/Yahoo/CoinGecko in parallel → unified Redis cache → client calls one RPC and distributes to panels.

**Tech Stack:** Protobuf (sebuf), TypeScript, Vercel Edge Functions, Redis (Upstash), Supabase

---

### Task 1: Proto Definition

**Files:**
- Create: `proto/worldmonitor/market/v1/get_market_dashboard.proto`
- Modify: `proto/worldmonitor/market/v1/service.proto`

**Step 1: Create the proto message file**

Create `proto/worldmonitor/market/v1/get_market_dashboard.proto`:

```protobuf
syntax = "proto3";

package worldmonitor.market.v1;

import "sebuf/http/annotations.proto";
import "worldmonitor/market/v1/market_quote.proto";

// GetMarketDashboardRequest requires no parameters — symbols come from DB config.
message GetMarketDashboardRequest {}

// GetMarketDashboardResponse contains all core market data in one response.
message GetMarketDashboardResponse {
  // Stock and index quotes (DB-configured, Finnhub + Yahoo).
  repeated MarketQuote stocks = 1;
  // Commodity futures quotes (DB-configured, Yahoo).
  repeated CommodityQuote commodities = 2;
  // Sector ETF performance (DB-configured, Finnhub/Yahoo).
  repeated SectorPerformance sectors = 3;
  // Cryptocurrency quotes (DB-configured, CoinGecko).
  repeated CryptoQuote crypto = 4;
  // True when Finnhub API key is not configured.
  bool finnhub_skipped = 5;
  // Reason when Finnhub was skipped.
  string skip_reason = 6;
  // True when upstream APIs rate-limited the request.
  bool rate_limited = 7;
}
```

**Step 2: Add the RPC to the service definition**

In `proto/worldmonitor/market/v1/service.proto`, add the import and RPC:

Add import after the existing imports (line 13):
```protobuf
import "worldmonitor/market/v1/get_market_dashboard.proto";
```

Add the RPC inside the `MarketService` block (before the closing brace):
```protobuf
  // GetMarketDashboard returns all core market data (stocks, commodities, sectors, crypto)
  // in a single response. Symbols are DB-configured via get_market_symbols().
  rpc GetMarketDashboard(GetMarketDashboardRequest) returns (GetMarketDashboardResponse) {
    option (sebuf.http.config) = {path: "/get-market-dashboard", method: HTTP_METHOD_GET};
  }
```

**Step 3: Lint the proto**

Run: `cd proto && buf lint`
Expected: No errors

**Step 4: Commit**

```bash
git add proto/worldmonitor/market/v1/get_market_dashboard.proto proto/worldmonitor/market/v1/service.proto
git commit -m "feat(proto): add GetMarketDashboard RPC definition"
```

---

### Task 2: Code Generation

**Files:**
- Regenerated: `src/generated/client/worldmonitor/market/v1/service_client.ts`
- Regenerated: `src/generated/server/worldmonitor/market/v1/service_server.ts`
- Regenerated: `docs/api/MarketService.openapi.yaml`
- Regenerated: `docs/api/MarketService.openapi.json`

**Step 1: Generate code from proto**

Run: `make generate`
Expected: "Code generation complete!" — no errors

**Step 2: Verify the generated client has the new method**

Run: `grep -n 'getMarketDashboard' src/generated/client/worldmonitor/market/v1/service_client.ts`
Expected: A line like `async getMarketDashboard(req: GetMarketDashboardRequest, ...`

**Step 3: Verify the generated server has the new handler interface**

Run: `grep -n 'getMarketDashboard' src/generated/server/worldmonitor/market/v1/service_server.ts`
Expected: A line like `getMarketDashboard(ctx: ServerContext, req: GetMarketDashboardRequest): Promise<GetMarketDashboardResponse>;`

**Step 4: Commit**

```bash
git add src/generated/ docs/api/
git commit -m "chore: regenerate client/server from proto (GetMarketDashboard)"
```

---

### Task 3: Server Handler — GetMarketDashboard

**Files:**
- Create: `server/worldmonitor/market/v1/get-market-dashboard.ts`

**Context:** This is the core handler. It replaces the work of 4 separate handlers. Key imports and patterns to follow:
- `server/_shared/market-symbols.ts` — `getAllMarketSymbols()` returns `{ stock, commodity, sector, crypto }` with `SymbolEntry[]` per category
- `server/_shared/secrets.ts` — `getSecret('FINNHUB_API_KEY')` for Finnhub auth
- `server/_shared/redis.ts` — `cachedFetchJson(key, ttl, fetchFn)` for Redis caching
- `server/worldmonitor/market/v1/_shared.ts` — `fetchFinnhubQuote()`, `fetchYahooQuotesBatch()`, `fetchCoinGeckoMarkets()`, `isYahooOnlySymbol()`
- Types are imported from `src/generated/server/worldmonitor/market/v1/service_server`

**Step 1: Create the handler**

Create `server/worldmonitor/market/v1/get-market-dashboard.ts`:

```typescript
import type {
  ServerContext,
  GetMarketDashboardRequest,
  GetMarketDashboardResponse,
  MarketQuote,
  CommodityQuote,
  SectorPerformance,
  CryptoQuote,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { getAllMarketSymbols, type SymbolEntry } from '../../../_shared/market-symbols';
import { getSecret } from '../../../_shared/secrets';
import {
  isYahooOnlySymbol,
  fetchFinnhubQuote,
  fetchYahooQuotesBatch,
  fetchCoinGeckoMarkets,
  CRYPTO_META,
} from './_shared';
import { cachedFetchJson } from '../../../_shared/redis';

const REDIS_KEY = 'market:dashboard:v1';
const REDIS_TTL = 480;

const dashboardCache = new Map<string, { data: GetMarketDashboardResponse; ts: number }>();
const CACHE_TTL_MS = 480_000;

function buildMetaMap(entries: SymbolEntry[]): Map<string, SymbolEntry> {
  return new Map(entries.map((e) => [e.symbol, e]));
}

export async function getMarketDashboard(
  _ctx: ServerContext,
  _req: GetMarketDashboardRequest,
): Promise<GetMarketDashboardResponse> {
  const memCached = dashboardCache.get(REDIS_KEY);
  if (memCached && Date.now() - memCached.ts < CACHE_TTL_MS) {
    return memCached.data;
  }

  try {
    const result = await cachedFetchJson<GetMarketDashboardResponse>(REDIS_KEY, REDIS_TTL, async () => {
      const config = await getAllMarketSymbols();
      if (!config) {
        return {
          stocks: [], commodities: [], sectors: [], crypto: [],
          finnhubSkipped: true, skipReason: 'Symbol config unavailable', rateLimited: false,
        };
      }

      const stockSymbols = config.stock.map((s) => s.symbol);
      const commoditySymbols = config.commodity.map((s) => s.symbol);
      const sectorSymbols = config.sector.map((s) => s.symbol);
      const cryptoIds = config.crypto.map((s) => s.symbol);

      const stockMeta = buildMetaMap(config.stock);
      const commodityMeta = buildMetaMap(config.commodity);
      const sectorMeta = buildMetaMap(config.sector);

      const apiKey = await getSecret('FINNHUB_API_KEY');

      const finnhubSymbols = stockSymbols.filter((s) => !isYahooOnlySymbol(s));
      const allYahooSymbols = [
        ...stockSymbols.filter((s) => isYahooOnlySymbol(s)),
        ...commoditySymbols,
        ...sectorSymbols,
      ];

      const [finnhubResults, yahooResults, cryptoResults] = await Promise.allSettled([
        apiKey
          ? Promise.all(finnhubSymbols.map((s) => fetchFinnhubQuote(s, apiKey).then((r) => r ? { symbol: s, ...r } : null)))
          : Promise.resolve([]),
        allYahooSymbols.length > 0 ? fetchYahooQuotesBatch(allYahooSymbols) : Promise.resolve({ results: new Map(), rateLimited: false }),
        cryptoIds.length > 0 ? fetchCoinGeckoMarkets(cryptoIds) : Promise.resolve([]),
      ]);

      const finnhubData = finnhubResults.status === 'fulfilled' ? finnhubResults.value : [];
      const yahooData = yahooResults.status === 'fulfilled' ? yahooResults.value : { results: new Map<string, { price: number; change: number; sparkline: number[] }>(), rateLimited: false };
      const cryptoData = cryptoResults.status === 'fulfilled' ? cryptoResults.value : [];

      const stocks: MarketQuote[] = [];
      const finnhubHits = new Set<string>();

      for (const r of finnhubData) {
        if (r) {
          finnhubHits.add(r.symbol);
          const meta = stockMeta.get(r.symbol);
          stocks.push({
            symbol: r.symbol,
            name: meta?.name ?? r.symbol,
            display: meta?.display ?? r.symbol,
            price: r.price,
            change: r.changePercent,
            sparkline: [],
          });
        }
      }

      const missedFinnhub = apiKey
        ? finnhubSymbols.filter((s) => !finnhubHits.has(s))
        : finnhubSymbols;

      for (const s of [...stockSymbols.filter((sym) => isYahooOnlySymbol(sym)), ...missedFinnhub]) {
        if (finnhubHits.has(s)) continue;
        const yahoo = yahooData.results.get(s);
        if (yahoo) {
          const meta = stockMeta.get(s);
          stocks.push({
            symbol: s,
            name: meta?.name ?? s,
            display: meta?.display ?? s,
            price: yahoo.price,
            change: yahoo.change,
            sparkline: yahoo.sparkline,
          });
        }
      }

      const stockOrder = new Map(stockSymbols.map((s, i) => [s, i]));
      stocks.sort((a, b) => (stockOrder.get(a.symbol) ?? 999) - (stockOrder.get(b.symbol) ?? 999));

      const commodities: CommodityQuote[] = [];
      for (const s of commoditySymbols) {
        const yahoo = yahooData.results.get(s);
        if (yahoo) {
          const meta = commodityMeta.get(s);
          commodities.push({
            symbol: s,
            name: meta?.name ?? s,
            display: meta?.display ?? s,
            price: yahoo.price,
            change: yahoo.change,
            sparkline: yahoo.sparkline,
          });
        }
      }

      const sectors: SectorPerformance[] = [];
      for (const s of sectorSymbols) {
        const yahoo = yahooData.results.get(s);
        if (yahoo) {
          const meta = sectorMeta.get(s);
          sectors.push({
            symbol: s,
            name: meta?.name ?? s,
            change: yahoo.change,
          });
        }
      }

      const crypto: CryptoQuote[] = cryptoData.map((coin) => {
        const configEntry = config.crypto.find((c) => c.symbol === coin.id);
        const meta = CRYPTO_META[coin.id];
        return {
          name: configEntry?.name ?? meta?.name ?? coin.id,
          symbol: configEntry?.display ?? meta?.symbol ?? coin.id.toUpperCase(),
          price: coin.current_price,
          change: coin.price_change_percentage_24h,
          sparkline: coin.sparkline_in_7d?.price ?? [],
        };
      });

      const hasData = stocks.length > 0 || commodities.length > 0 || sectors.length > 0 || crypto.length > 0;
      if (!hasData) return null;

      const coveredByYahoo = finnhubSymbols.every((s) => stocks.some((q) => q.symbol === s));
      const skipped = !apiKey && !coveredByYahoo;

      return {
        stocks,
        commodities,
        sectors,
        crypto,
        finnhubSkipped: skipped,
        skipReason: skipped ? 'FINNHUB_API_KEY not configured' : '',
        rateLimited: yahooData.rateLimited,
      };
    });

    if (result) {
      dashboardCache.set(REDIS_KEY, { data: result, ts: Date.now() });
    }

    return result ?? memCached?.data ?? {
      stocks: [], commodities: [], sectors: [], crypto: [],
      finnhubSkipped: false, skipReason: '', rateLimited: false,
    };
  } catch {
    return memCached?.data ?? {
      stocks: [], commodities: [], sectors: [], crypto: [],
      finnhubSkipped: false, skipReason: '', rateLimited: false,
    };
  }
}
```

**Step 2: Commit**

```bash
git add server/worldmonitor/market/v1/get-market-dashboard.ts
git commit -m "feat(server): add GetMarketDashboard handler with parallel upstream fetching"
```

---

### Task 4: Register Handler

**Files:**
- Modify: `server/worldmonitor/market/v1/handler.ts`

**Step 1: Add import and registration**

Add import alongside the existing imports:
```typescript
import { getMarketDashboard } from './get-market-dashboard';
```

Add to the `marketHandler` object:
```typescript
getMarketDashboard,
```

**Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit --skipLibCheck 2>&1 | head -20`
Expected: No errors related to `getMarketDashboard` or `handler.ts`

**Step 3: Commit**

```bash
git add server/worldmonitor/market/v1/handler.ts
git commit -m "feat(server): register GetMarketDashboard in market handler"
```

---

### Task 5: Client Service — fetchMarketDashboard

**Files:**
- Modify: `src/services/market/index.ts`

**Context:** The existing file already has `MarketServiceClient`, circuit breakers, and fetch functions for stocks, commodities, and crypto. Add a unified `fetchMarketDashboard()` that replaces all of them for the dashboard use case.

**Step 1: Add imports, breaker, fallback, and function**

Add `GetMarketDashboardResponse` to the import from the generated client:
```typescript
import {
  MarketServiceClient,
  type ListMarketQuotesResponse,
  type ListCryptoQuotesResponse,
  type ListCommodityQuotesResponse,
  type GetMarketDashboardResponse,  // ADD THIS
  // ... existing type imports
} from '@/generated/client/worldmonitor/market/v1/service_client';
```

Add the circuit breaker, fallback, and function after the existing exports:
```typescript
const dashboardBreaker = createCircuitBreaker<GetMarketDashboardResponse>({
  name: 'Market Dashboard',
  cacheTtlMs: 0,
});

const emptyDashboardFallback: GetMarketDashboardResponse = {
  stocks: [],
  commodities: [],
  sectors: [],
  crypto: [],
  finnhubSkipped: false,
  skipReason: '',
  rateLimited: false,
};

let lastSuccessfulDashboard: GetMarketDashboardResponse | null = null;

export async function fetchMarketDashboard(): Promise<GetMarketDashboardResponse> {
  const resp = await dashboardBreaker.execute(
    () => client.getMarketDashboard({}),
    emptyDashboardFallback,
  );

  const hasData =
    resp.stocks.length > 0 ||
    resp.commodities.length > 0 ||
    resp.sectors.length > 0 ||
    resp.crypto.length > 0;

  if (hasData) {
    lastSuccessfulDashboard = resp;
    return resp;
  }

  return lastSuccessfulDashboard ?? resp;
}
```

**Step 2: Commit**

```bash
git add src/services/market/index.ts
git commit -m "feat(client): add fetchMarketDashboard service function"
```

---

### Task 6: Update Data Loader

**Files:**
- Modify: `src/app/data-loader.ts`

**Context:** The `loadMarkets()` method currently makes 4 sequential calls. Replace the entire body with a single `fetchMarketDashboard()` call.

**Step 1: Add import**

In the imports from `@/services`, add `fetchMarketDashboard`:
```typescript
import {
  fetchCategoryFeeds,
  getFeedFailures,
  fetchMultipleStocks,
  fetchCommodityQuotes,
  fetchCrypto,
  fetchMarketDashboard,  // ADD THIS
  // ... rest of imports
} from '@/services';
```

**Step 2: Replace loadMarkets body**

Replace the entire `async loadMarkets(): Promise<void>` method body with:

```typescript
async loadMarkets(): Promise<void> {
  try {
    const dashboard = await fetchMarketDashboard();

    // Stocks panel
    const stockData = dashboard.stocks.map((q) => ({
      display: q.display || q.symbol,
      price: q.price,
      change: q.change,
      sparkline: q.sparkline.length > 0 ? q.sparkline : undefined,
    }));
    this.ctx.latestMarkets = stockData;
    (this.ctx.panels['markets'] as MarketPanel).renderMarkets(
      stockData,
      dashboard.rateLimited,
    );

    if (dashboard.finnhubSkipped) {
      this.ctx.statusPanel?.updateApi('Finnhub', { status: 'error' });
    } else {
      this.ctx.statusPanel?.updateApi('Finnhub', { status: stockData.length > 0 ? 'ok' : 'error' });
    }

    // Sector heatmap
    const hydratedSectors = getHydratedData('sectors') as GetSectorSummaryResponse | undefined;
    if (hydratedSectors?.sectors?.length) {
      (this.ctx.panels['heatmap'] as HeatmapPanel).renderHeatmap(
        hydratedSectors.sectors.map((s) => ({ name: s.name, change: s.change })),
      );
    } else if (dashboard.sectors.length > 0) {
      (this.ctx.panels['heatmap'] as HeatmapPanel).renderHeatmap(
        dashboard.sectors.map((s) => ({ name: s.name, change: s.change })),
      );
    }

    // Commodities panel
    const commoditiesPanel = this.ctx.panels['commodities'] as CommoditiesPanel;
    const commodityData = dashboard.commodities.map((q) => ({
      display: q.display || q.symbol,
      price: q.price != null ? q.price : null,
      change: q.change ?? null,
      sparkline: q.sparkline.length > 0 ? q.sparkline : undefined,
    }));
    if (commodityData.length > 0 && commodityData.some((d) => d.price !== null)) {
      commoditiesPanel.renderCommodities(commodityData);
    } else {
      commoditiesPanel.renderCommodities([]);
    }
  } catch {
    this.ctx.statusPanel?.updateApi('Finnhub', { status: 'error' });
  }

  try {
    // Crypto panel — also from dashboard
    const dashboard = await fetchMarketDashboard();
    const cryptoData = dashboard.crypto.map((q) => ({
      name: q.name,
      symbol: q.symbol,
      price: q.price,
      change: q.change,
      sparkline: q.sparkline,
    }));
    (this.ctx.panels['crypto'] as CryptoPanel).renderCrypto(cryptoData);
    this.ctx.statusPanel?.updateApi('CoinGecko', { status: cryptoData.length > 0 ? 'ok' : 'error' });
  } catch {
    this.ctx.statusPanel?.updateApi('CoinGecko', { status: 'error' });
  }
}
```

Note: The second `fetchMarketDashboard()` call will hit the circuit breaker's cache — no additional network request. But a cleaner approach is to store the dashboard result in a local variable outside the try blocks. Use your judgment — the key requirement is that crypto rendering failure should not prevent stocks/commodities from displaying.

**Step 3: Remove unused imports**

If `COMMODITIES` was imported from `@/config`, remove it. If `fetchCommodityQuotes` and `fetchCrypto` are no longer used elsewhere, remove those imports too.

Check: `grep -n 'COMMODITIES\|fetchCommodityQuotes\|fetchCrypto' src/app/data-loader.ts` — ensure none remain outside the import block and that any remaining uses are covered by the new code.

**Step 4: Commit**

```bash
git add src/app/data-loader.ts
git commit -m "feat(client): replace sequential market calls with single fetchMarketDashboard"
```

---

### Task 7: Smoke Test

**Step 1: Start dev server**

```bash
cd /Users/jolipton/Projects/worldmonitor/.worktrees/configurable-market-symbols
npx vercel dev --yes
```

Wait for "Ready! Available at http://localhost:3000"

**Step 2: Test the new endpoint directly**

```bash
curl -s \
  -H "Origin: http://localhost:3000" \
  -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" \
  "http://localhost:3000/api/market/v1/get-market-dashboard" | python3 -m json.tool | head -50
```

Expected: JSON with `stocks`, `commodities`, `sectors`, `crypto` arrays populated.

**Step 3: Test in browser**

Open `http://localhost:3000` in a browser. Verify:
- MARKETS panel shows stocks with CSCO near the top (DB sort_order)
- COMMODITIES panel shows VIX, GOLD, OIL, NATGAS, SILVER, COPPER
- Sector heatmap renders
- Crypto panel shows BTC, ETH, SOL, XRP

**Step 4: Verify old endpoints still work (backward compatibility)**

```bash
curl -s \
  -H "Origin: http://localhost:3000" \
  -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" \
  "http://localhost:3000/api/market/v1/list-market-quotes?symbols=AAPL" | python3 -m json.tool | head -10
```

Expected: Still returns data (old RPCs remain functional).

**Step 5: Commit**

No code changes in this task — this is verification only. If smoke test reveals issues, fix them before proceeding.

---

### Task 8: Clean Up Unused Code

**Files:**
- Modify: `src/services/market/index.ts` — remove `fetchCommodityQuotes` if no longer imported elsewhere
- Modify: `src/app/data-loader.ts` — remove stale imports
- Verify: `src/services/index.ts` — barrel exports still work

**Step 1: Check for remaining references to removed functions**

```bash
grep -rn 'fetchCommodityQuotes\|fetchMultipleStocks.*COMMODITIES' src/ --include='*.ts' | grep -v 'node_modules'
```

Remove any dead imports or references.

**Step 2: Run TypeScript check**

```bash
npx tsc --noEmit --skipLibCheck 2>&1 | head -30
```

Expected: No errors

**Step 3: Final commit**

```bash
git add -A
git commit -m "chore: clean up unused market service code after dashboard consolidation"
```
