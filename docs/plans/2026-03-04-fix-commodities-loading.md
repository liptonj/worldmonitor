# Fix Commodities Panel Loading Failures — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate the persistent "Failed to load commodities" error by fixing the Yahoo Finance fetch pipeline, adding bootstrap hydration, and implementing graceful degradation.

**Architecture:** The commodities panel currently depends on a single `GetMarketDashboard` RPC that fetches all market data (stocks, commodities, sectors, crypto) in one call. Yahoo Finance is the sole data source for commodities, fetched **sequentially** with a 600ms rate gate between requests. This creates a ~9-second minimum fetch time for ~15 symbols, compounded by aggressive circuit breakers that lock out for 5 minutes after 2 failures. The fix has three layers: (1) make Yahoo fetching concurrent and faster, (2) add commodities to the bootstrap hydration pipeline so stale data displays instantly, and (3) show last-known data with a stale indicator instead of an error message.

**Tech Stack:** TypeScript, Vercel Edge Functions, Upstash Redis, Vite

---

### Task 1: Concurrent Yahoo Finance batch fetching

**Files:**
- Modify: `server/worldmonitor/market/v1/_shared.ts` (lines 12–30, function `fetchYahooQuotesBatch`)
- Modify: `server/_shared/constants.ts` (line 9, `YAHOO_MIN_GAP_MS`)

**Step 1: Reduce Yahoo rate gate from 600ms to 200ms**

In `server/_shared/constants.ts`, change:

```typescript
const YAHOO_MIN_GAP_MS = 200;
```

Yahoo rate-limits at roughly 2000 req/min on the charting endpoint. 200ms = 5 req/s = 300 req/min, well within limits. The previous 600ms was overly conservative.

**Step 2: Replace sequential batch with concurrent fetch (concurrency limit 3)**

In `server/worldmonitor/market/v1/_shared.ts`, replace `fetchYahooQuotesBatch`:

```typescript
export async function fetchYahooQuotesBatch(
  symbols: string[],
): Promise<{ results: Map<string, { price: number; change: number; sparkline: number[] }>; rateLimited: boolean }> {
  const results = new Map<string, { price: number; change: number; sparkline: number[] }>();
  if (symbols.length === 0) return { results, rateLimited: false };

  const CONCURRENCY = 3;
  let failures = 0;

  for (let i = 0; i < symbols.length; i += CONCURRENCY) {
    const chunk = symbols.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      chunk.map(async (s) => {
        const q = await fetchYahooQuote(s);
        return { symbol: s, quote: q };
      }),
    );
    for (const r of settled) {
      if (r.status === 'fulfilled' && r.value.quote) {
        results.set(r.value.symbol, r.value.quote);
      } else {
        failures++;
        const sym = r.status === 'fulfilled' ? r.value.symbol : 'unknown';
        console.warn(`[Yahoo] Failed to fetch ${sym}`);
      }
    }
  }

  return { results, rateLimited: failures > symbols.length / 2 };
}
```

Key changes:
- Fetches 3 symbols concurrently per chunk (each still goes through `yahooGate`, so requests are staggered at ~200ms apart but overlapping network I/O)
- Removes `consecutiveFails >= 5` early exit — all symbols get attempted
- Adds per-symbol failure logging
- Total time for 6 commodity symbols: ~400ms (2 chunks × 200ms gate) + network latency, down from ~3.6s

**Step 3: Verify the change locally**

Run: `npx vite build` to check for TypeScript errors.
Expected: Build succeeds.

**Step 4: Commit**

```bash
git add server/worldmonitor/market/v1/_shared.ts server/_shared/constants.ts
git commit -m "perf(market): concurrent Yahoo batch fetching with reduced rate gate"
```

---

### Task 2: Write commodity data to a fixed Redis key for bootstrap

