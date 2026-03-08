# Frontend Relay Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrate frontend from polling individual relay endpoints to using unified `/bootstrap` + WebSocket push for real-time updates.

**Architecture:** Replace per-channel polling with: (1) Single `/bootstrap` call on page load for initial data, (2) WebSocket subscription via `relay-push` for real-time updates, (3) Remove all direct endpoint polling from `refresh-scheduler`.

**Tech Stack:** TypeScript, existing `relay-push.ts` WebSocket client, existing `bootstrap.ts` service, `data-loader.ts` orchestration.

---

## Current State Analysis

**What's already working:**
- ✅ `relay-push.ts` - Full WebSocket client with `subscribe()`, `initRelayPush()`, reconnection logic
- ✅ `bootstrap.ts` - Fetches `/bootstrap` endpoint, handles hydration cache
- ✅ `relay-http.ts` - Helpers for `/panel/:channel` and `/map/:layer`

**What needs migration:**
- ❌ Individual channel polling in `refresh-scheduler` (aviation, markets, gdelt, oref, etc.)
- ❌ Direct proxy endpoint calls (`/opensky`, `/polymarket`, `/gdelt`)
- ❌ RSS polling for security advisories and other feeds

**Migration Strategy:**
1. Identify all polled channels in `data-loader.ts`
2. Convert each polling registration to WebSocket subscription
3. Update bootstrap to fetch all needed channels
4. Remove polling registrations
5. Add fallback for non-relay data sources (keep existing)
6. Verify with DevTools (no polling, WebSocket frames visible)

---

## Task 1: Audit and Document Current Polling Channels

**Files:**
- Read: `src/app/data-loader.ts`
- Create: `docs/plans/frontend-polling-audit.md`

**Step 1: Search for all `scheduleRefresh` calls**

```bash
cd /Users/jolipton/Projects/worldmonitor
grep -n "scheduleRefresh\|registerDeferred" src/app/data-loader.ts > /tmp/polling-audit.txt
```

Expected: List of all scheduled refreshes with line numbers

**Step 2: Categorize channels**

Create audit document categorizing each refresh:

```markdown
# Polling Audit

## Relay Channels (to migrate)
- aviation: `fetchMilitaryFlights()` - every 60s
- markets: `fetchMarketDashboard()` - every 120s
- gdelt: `fetchGdeltTensions()` - every 180s
- oref: `fetchOrefAlerts()` - every 30s
- polymarket: `fetchPredictions()` - every 180s
... etc

## Non-Relay (keep polling)
- Supabase realtime subscriptions
- Local worker computations
- Third-party APIs not proxied by relay
```

**Step 3: Commit audit**

```bash
git add docs/plans/frontend-polling-audit.md
git commit -m "docs: audit current polling channels for relay migration"
```

---

## Task 2: Extend Bootstrap to Request All Relay Channels

**Files:**
- Modify: `src/services/bootstrap.ts:15-54`
- Test: Manual verification in DevTools

**Step 1: Update bootstrap query parameter**

Current: `/bootstrap?variant=full`
New: `/bootstrap?variant=full&channels=aviation,markets,gdelt,oref,polymarket,earthquakes,fires,cyber,climate,protests`

