# Frontend: Push-on-Subscribe & Handler Robustness Fix

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make every panel show data (or a clear "unavailable" state) within 30 seconds of page load by relying on WebSocket push-on-subscribe for initial data delivery, fixing all 15 handler early-return bugs, adding loading timeouts, and cleaning up dead code.

**Architecture:** WebSocket `wm-subscribe` → gateway pushes current data → `relay-push.ts` dispatches to handlers → handlers always call panel render methods. No more HTTP bootstrap dependency.

**Tech Stack:** TypeScript (Vite frontend), vanilla DOM, channel-state machine

**Companion plan:** `docs/plans/2026-03-10-backend-push-on-subscribe.md` — backend changes that this plan depends on. Both plans use identical channel names, Redis keys, and message formats defined in the backend plan's **Shared Contract** table.

---

## Critical Context: Why Previous Fixes Failed

Previous plans fixed:
- WebSocket field name mismatches (`data` vs `payload`) ✓
- Envelope unwrapping ✓
- Channel registry wiring ✓
- `loadAllData()` drain loop ✓

But panels STILL show "no data" because:

1. **15 handlers silently return on empty/edge-case payloads** — panel stays in "Loading..." forever
2. **`getHydratedData()` is delete-on-read** — race condition loses data between `loadNews()` and `loadAllData()`
3. **Channel state not updated on null payloads** — panel badge never transitions
4. **No loading timeout** — panels wait forever for data that may never arrive
5. **GDELT handler calls `refresh()` instead of passing data** — triggers HTTP re-fetch instead of rendering WebSocket payload
6. **Bootstrap is fragile** — one-shot HTTP fetch with no retry on reconnect

This plan fixes ALL of these. Every handler is listed with its exact bug and exact fix.

---

## Task 1: Fix `relay-push.ts` — Set error state on null payloads

**Files:**
- Modify: `src/services/relay-push.ts` lines 29–42 (the `dispatch` function)

**Step 1: Update the `dispatch` function**

Current code (lines 29–42):
```typescript
function dispatch(channel: string, payload: unknown): void {
  if (payload !== undefined && payload !== null) {
    setChannelState(channel, 'ready', 'websocket', { lastDataAt: Date.now() });
  }
  const channelHandlers = handlers.get(channel);
  if (!channelHandlers) return;
  for (const h of channelHandlers) {
    try {
      h(payload);
    } catch (err) {
      console.error(`[relay-push] handler error (${channel}):`, err);
    }
  }
}
```

New code:
```typescript
function dispatch(channel: string, payload: unknown): void {
  if (payload !== undefined && payload !== null) {
    setChannelState(channel, 'ready', 'websocket', { lastDataAt: Date.now() });
  } else {
    setChannelState(channel, 'error', 'websocket', { error: 'No data available' });
  }
  const channelHandlers = handlers.get(channel);
  if (!channelHandlers) return;
  for (const h of channelHandlers) {
    try {
      h(payload);
    } catch (err) {
      console.error(`[relay-push] handler error (${channel}):`, err);
    }
  }
}
```

**Step 2: Verify existing tests pass**

```bash
npm run test -- --grep relay-push
```

**Step 3: Commit**

```bash
git add src/services/relay-push.ts
git commit -m "fix(relay-push): set channel error state on null/undefined payloads"
```

---

## Task 2: Fix `intelligence-handler.ts` — 4 handler bugs

**Files:**
- Modify: `src/data/intelligence-handler.ts`

### Bug 2a: `telegram` handler — silent return on empty messages (line 141)

Current code (line 141):
```typescript
if (messages.length === 0) return;
```

New code:
```typescript
if (messages.length === 0) {
  (ctx.panels['telegram-intel'] as TelegramIntelPanel)?.setData({
    source: 'telegram' as const,
    earlySignal: false,
    enabled: true,
    count: 0,
    updatedAt: String((payload as Record<string, unknown>).timestamp ?? new Date().toISOString()),
    items: [],
  });
  return;
}
```