**Files:**
- Modify: `server/worldmonitor/market/v1/get-market-dashboard.ts` (after line 147, after commodities array is built)
- Modify: `server/_shared/cache-keys.ts` (add `commodities` entry)
- Modify: `api/bootstrap.js` (add `commodities` to `BOOTSTRAP_CACHE_KEYS`)

**Step 1: Add commodity Redis key to the canonical cache keys registry**

In `server/_shared/cache-keys.ts`, add after the `sectors` line:

```typescript
  commodities:      'market:commodities:v1',
```

**Step 2: Write commodity data to its own Redis key in the dashboard handler**

In `server/worldmonitor/market/v1/get-market-dashboard.ts`, add an import:

```typescript
import { setCachedJson } from '../../../_shared/redis';
```

Then after the commodities array is built (after line 147, after the `for (const s of commoditySymbols)` loop), add:

```typescript
      if (commodities.length > 0) {
        setCachedJson('market:commodities:v1', { quotes: commodities }, 600).catch(() => {});
      }
```

This is fire-and-forget — it writes the commodity data to a dedicated Redis key with a 10-minute TTL, separate from the full dashboard cache. The bootstrap endpoint reads this on page load.

**Step 3: Add `commodities` to the bootstrap endpoint**

In `api/bootstrap.js`, add to `BOOTSTRAP_CACHE_KEYS` after the `sectors` line:

```javascript
  commodities:      'market:commodities:v1',
```

**Step 4: Run the bootstrap cache key sync test**

Run: `node --test tests/bootstrap.test.mjs`
Expected: All tests pass — the test validates that `api/bootstrap.js` keys match `server/_shared/cache-keys.ts`.

**Step 5: Commit**

```bash
git add server/_shared/cache-keys.ts server/worldmonitor/market/v1/get-market-dashboard.ts api/bootstrap.js
git commit -m "feat(market): write commodity data to dedicated Redis key for bootstrap hydration"
```

---

### Task 3: Hydrate commodities panel from bootstrap on page load

**Files:**
- Modify: `src/app/data-loader.ts` (in `loadMarkets()`, around line 903)

**Step 1: Add hydrated commodities display before dashboard fetch**

In `src/app/data-loader.ts`, at the start of the `loadMarkets()` method (line 903), add hydration before the try block:

```typescript
  async loadMarkets(): Promise<void> {
    const commoditiesPanel = this.ctx.panels['commodities'] as CommoditiesPanel;

    const hydratedCommodities = getHydratedData('commodities') as { quotes: Array<{ display: string; symbol: string; price: number; change: number; sparkline: number[] }> } | undefined;
    if (hydratedCommodities?.quotes?.length) {
      const mapped = hydratedCommodities.quotes.map((q) => ({
        display: q.display || q.symbol,
        price: q.price != null ? q.price : null,
        change: q.change ?? null,
        sparkline: q.sparkline?.length > 0 ? q.sparkline : undefined,
      }));
      if (mapped.some((d) => d.price !== null)) {
        commoditiesPanel.renderCommodities(mapped);
      }
    }

    try {
```

This renders hydrated (possibly stale) commodity data immediately while the dashboard fetch runs in the background. The existing code at line 941–952 will overwrite with fresh data when the dashboard responds.

Also remove the `const commoditiesPanel` declaration on the existing line 941 since we've moved it earlier:

```typescript
      // line 941 — remove this, already declared above
      // const commoditiesPanel = this.ctx.panels['commodities'] as CommoditiesPanel;
```

**Step 2: Verify the change locally**

Run: `npx vite build`
Expected: Build succeeds.

**Step 3: Commit**

```bash
git add src/app/data-loader.ts
git commit -m "feat(market): hydrate commodities panel from bootstrap cache on page load"
```

---

### Task 4: Graceful degradation — show stale data instead of error

**Files:**
- Modify: `src/app/data-loader.ts` (in `loadMarkets()`, the catch block at line 953 and the commodities rendering at lines 941–952)
- Modify: `src/components/MarketPanel.ts` (lines 79–104, `CommoditiesPanel.renderCommodities`)