```typescript
// In fetchBootstrapData()
export async function fetchBootstrapData(variant: string = 'full'): Promise<void> {
  const cacheKey = `bootstrap:v2:${variant}`;
  
  // Define all relay channels we need
  const RELAY_CHANNELS = [
    'aviation', 'markets', 'gdelt', 'oref', 'polymarket',
    'earthquakes', 'fires', 'cyber', 'climate', 'protests',
    'cables', 'gps-jamming', 'advisories', 'telegram'
  ];

  // Phase 1: Load stale data from IndexedDB (unchanged)
  try {
    const cached = await getPersistentCache<Record<string, unknown>>(cacheKey);
    if (cached?.data && typeof cached.data === 'object') {
      const age = Date.now() - (cached.updatedAt ?? 0);
      if (age < STALE_THRESHOLD_MS) {
        for (const [k, v] of Object.entries(cached.data)) {
          if (v !== null && v !== undefined) hydrationCache.set(k, v);
        }
      }
    }
  } catch {
    /* IndexedDB unavailable */
  }

  // Phase 2: Fetch fresh data from relay WITH channels parameter
  try {
    const channelsParam = RELAY_CHANNELS.join(',');
    const url = `${RELAY_HTTP_BASE}/bootstrap?variant=${encodeURIComponent(variant)}&channels=${encodeURIComponent(channelsParam)}`;
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(5_000), // Increased timeout for more channels
      headers: getRelayFetchHeaders(),
    });
    if (!resp.ok) return;
    const json = (await resp.json()) as Record<string, unknown>;
    const data = (json.data as Record<string, unknown>) ?? json;
    for (const [k, v] of Object.entries(data)) {
      if (v !== null && v !== undefined) {
        hydrationCache.set(k, v);
      }
    }
    void setPersistentCache(cacheKey, data).catch(() => {});
  } catch {
    // If server fetch failed but we had stale data, panels will use that
  }
}
```

**Step 2: Manual test in DevTools**

```bash
npm run dev
```

1. Open DevTools → Network tab
2. Reload page
3. Find `/bootstrap` request
4. Verify query param includes `channels=aviation,markets,...`
5. Verify response contains data for all requested channels

Expected: Response body has keys like `{ aviation: {...}, markets: {...}, ... }`

**Step 3: Commit**

```bash
git add src/services/bootstrap.ts
git commit -m "feat(bootstrap): request all relay channels in single call"
```

---

## Task 3: Initialize WebSocket with All Relay Channels

**Files:**
- Modify: `src/app/data-loader.ts` (locate where `initRelayPush` is called)
- Test: Manual verification in DevTools

**Step 1: Find current initRelayPush call**

```bash
grep -n "initRelayPush" src/app/data-loader.ts
```

Expected: Single call in `DataLoader.init()` or similar

**Step 2: Update channel list**

```typescript
// In DataLoader.init() or wherever initRelayPush is called
const RELAY_CHANNELS = [
  'aviation', 'markets', 'gdelt', 'oref', 'polymarket',
  'earthquakes', 'fires', 'cyber', 'climate', 'protests',
  'cables', 'gps-jamming', 'advisories', 'telegram'
];

initRelayPush(RELAY_CHANNELS);
```

**Step 3: Manual test WebSocket subscription**

```bash
npm run dev
```

1. Open DevTools → Network tab → WS
2. Find WebSocket connection to relay
3. Click it → Messages tab
4. Verify `wm-subscribe` message sent with all channels: `{"type":"wm-subscribe","channels":["aviation","markets",...]}`

Expected: Subscribe message sent on connection open

**Step 4: Commit**

```bash
git add src/app/data-loader.ts
git commit -m "feat(relay): subscribe to all channels on WebSocket init"
```

---

## Task 4: Convert Aviation Polling to WebSocket Push

**Files:**
- Modify: `src/app/data-loader.ts` (aviation-related methods)
- Test: `npm run dev` + manual verification

**Step 1: Remove aviation polling registration**

Find and comment out:

```typescript
// BEFORE (remove this):
this.ctx.refreshScheduler.scheduleRefresh(
  'aviation',
  () => this.loadAviationData(),
  60_000 // 60s polling
);

// AFTER: Removed - now using WebSocket push
```

**Step 2: Subscribe to WebSocket push**

Add in `DataLoader.init()`:

```typescript
import { subscribe as relaySubscribe } from '@/services/relay-push';

// In init():
relaySubscribe('aviation', (payload) => {
  this.renderAviationData(payload);
});
```

**Step 3: Update hydration to use bootstrap data**

In `loadAviationData()` or wherever initial load happens:

```typescript
// Try hydration first (from bootstrap)
const hydrated = getHydratedData('aviation');
if (hydrated) {
  this.renderAviationData(hydrated);
  return;
}

// Fallback: fetch /panel/aviation if not in bootstrap
const panelData = await fetchRelayPanel('aviation');
if (panelData) {
  this.renderAviationData(panelData);
}
```