### Bug 2b: `intelligence` handler — silent return when digest is missing (line 81)

Current code (line 81):
```typescript
if (!data.digest && !data.generatedAt) return;
```

New code:
```typescript
if (!data.digest && !data.generatedAt) {
  (ctx.panels['global-digest'] as GlobalDigestPanel | undefined)?.showUnavailable(
    'Intelligence digest not yet available.',
  );
  return;
}
```

### Bug 2c: `gdelt` handler — calls refresh() instead of passing data (lines 197–201)

Current code (lines 197–201):
```typescript
gdelt: (payload: unknown) => {
  if (!payload || typeof payload !== 'object') return;
  const gdeltPanel = ctx.panels['gdelt-intel'] as { refresh?: () => void } | undefined;
  gdeltPanel?.refresh?.();
},
```

New code:
```typescript
gdelt: (payload: unknown) => {
  if (!payload || typeof payload !== 'object') return;
  const gdeltPanel = ctx.panels['gdelt-intel'] as {
    refresh?: () => void;
    applyRelayData?: (data: unknown) => void;
  } | undefined;
  if (gdeltPanel?.applyRelayData) {
    gdeltPanel.applyRelayData(payload);
  } else {
    gdeltPanel?.refresh?.();
  }
},
```

### Bug 2d: `conflict` handler — silent return on zero events (line 89)

Current code (line 89):
```typescript
if (data.count === 0) return;
```

New code:
```typescript
if (data.count === 0) {
  (ctx.panels['cii'] as CIIPanel)?.refresh();
  return;
}
```

**Step: Commit**

```bash
git add src/data/intelligence-handler.ts
git commit -m "fix(intelligence-handler): telegram, intelligence, gdelt, conflict handlers always update panels"
```

---

## Task 3: Fix `markets-handler.ts` — 3 handler bugs

**Files:**
- Modify: `src/data/markets-handler.ts`

### Bug 3a: `markets` handler — silent return on bad shape (line 100)

Current code (lines 97–101):
```typescript
markets: (payload: unknown) => {
  if (!payload || typeof payload !== 'object') return;
  const dashboard = payload as GetMarketDashboardResponse;
  if (!Array.isArray(dashboard.stocks)) return;
  renderMarketDashboard(dashboard);
},
```

New code:
```typescript
markets: (payload: unknown) => {
  if (!payload || typeof payload !== 'object') return;
  const dashboard = payload as GetMarketDashboardResponse;
  if (!Array.isArray(dashboard.stocks)) {
    (ctx.panels['markets'] as MarketPanel).showError(t('common.failedMarketData'));
    return;
  }
  renderMarketDashboard(dashboard);
},
```

Add import at top of file (if not already present):
```typescript
import { t } from '@/services/i18n';
```

### Bug 3b: `predictions` handler — silent return on bad shape (line 106)

Current code (lines 103–106):
```typescript
predictions: (payload: unknown) => {
  if (!payload || typeof payload !== 'object') return;
  const resp = (Array.isArray(payload) ? { markets: payload } : payload) as ListPredictionMarketsResponse;
  if (!Array.isArray(resp.markets)) return;
```

New code:
```typescript
predictions: (payload: unknown) => {
  if (!payload || typeof payload !== 'object') return;
  const resp = (Array.isArray(payload) ? { markets: payload } : payload) as ListPredictionMarketsResponse;
  if (!Array.isArray(resp.markets)) {
    (ctx.panels['polymarket'] as PredictionPanel).showError(t('common.failedToLoad'));
    return;
  }
```

### Bug 3c: `gulf-quotes` handler — silent return on bad shape (line 119)

Current code (lines 116–121):
```typescript
'gulf-quotes': (payload: unknown) => {
  if (!payload || typeof payload !== 'object') return;
  const data = payload as ListGulfQuotesResponse;
  if (!Array.isArray(data.quotes)) return;
  (ctx.panels['gulf-economies'] as GulfEconomiesPanel)?.setData(data);
},
```