**Step 1: Track last successful commodity data in the data loader**

In `src/app/data-loader.ts`, add a private field to `DataLoaderManager`:

```typescript
  private lastCommodityData: Array<{ display: string; price: number | null; change: number | null; sparkline?: number[] }> = [];
```

**Step 2: Store successful commodity data and use as fallback**

In the `loadMarkets()` method, where commodities are rendered (~line 948), update to save and fallback:

```typescript
      if (commodityData.length > 0 && commodityData.some((d) => d.price !== null)) {
        this.lastCommodityData = commodityData;
        commoditiesPanel.renderCommodities(commodityData);
      } else if (this.lastCommodityData.length > 0) {
        commoditiesPanel.renderCommodities(this.lastCommodityData, true);
      } else {
        commoditiesPanel.renderCommodities([]);
      }
```

And in the outer catch block (line 953), also attempt stale display:

```typescript
    } catch {
      this.ctx.statusPanel?.updateApi('Finnhub', { status: 'error' });
      if (this.lastCommodityData.length > 0) {
        commoditiesPanel.renderCommodities(this.lastCommodityData, true);
      }
    }
```

**Step 3: Add stale indicator to CommoditiesPanel**

In `src/components/MarketPanel.ts`, update the `renderCommodities` method signature and add a stale badge:

```typescript
  public renderCommodities(data: Array<{ display: string; price: number | null; change: number | null; sparkline?: number[] }>, stale = false): void {
    const validData = data.filter((d) => d.price !== null);

    if (validData.length === 0) {
      this.showError(t('common.failedCommodities'));
      return;
    }

    const staleBadge = stale ? '<span class="stale-badge" title="Data may be outdated">stale</span>' : '';

    const html =
      '<div class="commodities-grid">' +
      validData
        .map(
          (c) => `
        <div class="commodity-item">
          <div class="commodity-name">${escapeHtml(c.display)}${staleBadge}</div>
          ${miniSparkline(c.sparkline, c.change, 60, 18)}
          <div class="commodity-price">${formatPrice(c.price!)}</div>
          <div class="commodity-change ${getChangeClass(c.change!)}">${formatChange(c.change!)}</div>
        </div>
      `
        )
        .join('') +
      '</div>';

    this.setContent(html);
  }
```

**Step 4: Add CSS for the stale badge**

In `src/styles/main.css`, add (find the `.commodity-item` section):

```css
.stale-badge {
  display: inline-block;
  font-size: 0.6rem;
  color: var(--text-muted, #888);
  background: var(--surface-alt, rgba(255,255,255,0.05));
  border-radius: 3px;
  padding: 0 4px;
  margin-left: 4px;
  vertical-align: middle;
  opacity: 0.7;
}
```

**Step 5: Verify**

Run: `npx vite build`
Expected: Build succeeds.

**Step 6: Commit**

```bash
git add src/app/data-loader.ts src/components/MarketPanel.ts src/styles/main.css
git commit -m "fix(market): show stale commodity data instead of error when refresh fails"
```

---

### Task 5: Reduce circuit breaker aggressiveness

**Files:**
- Modify: `src/services/market/index.ts` (lines 185–188, `dashboardBreaker` options)

**Step 1: Reduce cooldown from 5 minutes to 90 seconds**

In `src/services/market/index.ts`, update the dashboard circuit breaker:

```typescript
const dashboardBreaker = createCircuitBreaker<GetMarketDashboardResponse>({
  name: 'Market Dashboard',
  cacheTtlMs: 0,
  cooldownMs: 90_000,
});
```

This means after 2 failures, the breaker only stays open for 90 seconds instead of 5 minutes. Combined with the stale data display from Task 4, users see last-known data during this window rather than an error.

**Step 2: Commit**

```bash
git add src/services/market/index.ts
git commit -m "fix(market): reduce dashboard circuit breaker cooldown from 5min to 90s"
```