**Step 4: Manual test**

```bash
npm run dev
```

1. DevTools → Network: Verify **NO** polling requests to `/panel/aviation`
2. DevTools → WS Messages: Verify `wm-push` messages with `channel: 'aviation'`
3. UI: Verify aviation panel updates in real-time

Expected: No HTTP polling, WebSocket frames with aviation data

**Step 5: Commit**

```bash
git add src/app/data-loader.ts
git commit -m "feat(aviation): migrate from polling to WebSocket push"
```

---

## Task 5: Convert Markets Polling to WebSocket Push

**Files:**
- Modify: `src/app/data-loader.ts` (markets-related methods)
- Test: Manual verification

**Step 1: Remove markets polling**

```typescript
// BEFORE (remove):
this.ctx.refreshScheduler.scheduleRefresh(
  'markets',
  () => this.loadMarketsData(),
  120_000 // 120s
);

// AFTER: Removed
```

**Step 2: Subscribe to WebSocket**

```typescript
relaySubscribe('markets', (payload) => {
  this.renderMarketsData(payload);
});
```

**Step 3: Hydration fallback**

```typescript
const hydrated = getHydratedData('markets');
if (hydrated) {
  this.renderMarketsData(hydrated);
  return;
}
const panelData = await fetchRelayPanel('markets');
if (panelData) this.renderMarketsData(panelData);
```

**Step 4: Manual test**

1. No `/panel/markets` polling
2. WS frames with `channel: 'markets'`
3. Markets panel updates

**Step 5: Commit**

```bash
git add src/app/data-loader.ts
git commit -m "feat(markets): migrate from polling to WebSocket push"
```

---

## Task 6: Convert GDELT Polling to WebSocket Push

**Files:**
- Modify: `src/app/data-loader.ts` (gdelt-related methods)
- Test: Manual verification

**Step 1: Remove GDELT polling**

```typescript
// BEFORE (remove):
this.ctx.refreshScheduler.scheduleRefresh(
  'gdelt',
  () => this.loadGdeltData(),
  180_000 // 180s
);
```

**Step 2: Subscribe to WebSocket**

```typescript
relaySubscribe('gdelt', (payload) => {
  this.renderGdeltData(payload);
});
```

**Step 3: Hydration fallback**

```typescript
const hydrated = getHydratedData('gdelt');
if (hydrated) {
  this.renderGdeltData(hydrated);
  return;
}
const panelData = await fetchRelayPanel('gdelt');
if (panelData) this.renderGdeltData(panelData);
```

**Step 4: Manual test**

1. No `/gdelt` polling
2. WS frames with `channel: 'gdelt'`

**Step 5: Commit**

```bash
git add src/app/data-loader.ts
git commit -m "feat(gdelt): migrate from polling to WebSocket push"
```

---

## Task 7: Convert OREF Alerts Polling to WebSocket Push

**Files:**
- Modify: `src/app/data-loader.ts` (oref-related methods)
- Modify: `src/services/oref-alerts.ts` (remove `startOrefPolling`)
- Test: Manual verification

**Step 1: Remove OREF polling calls**

In `data-loader.ts`:

```typescript
// BEFORE (remove):
import { startOrefPolling, stopOrefPolling } from '@/services/oref-alerts';
// ... later:
startOrefPolling((alerts) => this.renderOrefAlerts(alerts));

// AFTER: Remove polling import and calls
```

**Step 2: Subscribe to WebSocket**

```typescript
relaySubscribe('oref', (payload) => {
  this.renderOrefAlerts(payload);
});
```

**Step 3: Hydration fallback**

```typescript
const hydrated = getHydratedData('oref');
if (hydrated) {
  this.renderOrefAlerts(hydrated);
  return;
}
const panelData = await fetchRelayPanel('oref');
if (panelData) this.renderOrefAlerts(panelData);
```

**Step 4: Mark `startOrefPolling` as deprecated**

In `src/services/oref-alerts.ts`:

```typescript
/**
 * @deprecated Use relay WebSocket push instead
 */
export function startOrefPolling(...) {
  console.warn('startOrefPolling is deprecated - use relay push');
  // Keep implementation for backward compat if needed
}
```