New code:
```typescript
'gulf-quotes': (payload: unknown) => {
  if (!payload || typeof payload !== 'object') return;
  const data = payload as ListGulfQuotesResponse;
  if (!Array.isArray(data.quotes)) {
    (ctx.panels['gulf-economies'] as GulfEconomiesPanel)?.showError(t('common.failedToLoad'));
    return;
  }
  (ctx.panels['gulf-economies'] as GulfEconomiesPanel)?.setData(data);
},
```

**Step: Commit**

```bash
git add src/data/markets-handler.ts
git commit -m "fix(markets-handler): markets, predictions, gulf-quotes handlers always update panels"
```

---

## Task 4: Fix `economic-handler.ts` — 6 handler bugs

**Files:**
- Modify: `src/data/economic-handler.ts`

### Bug 4a: `fred` — `if (!('series' in resp)) return;` (line 140)

Add after the early return:
```typescript
if (!('series' in resp)) {
  const economicPanel = ctx.panels['economic'] as EconomicPanel;
  economicPanel?.showError(t('common.failedToLoad'));
  return;
}
```

### Bug 4b: `oil` — `if (!Array.isArray(resp.prices)) return;` (line 147)

Same pattern — call `economicPanel?.showError(...)`.

### Bug 4c: `bis` — `if (!Array.isArray(resp.rates)) return;` (line 154)

Same pattern.

### Bug 4d: `trade` — `if (!('barriers' in data)) return;` (line 173)

Add:
```typescript
if (!('barriers' in data)) {
  (ctx.panels['trade-policy'] as TradePolicyPanel | undefined)?.showError(t('common.failedToLoad'));
  return;
}
```

### Bug 4e: `supply-chain` — `if (!('chokepoints' in data)) return;` (line 179)

Add:
```typescript
if (!('chokepoints' in data)) {
  (ctx.panels['supply-chain'] as SupplyChainPanel | undefined)?.showError(t('common.failedToLoad'));
  return;
}
```

### Bug 4f: `giving` — `if (!data || !Array.isArray(data.platforms)) return;` (line 197)

Add:
```typescript
if (!data || !Array.isArray(data.platforms)) {
  (ctx.panels['giving'] as GivingPanel)?.showError(t('common.failedToLoad'));
  return;
}
```

Add import at top of file:
```typescript
import { t } from '@/services/i18n';
```

**Step: Commit**

```bash
git add src/data/economic-handler.ts
git commit -m "fix(economic-handler): fred, oil, bis, trade, supply-chain, giving handlers always update panels"
```

---

## Task 5: Fix `geo-handler.ts` and `infrastructure-handler.ts` — remaining handler bugs

**Files:**
- Modify: `src/data/geo-handler.ts`
- Modify: `src/data/infrastructure-handler.ts`

### Bug 5a: `climate` in geo-handler — `if (anomalies.length === 0)` path doesn't update panel

Find the climate handler. If it returns early on `anomalies.length === 0`, add:
```typescript
if (anomalies.length === 0) {
  (ctx.panels['climate'] as ClimateAnomalyPanel)?.setAnomalies([]);
  return;
}
```

### Bug 5b: `tech-events` in infrastructure-handler — `if (!Array.isArray(data.events))` early return

Add:
```typescript
if (!Array.isArray(data.events)) {
  (ctx.panels['events'] as TechEventsPanel)?.showError(t('common.failedToLoad'));
  return;
}
```

### Bug 5c: `ais` in infrastructure-handler — `if (!Array.isArray(snap.disruptions))` early return

This prevents AIS data from reaching the map. Add a fallback that at least sets the vessel data:
```typescript
if (!Array.isArray(snap.disruptions) && !Array.isArray(snap.density)) {
  if (Array.isArray(snap.vessels)) {
    ctx.map?.setAisVessels(snap.vessels);
  }
  return;
}
```

### Bug 5d: `news:*` in news-handler.ts — `if (!payload) return;` (line 419)