---

### Task 6: Add server-side logging for Yahoo failures

**Files:**
- Modify: `server/worldmonitor/market/v1/_shared.ts` (in `fetchYahooQuote`, lines 134–164)

**Step 1: Add diagnostic logging to fetchYahooQuote**

Replace the catch block and add status logging in `fetchYahooQuote`:

```typescript
export async function fetchYahooQuote(
  symbol: string,
): Promise<{ price: number; change: number; sparkline: number[] } | null> {
  try {
    await yahooGate();
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
    const resp = await fetch(url, {
      headers: {
        'User-Agent': CHROME_UA,
      },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!resp.ok) {
      console.warn(`[Yahoo] ${symbol} HTTP ${resp.status}`);
      return null;
    }

    const data: YahooChartResponse = await resp.json();
    const result = data.chart.result[0];
    const meta = result?.meta;
    if (!meta) {
      console.warn(`[Yahoo] ${symbol} no meta in response`);
      return null;
    }

    const price = meta.regularMarketPrice;
    const prevClose = meta.chartPreviousClose || meta.previousClose || price;
    const change = ((price - prevClose) / prevClose) * 100;

    const closes = result.indicators?.quote?.[0]?.close;
    const sparkline = closes?.filter((v): v is number => v != null) || [];

    return { price, change, sparkline };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Yahoo] ${symbol} fetch error: ${msg}`);
    return null;
  }
}
```

**Step 2: Commit**

```bash
git add server/worldmonitor/market/v1/_shared.ts
git commit -m "fix(market): add diagnostic logging for Yahoo Finance fetch failures"
```

---

### Task 7: Update bootstrap cache key sync test

**Files:**
- Modify: `tests/bootstrap.test.mjs` (only if the test fails due to the new `commodities` key)

**Step 1: Run the existing test to verify key sync**

Run: `node --test tests/bootstrap.test.mjs`
Expected: PASS — the test already validates that `api/bootstrap.js` keys match `server/_shared/cache-keys.ts`. Adding `commodities` to both files (Task 2) should keep them in sync.

If the test fails, check that the `commodities` key value is identical in both files (`'market:commodities:v1'`).

**Step 2: Run full test suite**

Run: `node --test tests/`
Expected: All tests pass.

**Step 3: Commit (if any test fixes were needed)**

```bash
git add tests/
git commit -m "test: update bootstrap cache key test for commodities hydration"
```

---

## Smoke Test

After all tasks are complete, verify end-to-end:

1. Start dev server: `make dev` or `npx vite dev`
2. Open the app in browser — Commodities panel should:
   - Show hydrated data immediately on first load (if bootstrap cache has commodity data in Redis)
   - Refresh with live data from the dashboard RPC within a few seconds
   - If Yahoo is down, show last-known data with a "stale" badge instead of error
3. Check browser console for:
   - No `[Yahoo]` error logs spamming (should be max 1–2 per failed symbol, not repeated)
   - `[market-dashboard]` or similar logs confirming commodity data arrived
4. Check server logs for Yahoo diagnostic output showing per-symbol HTTP status

## Summary of Changes

| File | Change |
|------|--------|
| `server/_shared/constants.ts` | `YAHOO_MIN_GAP_MS` 600→200 |
| `server/worldmonitor/market/v1/_shared.ts` | Concurrent batch fetch (3), logging |
| `server/worldmonitor/market/v1/get-market-dashboard.ts` | Write commodities to own Redis key |
| `server/_shared/cache-keys.ts` | Add `commodities` key |
| `api/bootstrap.js` | Add `commodities` to hydration |
| `src/app/data-loader.ts` | Hydrate commodities, stale fallback |
| `src/components/MarketPanel.ts` | Stale badge parameter |
| `src/styles/main.css` | `.stale-badge` style |
| `src/services/market/index.ts` | Breaker cooldown 5min→90s |