**Step 5: Manual test**

1. No `/api/oref-alerts` polling
2. WS frames with `channel: 'oref'`
3. OREF alerts panel updates immediately

**Step 6: Commit**

```bash
git add src/app/data-loader.ts src/services/oref-alerts.ts
git commit -m "feat(oref): migrate from polling to WebSocket push"
```

---

## Task 8: Convert Polymarket Polling to WebSocket Push

**Files:**
- Modify: `src/app/data-loader.ts` (polymarket/predictions)
- Modify: `src/services/prediction/index.ts` (remove proxy URL usage)
- Test: Manual verification

**Step 1: Remove polymarket polling**

```typescript
// BEFORE (remove):
this.ctx.refreshScheduler.scheduleRefresh(
  'polymarket',
  () => this.loadPolymarketData(),
  180_000
);
```

**Step 2: Subscribe to WebSocket**

```typescript
relaySubscribe('polymarket', (payload) => {
  this.renderPolymarketData(payload);
});
```

**Step 3: Hydration fallback**

```typescript
const hydrated = getHydratedData('polymarket');
if (hydrated) {
  this.renderPolymarketData(hydrated);
  return;
}
const panelData = await fetchRelayPanel('polymarket');
if (panelData) this.renderPolymarketData(panelData);
```

**Step 4: Remove direct proxy URL usage**

In `src/services/prediction/index.ts`:

```typescript
// BEFORE:
const POLYMARKET_PROXY_URL = '/api/polymarket';
// OR: wsRelayUrl.replace(...) + '/polymarket'

// AFTER: Remove - all data comes via relay WebSocket
// Keep only for fallback or manual refresh if needed
```

**Step 5: Manual test**

1. No `/api/polymarket` or `/polymarket` polling
2. WS frames with `channel: 'polymarket'`

**Step 6: Commit**

```bash
git add src/app/data-loader.ts src/services/prediction/index.ts
git commit -m "feat(polymarket): migrate from polling to WebSocket push"
```

---

## Task 9: Convert Remaining Channels (Batch)

**Files:**
- Modify: `src/app/data-loader.ts` (earthquakes, fires, cyber, climate, protests, cables, gps-jamming, advisories, telegram)
- Test: Manual verification per channel

**Step 1: Identify remaining polled channels**

```bash
grep -n "scheduleRefresh\|registerDeferred" src/app/data-loader.ts | grep -E "earthquake|fire|cyber|climate|protest|cable|gps|advisor|telegram"
```

**Step 2: Batch convert each channel**

For each channel (earthquakes, fires, cyber, climate, protests, cables, gps-jamming, advisories, telegram):

```typescript
// Remove polling:
// this.ctx.refreshScheduler.scheduleRefresh('CHANNEL', ...)

// Add WebSocket subscription:
relaySubscribe('CHANNEL', (payload) => {
  this.renderCHANNELData(payload);
});

// Hydration fallback:
const hydrated = getHydratedData('CHANNEL');
if (hydrated) {
  this.renderCHANNELData(hydrated);
  return;
}
const panelData = await fetchRelayPanel('CHANNEL');
if (panelData) this.renderCHANNELData(panelData);
```

**Step 3: Manual test each channel**

For each:
1. Verify no HTTP polling in DevTools Network tab
2. Verify WS `wm-push` messages with correct `channel` field
3. Verify panel renders and updates

**Step 4: Commit per channel or batch commit**

```bash
git add src/app/data-loader.ts
git commit -m "feat(relay): migrate earthquakes, fires, cyber, climate, protests to WebSocket push"

git add src/app/data-loader.ts
git commit -m "feat(relay): migrate cables, gps-jamming, advisories, telegram to WebSocket push"
```

---

## Task 10: Remove RSS Proxy Polling

**Files:**
- Modify: `src/services/security-advisories.ts`
- Modify: `src/services/relay-http.ts` (optional: deprecate `relayRssUrl`)
- Test: Manual verification

**Step 1: Check current RSS proxy usage**