Current code (lines 418–419):
```typescript
function applyNewsDigest(payload: unknown): void {
  if (!payload) return;
```

New code:
```typescript
function applyNewsDigest(payload: unknown): void {
  if (!payload) {
    for (const [category, panel] of Object.entries(ctx.newsPanels)) {
      if (panel) panel.showError(t('common.noNewsAvailable'));
    }
    return;
  }
```

This ensures that when the WebSocket pushes a null news payload, all news panels (Intel Feed, World News, Politics, Tech, etc.) show "No news available" instead of staying in "Loading..." forever.

**Step: Commit**

```bash
git add src/data/geo-handler.ts src/data/infrastructure-handler.ts src/data/news-handler.ts
git commit -m "fix(geo/infra/news-handler): climate, tech-events, ais, news handlers always update panels"
```

---

## Task 6: Add `applyRelayData` to GdeltIntelPanel

**Files:**
- Modify: `src/components/GdeltIntelPanel.ts`

**Step 1: Add `applyRelayData` method**

Add a public method that accepts the relay payload (same shape as what `fetchTopicIntelligence` returns) and renders the active topic's articles directly:

```typescript
public applyRelayData(payload: unknown): void {
  if (!payload || typeof payload !== 'object') {
    this.refresh();
    return;
  }
  const raw = payload as { data?: Record<string, { articles: GdeltArticle[]; query: string; fetchedAt: string }> };
  if (!raw.data || typeof raw.data !== 'object') {
    this.refresh();
    return;
  }
  // Store the relay data for all topics
  this._relayCache = raw.data;
  // Render the active topic from relay data
  const topicData = raw.data[this._activeTopicId];
  if (topicData?.articles) {
    this.renderArticles(topicData.articles);
    this.setCount(topicData.articles.length);
  } else {
    this.refresh();
  }
}
```

Also add the private field:
```typescript
private _relayCache: Record<string, { articles: GdeltArticle[]; query: string; fetchedAt: string }> | null = null;
```

And update `loadActiveTopic` to check `_relayCache` first before doing HTTP fetch:
```typescript
async loadActiveTopic(): Promise<void> {
  // Check relay cache first
  if (this._relayCache) {
    const cached = this._relayCache[this._activeTopicId];
    if (cached?.articles) {
      this.renderArticles(cached.articles);
      this.setCount(cached.articles.length);
      return;
    }
  }
  // Fall back to HTTP fetch
  // ... existing code ...
}
```

**Step 2: Commit**

```bash
git add src/components/GdeltIntelPanel.ts
git commit -m "feat(gdelt-panel): add applyRelayData for direct WebSocket data rendering"
```

---

## Task 7: Add loading timeout to base Panel class

**Files:**
- Modify: `src/components/Panel.ts`

**Step 1: Add timeout field and logic (in the constructor, after `showLoading()` call)**

Add private field (around line 203):
```typescript
private _loadingTimeoutId: ReturnType<typeof setTimeout> | null = null;
private static readonly LOADING_TIMEOUT_MS = 30_000;
```

In the `subscribeToChannelState` method (line 302), after setting up subscriptions, add the timeout:

```typescript
private subscribeToChannelState(): void {
  if (this.destroyed || this.channelKeys.length === 0) return;
  for (const channel of this.channelKeys) {
    const unsub = subscribeChannelState(channel, (status: ChannelStatus) => {
      this.handleChannelStatus(channel, status);
    });
    this.channelUnsubscribes.push(unsub);
  }

  // Start loading timeout — if no data arrives within 30s, show unavailable
  this._loadingTimeoutId = setTimeout(() => {
    if (this.destroyed) return;
    // Check if ANY of our channels are still loading or idle
    const allChannelsStuck = this.channelKeys.every(ch => {
      const state = getChannelState(ch);
      return state.state === 'loading' || state.state === 'idle';
    });
    if (allChannelsStuck) {
      this.showUnavailable(t('common.dataTimeout'));
      this.setDataBadge('unavailable', 'Timed out waiting for data');
    }
  }, Panel.LOADING_TIMEOUT_MS);
}
```

