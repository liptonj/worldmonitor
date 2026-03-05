# GetMarketDashboard RPC — Design

**Date:** 2026-03-04
**Status:** Approved

## Problem

The `loadMarkets()` function makes 4 sequential RPC calls, each independently calling `getConfiguredSymbols()` which hits Supabase/Redis:

1. `listMarketQuotes` → `getConfiguredSymbols('stock')` → Finnhub + Yahoo
2. `getSectorSummary` (via `fetchMultipleStocks(SECTORS)`) → Yahoo
3. `listCommodityQuotes` → `getConfiguredSymbols('commodity')` → Yahoo
4. `listCryptoQuotes` → CoinGecko

Each Vercel Edge Function invocation is a cold start, so in-memory caches don't persist. This produces:

- **4 browser → server round trips** (sequential, not parallel)
- **4 server → Supabase/Redis calls** for the same symbol config
- **3 competing Yahoo Finance queues** through `yahooGate` (600ms per symbol)
- **~30s+ worst-case latency** from sequential waterfall plus retry delays

## Solution

Consolidate into a single `GetMarketDashboard` RPC that:

1. Calls `get_market_symbols()` **once** → gets all categories
2. Fans out to upstream APIs **in parallel** (Finnhub, Yahoo, CoinGecko)
3. Batches all Yahoo symbols into **one unified queue**
4. Returns stocks, commodities, sectors, and crypto in **one response**

## Scope

### Consolidated (into GetMarketDashboard)

| Current RPC | Upstream API | Why consolidate |
|---|---|---|
| `ListMarketQuotes` | Finnhub + Yahoo | Sequential bottleneck, DB call |
| `ListCommodityQuotes` | Yahoo | Sequential bottleneck, DB call |
| `GetSectorSummary` | Finnhub/Yahoo | Sequential bottleneck, DB call |
| `ListCryptoQuotes` | CoinGecko | Sequential bottleneck, DB call |

### Unchanged (stay as separate RPCs)

| RPC | Reason |
|---|---|
| `GetCountryStockIndex` | On-demand, requires `country_code` parameter |
| `ListStablecoinMarkets` | Independent panel, variant-specific |
| `ListEtfFlows` | Independent panel, variant-specific |
| `ListGulfQuotes` | Independent panel, variant-specific |

## Proto Definition

```protobuf
// get_market_dashboard.proto

message GetMarketDashboardRequest {}

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

No request parameters — the server uses DB-configured symbols for all categories.

## Server Handler Flow

```
GetMarketDashboard handler:

  1. getAllMarketSymbols()
     └── ONE Supabase RPC: get_market_symbols()
     └── Returns: { stock[], commodity[], sector[], crypto[] }

  2. Fan out in parallel (Promise.allSettled):
     ├── Finnhub: Promise.all(stockSymbols.map(fetchFinnhubQuote))
     ├── Yahoo:   fetchYahooQuotesBatch([...indices, ...commodities, ...sectors, ...missedStocks])
     └── CoinGecko: fetchCoinGeckoMarkets(cryptoIds)

  3. Assemble response:
     ├── Apply DB metadata (name, display) from metaMap
     ├── Sort by DB sort_order per category
     └── Set status flags (finnhub_skipped, rate_limited)

  4. Cache in Redis:
     └── Key: market:dashboard:v1
     └── TTL: 480s (8 min)
     └── In-memory fallback for same-instance calls
```

All Yahoo symbols (indices, commodities, sectors, missed Finnhub) go through one `fetchYahooQuotesBatch` call — no competing `yahooGate` queues.

## Client Changes

### Before (data-loader.ts — sequential waterfall)

```typescript
const stocksResult = await fetchMultipleStocks(MARKET_SYMBOLS, { onBatch });
const sectorsResult = await fetchMultipleStocks(SECTORS, { onBatch });
// Up to 3 retries × 20s delay for commodities
const commodities = await fetchCommodityQuotes();
// Retry + 20s delay for crypto
const crypto = await fetchCrypto();
```

### After (data-loader.ts — single call)

```typescript
const dashboard = await fetchMarketDashboard();

marketsPanel.renderMarkets(dashboard.stocks);
commoditiesPanel.renderCommodities(dashboard.commodities);
heatmapPanel.renderHeatmap(dashboard.sectors);
cryptoPanel.renderCrypto(dashboard.crypto);
```

### Client service (src/services/market/index.ts)

```typescript
export async function fetchMarketDashboard(): Promise<MarketDashboard> {
  const resp = await dashboardBreaker.execute(
    () => client.getMarketDashboard({}),
    emptyDashboardFallback,
  );
  return resp;
}
```

## Caching Strategy

| Layer | Key | TTL | Purpose |
|---|---|---|---|
| Redis | `market:dashboard:v1` | 480s (8 min) | Cross-instance shared cache |
| In-memory | `dashboardCache` Map | 480s | Same-instance repeated calls |
| Fallback | `lastSuccessfulDashboard` | None (stale) | Serve stale on total failure |

## Error Handling

- Each upstream fetch runs inside `Promise.allSettled` — partial failures don't block the response
- If Finnhub fails → stocks still populated via Yahoo fallback
- If Yahoo fails → stocks from Finnhub, commodities/sectors empty
- If CoinGecko fails → crypto empty, rest unaffected
- If Supabase fails → use in-memory fallback config; if none, return empty
- `rate_limited` flag set when Yahoo returns 429 for majority of symbols

## Performance Comparison

| Metric | Before | After |
|---|---|---|
| Browser → server requests | 4 sequential | 1 |
| Server → Supabase DB calls | 4 | 1 |
| Yahoo `yahooGate` queues | 3 competing | 1 unified |
| Redis lookups | 4 keys | 1 key |
| Retry logic overhead | 3 retries × 20s per section | 1 retry at dashboard level |
| Worst-case latency | ~30s+ | ~5-10s |

## Migration

- The 4 individual RPCs (`ListMarketQuotes`, `ListCommodityQuotes`, `GetSectorSummary`, `ListCryptoQuotes`) remain in the proto for backward compatibility
- `loadMarkets()` switches to `fetchMarketDashboard()`
- Individual RPCs can be deprecated and removed in a future cleanup