```bash
grep -rn "relayRssUrl\|/rss\?" src/services/
```

Expected: `security-advisories.ts` and possibly others

**Step 2: Convert RSS feeds to relay channel**

If `security-advisories` is a relay channel:

```typescript
// BEFORE:
async function fetchSecurityAdvisories() {
  const url = relayRssUrl('https://...');
  const resp = await fetch(url);
  // parse RSS
}

// AFTER: Use relay panel
async function fetchSecurityAdvisories() {
  return await fetchRelayPanel<AdvisoryData>('advisories');
}
```

If RSS polling is still needed for non-relay feeds, keep it but document:

```typescript
/**
 * Fetches RSS feed via relay proxy.
 * NOTE: For relay channels, prefer fetchRelayPanel() + WebSocket push.
 * This is for non-relay RSS feeds only.
 */
export function relayRssUrl(feedUrl: string): string {
  return `${RELAY_HTTP_BASE}/rss?url=${encodeURIComponent(feedUrl)}`;
}
```

**Step 3: Manual test**

1. Verify advisories panel loads
2. No unnecessary `/rss?url=...` polling

**Step 4: Commit**

```bash
git add src/services/security-advisories.ts src/services/relay-http.ts
git commit -m "refactor(rss): migrate advisories to relay panel endpoint"
```

---

## Task 11: Add Comprehensive Fallback Logic

**Files:**
- Modify: `src/app/data-loader.ts` (add unified fallback helper)
- Test: Manual test with relay disconnected

**Step 1: Create unified fallback helper**

Add to `data-loader.ts`:

```typescript
/**
 * Unified data loading pattern:
 * 1. Try hydrated data from bootstrap (instant)
 * 2. If not available, fetch from /panel/:channel (fallback)
 * 3. Subscribe to WebSocket for real-time updates
 */
private async loadChannelWithFallback<T>(
  channel: string,
  renderFn: (data: T) => void
): Promise<void> {
  // Phase 1: Hydration (from bootstrap)
  const hydrated = getHydratedData(channel);
  if (hydrated) {
    renderFn(hydrated as T);
    return;
  }

  // Phase 2: Fallback fetch
  const panelData = await fetchRelayPanel<T>(channel);
  if (panelData) {
    renderFn(panelData);
  }
}
```

**Step 2: Refactor all channel loads to use helper**

```typescript
// BEFORE:
const hydrated = getHydratedData('aviation');
if (hydrated) {
  this.renderAviationData(hydrated);
  return;
}
const panelData = await fetchRelayPanel('aviation');
if (panelData) this.renderAviationData(panelData);

// AFTER:
await this.loadChannelWithFallback('aviation', (data) => this.renderAviationData(data));
```

Apply to all migrated channels (aviation, markets, gdelt, oref, polymarket, earthquakes, fires, cyber, climate, protests, cables, gps-jamming, advisories, telegram).

**Step 3: Manual test fallback**

1. Disconnect relay WebSocket (simulate network issue)
2. Reload page
3. Verify panels still load from bootstrap cache OR /panel/:channel fallback
4. Reconnect WebSocket
5. Verify real-time updates resume

**Step 4: Commit**

```bash
git add src/app/data-loader.ts
git commit -m "feat(relay): add unified fallback for offline/degraded mode"
```

---

## Task 12: Remove Unused Polling Infrastructure

**Files:**
- Modify: `src/app/data-loader.ts` (clean up old imports and methods)
- Test: `npm run build` (verify no TypeScript errors)

**Step 1: Identify unused imports**

```bash
# In data-loader.ts, search for imports that are no longer used
grep -E "import.*from '@/services/(oref-alerts|prediction|military-flights|gdelt-intel)'" src/app/data-loader.ts
```

**Step 2: Remove or deprecate unused methods**

If `loadAviationData()`, `loadMarketsData()`, etc. are no longer called:

```typescript
// Option 1: Delete method entirely
// Option 2: Keep as private fallback with comment
/**
 * @deprecated Now handled by WebSocket push + bootstrap
 * Kept for manual refresh scenarios
 */
private async loadAviationData() {
  // ...
}
```