Add import at top of file (if not already present):
```typescript
import { getChannelState } from '@/services/channel-state';
```

**Step 2: Clear timeout when data arrives (in `handleChannelStatus`, line 313)**

Add at the start of `handleChannelStatus`:
```typescript
private handleChannelStatus(channel: string, status: ChannelStatus): void {
  if (this.destroyed) return;
  // Clear loading timeout on any non-loading state
  if (status.state !== 'loading' && status.state !== 'idle') {
    if (this._loadingTimeoutId) {
      clearTimeout(this._loadingTimeoutId);
      this._loadingTimeoutId = null;
    }
  }
  // ... rest of existing code ...
```

**Step 3: Clear timeout on destroy**

In the `destroy()` method, add:
```typescript
if (this._loadingTimeoutId) {
  clearTimeout(this._loadingTimeoutId);
  this._loadingTimeoutId = null;
}
```

**Step 4: Commit**

```bash
git add src/components/Panel.ts
git commit -m "feat(panel): add 30s loading timeout — shows unavailable instead of eternal spinner"
```

---

## Task 8: Variant-aware channel subscription

**Files:**
- Modify: `src/App.ts` — the `setupRelayPush` method (lines 597–616)

**Step 1: Replace the channel computation to only subscribe to channels needed by active panels**

Current code (lines 597–616):
```typescript
private setupRelayPush(): void {
  const variant = SITE_VARIANT || 'full';
  const newsChannels = ['news:full', 'news:tech', 'news:finance', 'news:happy'];
  const channels = [
    ...RELAY_CHANNELS.filter(
      (ch) => !newsChannels.includes(ch) && (variant === 'full' || ch !== 'pizzint')
    ),
    `news:${variant}`,
  ];
  initRelayPush(channels);
  for (const [channel] of Object.entries(CHANNEL_REGISTRY)) {
    const handler = this.getPushHandler(channel);
    if (handler) subscribeRelayPush(channel, handler);
  }
}
```

New code:
```typescript
private setupRelayPush(): void {
  const variant = SITE_VARIANT || 'full';
  const newsChannels = ['news:full', 'news:tech', 'news:finance', 'news:happy'];

  // Compute channels needed by active panels + their dependencies
  const neededChannels = new Set<string>();
  const enabledPanelIds = new Set(Object.keys(this.state.panels));

  for (const [channel, def] of Object.entries(CHANNEL_REGISTRY)) {
    // Skip variant-specific news channels (add only the active variant below)
    if (newsChannels.includes(channel)) continue;
    // Skip pizzint for non-full variants
    if (channel === 'pizzint' && variant !== 'full') continue;
    // Include if any of this channel's panels are enabled, or if it has map layers, or if it's a config/AI channel
    const hasActivePanel = def.panels.some(p => enabledPanelIds.has(p));
    const isMapLayer = (def.mapLayers?.length ?? 0) > 0;
    const isConfig = def.domain === 'config' || def.domain === 'ai';
    if (hasActivePanel || isMapLayer || isConfig) {
      neededChannels.add(channel);
    }
  }
  // Always add the active news variant
  neededChannels.add(`news:${variant}`);

  const channels = Array.from(neededChannels);
  initRelayPush(channels);

  for (const channel of channels) {
    const handler = this.getPushHandler(channel);
    if (handler) subscribeRelayPush(channel, handler);
  }
}
```

**Step 2: Commit**

```bash
git add src/App.ts
git commit -m "feat(app): variant-aware channel subscription — only subscribe to channels active panels need"
```

---

## Task 9: Fix `bootstrap.ts` — consumed flag instead of delete-on-read

**Files:**
- Modify: `src/services/bootstrap.ts` lines 14–17

**Step 1: Replace delete-on-read with consumed flag**