**Step 3: Run build to verify**

```bash
npm run build
```

Expected: No TypeScript errors, no unused imports warnings

**Step 4: Commit**

```bash
git add src/app/data-loader.ts
git commit -m "refactor: remove unused polling infrastructure"
```

---

## Task 13: Update Environment Variables Documentation

**Files:**
- Modify: `.env.example` (if it exists)
- Create/Update: `docs/environment-variables.md`

**Step 1: Document required env vars**

Create or update docs:

```markdown
# Environment Variables

## Relay Configuration

### `VITE_RELAY_HTTP_URL` (required)
HTTP base URL for relay gateway.
Example: `https://relay.5ls.us`

### `VITE_WS_RELAY_URL` (required)
WebSocket URL for real-time push.
Example: `wss://relay.5ls.us`

### `VITE_WS_RELAY_TOKEN` (optional)
Authentication token for relay WebSocket.
If set, appended as `?token=...` to WebSocket URL.

## Migration Notes

All data channels now use:
1. `/bootstrap?channels=...` for initial load
2. WebSocket `wm-subscribe` for real-time updates
3. `/panel/:channel` as fallback

No more per-channel polling!
```

**Step 2: Update `.env.example` if exists**

```bash
# Relay Gateway (required)
VITE_RELAY_HTTP_URL=https://relay.5ls.us
VITE_WS_RELAY_URL=wss://relay.5ls.us
VITE_WS_RELAY_TOKEN=your-optional-token-here
```

**Step 3: Commit**

```bash
git add .env.example docs/environment-variables.md
git commit -m "docs: update relay env vars and migration notes"
```

---

## Task 14: End-to-End Verification

**Files:**
- Test: Manual DevTools inspection
- Document: `docs/verification-checklist.md`

**Step 1: Create verification checklist**

```markdown
# Frontend Relay Migration Verification

## Pre-Deployment Checklist

### Network Tab (HTTP)
- [ ] Single `/bootstrap?channels=...` request on page load
- [ ] No polling to `/panel/aviation`, `/panel/markets`, etc.
- [ ] No requests to `/opensky`, `/polymarket`, `/gdelt`, `/oref`
- [ ] No repeated `/rss?url=...` polling

### WebSocket Tab
- [ ] Single WebSocket connection to relay
- [ ] `wm-subscribe` message sent with all channels: `["aviation","markets","gdelt",...]`
- [ ] `wm-push` messages received with correct `channel` field
- [ ] No disconnects or reconnects under normal conditions

### UI Behavior
- [ ] All panels load on page load (from bootstrap or fallback)
- [ ] Panels update in real-time (via WebSocket push)
- [ ] No visible polling spinners or repeated fetches
- [ ] Graceful degradation if WebSocket unavailable (uses /panel fallback)

### Performance
- [ ] Page load time improved (fewer HTTP requests)
- [ ] Network waterfall shows parallel bootstrap + WebSocket init
- [ ] No request storms or rate limiting

### Edge Cases
- [ ] Reload page while offline: panels load from IndexedDB cache
- [ ] Disconnect WebSocket mid-session: fallback /panel requests work
- [ ] Reconnect WebSocket: `wm-subscribe` re-sent, updates resume
```

**Step 2: Manual verification**

Open DevTools and verify every item in checklist.

**Step 3: Screenshot evidence**

Take screenshots of:
1. Network tab showing single `/bootstrap` request
2. WebSocket messages tab showing `wm-subscribe` and `wm-push` frames
3. No polling in Network tab (filter by "panel", "opensky", "polymarket")

**Step 4: Commit checklist**

```bash
git add docs/verification-checklist.md
git commit -m "docs: add end-to-end verification checklist"
```

---

## Task 15: Update Tests (If Applicable)

**Files:**
- Search: `**/*.test.ts`, `**/*.spec.ts` for polling tests
- Modify: Update tests to mock WebSocket instead of fetch polling
- Test: `npm test`

**Step 1: Search for tests mocking polling**

```bash
find src -name "*.test.ts" -o -name "*.spec.ts" | xargs grep -l "fetchRelayPanel\|scheduleRefresh"
```

**Step 2: Update tests to mock WebSocket**

If tests exist, update them:

```typescript
// BEFORE: Mock fetch polling
jest.mock('@/services/relay-http', () => ({
  fetchRelayPanel: jest.fn().mockResolvedValue({ data: 'mock' })
}));