Current code (lines 12–18):
```typescript
const hydrationCache = new Map<string, unknown>();

export function getHydratedData(key: string): unknown | undefined {
  const val = hydrationCache.get(key);
  if (val !== undefined) hydrationCache.delete(key);
  return val;
}
```

New code:
```typescript
const hydrationCache = new Map<string, unknown>();
const consumedKeys = new Set<string>();

export function getHydratedData(key: string): unknown | undefined {
  if (consumedKeys.has(key)) return undefined;
  const val = hydrationCache.get(key);
  if (val !== undefined) consumedKeys.add(key);
  return val;
}
```

**Step 2: Commit**

```bash
git add src/services/bootstrap.ts
git commit -m "fix(bootstrap): use consumed flag instead of delete-on-read to prevent race conditions"
```

---

## Task 10: Clean up deprecated code

**Files:**
- Modify: `src/services/conflict/index.ts` — delete `fetchConflictEvents` (line ~247), `fetchIranEvents` (line ~402), `fetchHapiSummary` (line ~284)
- Modify: `src/services/relay-http.ts` — delete `fetchRelayMap` (line ~42)
- Delete: `src/app/refresh-scheduler.ts`
- Delete: `src/config/feeds.ts`

**Step 1: Remove deprecated functions from conflict/index.ts**

Search for `@deprecated` in the file:
```bash
grep -n '@deprecated' src/services/conflict/index.ts
```

Delete each deprecated function and its JSDoc. Verify no remaining imports reference them:
```bash
grep -rn 'fetchConflictEvents\|fetchIranEvents\|fetchHapiSummary' src/ --include='*.ts'
```

If any imports remain, remove them.

**Step 2: Remove `fetchRelayMap` from relay-http.ts**

Delete the function and verify no references:
```bash
grep -rn 'fetchRelayMap' src/ --include='*.ts'
```

**Step 3: Delete refresh-scheduler.ts and feeds.ts**

```bash
rm src/app/refresh-scheduler.ts src/config/feeds.ts
```

Verify no imports reference them:
```bash
grep -rn 'refresh-scheduler\|from.*config/feeds' src/ --include='*.ts'
```

Remove any remaining import lines.

**Step 4: Commit**

```bash
git add -A
git commit -m "chore: remove deprecated fetchConflictEvents, fetchIranEvents, fetchHapiSummary, fetchRelayMap, RefreshScheduler, feeds.ts"
```

---

## Task 11: Build and verify

**Step 1: Build**

```bash
npm run build
```

Fix any TypeScript errors. Common issues:
- Missing imports for `t` from `@/services/i18n` in handler files
- Removed exports that were imported elsewhere
- Type errors from new handler code

**Step 2: Verify handler coverage**

Manually check that every handler in the **Shared Contract** table from the backend plan has a corresponding handler in `DataLoaderManager.domainHandlers` that calls a panel method (not just returns early).

**Step 3: Verify no remaining silent returns**

```bash
grep -n 'return;' src/data/*-handler.ts | grep -v 'showError\|showUnavailable\|setData\|render\|refresh\|applyPush\|setDigest\|setEvents\|setAnomalies\|update'
```

Every remaining `return;` should be for the initial `if (!payload || typeof payload !== 'object') return;` guard only — that's acceptable because it means the payload was truly invalid (not empty data).

**Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix: resolve build errors from handler and cleanup changes"
```

---

## Execution Order

| Task | Risk | Effort | What it fixes |
|---|---|---|---|
| **1. relay-push null fix** | Low | 5 min | Channel state stuck on null payloads |
| **9. bootstrap consumed flag** | Low | 5 min | Race condition losing hydration data |
| **2. intelligence-handler** | Low | 15 min | telegram, intelligence, gdelt, conflict panels |
| **3. markets-handler** | Low | 10 min | markets, predictions, gulf-quotes panels |
| **4. economic-handler** | Low | 15 min | fred, oil, bis, trade, supply-chain, giving panels |
| **5. geo/infra-handler** | Low | 10 min | climate, tech-events, ais panels |
| **6. GdeltIntelPanel** | Low | 15 min | GDELT renders from push data |
| **7. Panel loading timeout** | Low | 15 min | Safety net for all panels |
| **8. Variant-aware subscription** | Medium | 15 min | Only subscribe to needed channels |
| **10. Dead code cleanup** | Low | 10 min | Removes deprecated functions |
| **11. Build and verify** | None | 15 min | Confirms everything compiles |

**Do Tasks 1→9→2→3→4→5 first** (fix all handler bugs). Then 6→7→8 (panel improvements). Then 10→11 (cleanup and verify).

---

## Success Criteria

1. **Zero eternal spinners:** No panel shows "Loading..." for more than 30 seconds
2. **Empty data = "No data" state:** When a channel has data but it's empty (0 events, 0 items), the panel shows "No recent events" or similar — not a loading spinner
3. **Invalid data = error state:** When a channel sends malformed data, the panel shows an error — not a loading spinner
4. **Null payload = unavailable badge:** When gateway pushes null, the panel badge shows "unavailable"
5. **GDELT renders from push:** GdeltIntelPanel shows articles immediately from WebSocket data without HTTP re-fetch
6. **Variant filtering:** `tech` variant subscribes to ~15 channels, not 50+
7. **Build succeeds:** `npm run build` completes with zero errors
8. **No deprecated references:** `grep -rn 'fetchConflictEvents\|fetchIranEvents\|RefreshScheduler\|fetchRelayMap\|fetchHapiSummary' src/` returns zero results

---

## Handler Bug Reference (All 15 Fixed in This Plan)

| # | Handler | File | Line | Bug | Fix | Task |
|---|---------|------|------|-----|-----|------|
| 1 | `telegram` | intelligence-handler.ts | 141 | `messages.length === 0` → return | Call `setData({ items: [] })` | 2a |
| 2 | `intelligence` | intelligence-handler.ts | 81 | `!digest && !generatedAt` → return | Call `showUnavailable()` | 2b |
| 3 | `gdelt` | intelligence-handler.ts | 197 | Calls `refresh()` not passing data | Call `applyRelayData()` | 2c |
| 4 | `conflict` | intelligence-handler.ts | 89 | `count === 0` → return | Call `CII.refresh()` | 2d |
| 5 | `markets` | markets-handler.ts | 100 | `!Array.isArray(stocks)` → return | Call `showError()` | 3a |
| 6 | `predictions` | markets-handler.ts | 106 | `!Array.isArray(markets)` → return | Call `showError()` | 3b |
| 7 | `gulf-quotes` | markets-handler.ts | 119 | `!Array.isArray(quotes)` → return | Call `showError()` | 3c |
| 8 | `fred` | economic-handler.ts | 140 | `!('series' in resp)` → return | Call `showError()` | 4a |
| 9 | `oil` | economic-handler.ts | 147 | `!Array.isArray(prices)` → return | Call `showError()` | 4b |
| 10 | `bis` | economic-handler.ts | 154 | `!Array.isArray(rates)` → return | Call `showError()` | 4c |
| 11 | `trade` | economic-handler.ts | 173 | `!('barriers' in data)` → return | Call `showError()` | 4d |
| 12 | `supply-chain` | economic-handler.ts | 179 | `!('chokepoints' in data)` → return | Call `showError()` | 4e |
| 13 | `giving` | economic-handler.ts | 197 | `!Array.isArray(platforms)` → return | Call `showError()` | 4f |
| 14 | `climate` | geo-handler.ts | varies | `anomalies.length === 0` → return | Call `setAnomalies([])` | 5a |
| 15 | `tech-events` | infrastructure-handler.ts | varies | `!Array.isArray(events)` → return | Call `showError()` | 5b |
| 16 | `news:*` | news-handler.ts | 419 | `if (!payload) return;` (silent) | Show "No news available" in all news panels | 5c |