// AFTER: Mock WebSocket push
jest.mock('@/services/relay-push', () => ({
  subscribe: jest.fn((channel, handler) => {
    // Simulate push after delay
    setTimeout(() => handler({ data: 'mock' }), 100);
    return () => {}; // unsubscribe
  }),
  initRelayPush: jest.fn()
}));
```

**Step 3: Run tests**

```bash
npm test
```

Expected: All tests pass with new WebSocket mocks

**Step 4: Commit**

```bash
git add src/**/*.test.ts
git commit -m "test: update mocks for WebSocket push migration"
```

---

## Task 16: Final Cleanup and Documentation

**Files:**
- Update: `README.md` or `docs/architecture.md`
- Remove: Any dead code from previous tasks
- Test: Final `npm run build && npm run dev`

**Step 1: Update architecture docs**

In `docs/architecture.md` or equivalent:

```markdown
## Data Flow (Post-Migration)

### Initial Page Load
1. User loads app
2. `bootstrap.ts` fetches `/bootstrap?channels=...` (all relay channels)
3. Data cached in IndexedDB for next visit
4. Panels hydrate from bootstrap data (instant render)

### Real-Time Updates
1. `relay-push.ts` establishes WebSocket connection
2. Sends `wm-subscribe` with all channel names
3. Relay gateway broadcasts updates via `wm-push` messages
4. Panels re-render with new data (no polling)

### Fallback (Offline/Degraded)
1. If bootstrap fails: load from IndexedDB cache (stale data)
2. If WebSocket unavailable: fallback to `/panel/:channel` polling (rare)
3. If both fail: show "Offline" indicator

### Performance Wins
- **Before:** N channels × M polls/minute = 100s of HTTP requests/min
- **After:** 1 bootstrap + 1 WebSocket = ~2 connections total
- **Latency:** Push updates < 500ms vs polling 30-180s intervals
```

**Step 2: Remove dead code**

Search for:
- Unused `scheduleRefresh` calls
- Commented-out polling code
- Deprecated methods marked in previous tasks

Delete or finalize deprecation.

**Step 3: Final build and smoke test**

```bash
npm run build
npm run dev
```

1. Open in browser
2. Run through verification checklist (Task 14)
3. Test on mobile device (if applicable)
4. Verify production build works

**Step 4: Final commit**

```bash
git add README.md docs/architecture.md src/**/*.ts
git commit -m "docs: finalize relay migration architecture"
```

---

## Summary

**16 tasks total:**
1. ✅ Audit current polling channels
2. ✅ Extend bootstrap to request all channels
3. ✅ Initialize WebSocket with all channels
4. ✅ Migrate aviation polling
5. ✅ Migrate markets polling
6. ✅ Migrate GDELT polling
7. ✅ Migrate OREF polling
8. ✅ Migrate polymarket polling
9. ✅ Migrate remaining channels (batch)
10. ✅ Remove RSS proxy polling
11. ✅ Add unified fallback logic
12. ✅ Clean up unused polling infrastructure
13. ✅ Update environment docs
14. ✅ End-to-end verification
15. ✅ Update tests (if applicable)
16. ✅ Final cleanup and docs

**Expected Outcome:**
- Zero per-channel HTTP polling
- Single `/bootstrap` call on page load
- Single WebSocket connection for all real-time updates
- Fallback to `/panel/:channel` only if WebSocket unavailable
- Improved performance and reduced network load
- Graceful offline behavior via IndexedDB cache

**Verification:**
- Open DevTools → Network tab
- Reload page
- Confirm: 1 `/bootstrap` request, 1 WebSocket connection, 0 polling requests
- Confirm: Real-time updates via `wm-push` WebSocket frames
