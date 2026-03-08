# Source Code Review Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix ~90 issues found in deep code review of `src/` — critical bugs, memory leaks, XSS, silent errors, type safety, performance, and architecture.

**Architecture:** Incremental fixes across `src/`, organized into 6 phases. No structural rewrites — each task is a scoped fix with a commit.

**Tech Stack:** TypeScript, Vite, vanilla DOM

---

## Phase 1: Critical Bugs (fix immediately)

### Task 1: Fix `loadFredData` loading spinner never stopping

**Files:**
- Modify: `src/app/data-loader.ts:1515-1557`

**Context:** `loadFredData` calls `economicPanel.setLoading(true)` but never calls `setLoading(false)` on the success path. The loading spinner stays forever.

**Step 1: Find all exit paths**

Search for `setLoading` in `loadFredData`. Add `setLoading(false)` before every successful `return` and in the success path after `renderFredData`.

```typescript
// After renderFredData succeeds:
economicPanel?.setLoading(false);
```

Also add it in a `finally` or ensure it's called on error paths too:

```typescript
async loadFredData(): Promise<void> {
  const economicPanel = this.ctx.panels['economic'] as EconomicPanel | undefined;
  economicPanel?.setLoading(true);
  try {
    // ... existing fetch and render logic ...
    economicPanel?.setLoading(false);
  } catch (err) {
    console.warn('[DataLoader] FRED data failed:', err);
    economicPanel?.setLoading(false);
  }
}
```

**Step 2: Build check**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/app/data-loader.ts
git commit -m "fix: clear loading spinner in loadFredData on all paths"
```

---

### Task 2: Fix OREF callback accumulation (memory leak + duplicate processing)

**Files:**
- Modify: `src/app/data-loader.ts:1077-1086`

**Context:** `onOrefAlertsUpdate` is called every time `loadIntelligenceSignals` runs, pushing a new callback into a global array. Callbacks are never removed until `destroy()` calls `stopOrefPolling`. If `loadIntelligenceSignals` runs N times, N duplicate callbacks fire on every OREF update.

**Step 1: Register the OREF callback only once**

Move the `onOrefAlertsUpdate` registration out of `loadIntelligenceSignals` and into `init()`, or add a guard:

```typescript
private orefCallbackRegistered = false;

// In loadIntelligenceSignals:
if (!this.orefCallbackRegistered) {
  this.orefCallbackRegistered = true;
  onOrefAlertsUpdate((alerts) => {
    // existing callback logic
  });
}
```

**Step 2: Build check**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/app/data-loader.ts
git commit -m "fix: prevent OREF callback accumulation in loadIntelligenceSignals"
```

---

### Task 3: Fix XSS in LiveNewsPanel channel names

**Files:**
- Modify: `src/components/LiveNewsPanel.ts:979-984, 994-999`

**Context:** `showOfflineMessage()` and `showEmbedError()` interpolate `channel.name` into `innerHTML` without escaping. Channel names come from storage or relay API.

**Step 1: Import and apply escapeHtml**

```typescript
import { escapeHtml } from '@/utils/sanitize';

// In showOfflineMessage:
this.content.innerHTML = `
  ...
  <div class="offline-text">${escapeHtml(t('components.liveNews.notLive', { name: escapeHtml(channel.name) }))}</div>
  ...
`;
```

Apply the same pattern to `showEmbedError`.

**Step 2: Build check**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/components/LiveNewsPanel.ts
git commit -m "fix: escape channel names in LiveNewsPanel innerHTML to prevent XSS"
```

---

### Task 4: Fix SummarizeViewModal event listener leak

**Files:**
- Modify: `src/components/SummarizeViewModal.ts`

**Context:** `showRelayData()` adds a `wm:panel-summary-updated` listener that removes itself only when the event fires. If the modal closes before data arrives, the listener stays attached to `document` permanently.

**Step 1: Store handler reference and clean up on hide**

```typescript
private relayHandler: ((e: Event) => void) | null = null;

showRelayData(): void {
  this.removeRelayHandler(); // Clean up any previous listener
  this.relayHandler = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail?.summary) {
      void this.setContent(/* ... */);
      this.removeRelayHandler();
    }
  };
  document.addEventListener('wm:panel-summary-updated', this.relayHandler);
}

hide(): void {
  this.removeRelayHandler();
  // ... rest of hide
}

private removeRelayHandler(): void {
  if (this.relayHandler) {
    document.removeEventListener('wm:panel-summary-updated', this.relayHandler);
    this.relayHandler = null;
  }
}
```

**Step 2: Build check**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/components/SummarizeViewModal.ts
git commit -m "fix: clean up relay event listener when SummarizeViewModal closes"
```

---

### Task 5: Fix WorldClockPanel and LiveNewsPanel drag listener leaks

**Files:**
- Modify: `src/components/WorldClockPanel.ts:243-278`
- Modify: `src/components/LiveNewsPanel.ts:600-631`

**Context:** Both components add `document.addEventListener('mousemove'/'mouseup', ...)` for drag behavior but never remove them in `destroy()`.

**Step 1: Store handler references and clean up**

In each component, store the drag `mousemove` and `mouseup` handlers as instance properties. Remove them in `destroy()`:

```typescript
destroy(): void {
  if (this.boundDragMouseMove) document.removeEventListener('mousemove', this.boundDragMouseMove);
  if (this.boundDragMouseUp) document.removeEventListener('mouseup', this.boundDragMouseUp);
  super.destroy();
}
```

**Step 2: Build check**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/components/WorldClockPanel.ts src/components/LiveNewsPanel.ts
git commit -m "fix: clean up document-level drag listeners in WorldClockPanel and LiveNewsPanel"
```

---

### Task 6: Add validation for `applyNewsSources` payload

**Files:**
- Modify: `src/services/feed-client.ts:184-192`

**Context:** `applyNewsSources(payload)` casts `payload` to `NewsSourceRow[]` without any validation. A malicious or buggy relay push could break the app or inject bad feed URLs.

**Step 1: Add runtime validation**

```typescript
export function applyNewsSources(payload: unknown): void {
  if (!Array.isArray(payload)) {
    console.warn('[feed-client] applyNewsSources: payload is not an array');
    return;
  }
  const validated = payload.filter(
    (p): p is NewsSourceRow =>
      p != null &&
      typeof p === 'object' &&
      typeof (p as Record<string, unknown>).name === 'string' &&
      typeof (p as Record<string, unknown>).url === 'string'
  );
  if (validated.length === 0 && payload.length > 0) {
    console.warn('[feed-client] applyNewsSources: all entries failed validation');
    return;
  }
  _sources = validated;
  buildFeedsFromSources();
}
```

**Step 2: Build check**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/services/feed-client.ts
git commit -m "fix: validate applyNewsSources payload before applying"
```

---

### Task 7: Add path/URL validation to relay-http

**Files:**
- Modify: `src/services/relay-http.ts`

**Context:** `channel` and `layer` are interpolated into URL paths (`/panel/${channel}`, `/map/${layer}`) with no validation. `relayRssUrl` builds proxy URLs from `feedUrl` with no scheme/host validation.

**Step 1: Validate channel/layer params**

```typescript
const SAFE_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export async function fetchRelayPanel<T = unknown>(channel: string): Promise<T | null> {
  if (!SAFE_SLUG_RE.test(channel)) {
    console.warn(`[relay-http] invalid channel: ${channel}`);
    return null;
  }
  // ... rest unchanged
}

export async function fetchRelayMap<T = unknown>(layer: string): Promise<T | null> {
  if (!SAFE_SLUG_RE.test(layer)) {
    console.warn(`[relay-http] invalid layer: ${layer}`);
    return null;
  }
  // ... rest unchanged
}
```

**Step 2: Validate relayRssUrl feed URL**

```typescript
export function relayRssUrl(feedUrl: string): string {
  try {
    const u = new URL(feedUrl);
    if (!['http:', 'https:'].includes(u.protocol)) {
      throw new Error(`Invalid feed URL protocol: ${u.protocol}`);
    }
  } catch (e) {
    console.warn('[relay-http] invalid feed URL:', feedUrl);
    throw e;
  }
  return `${RELAY_HTTP_BASE}/rss?url=${encodeURIComponent(feedUrl)}`;
}
```

**Step 3: Build check**

Run: `npx tsc --noEmit`

**Step 4: Commit**

```bash
git add src/services/relay-http.ts
git commit -m "fix: validate channel/layer/feedUrl params in relay-http"
```

---

### Task 8: Fix `mapConflictPayload` brittle Map pattern

**Files:**
- Modify: `src/services/conflict/index.ts:410`

**Context:** The expression `(byCountry.get(event.country) ?? byCountry.set(event.country, []).get(event.country)!).push(event)` works but is fragile and relies on chained side effects.

**Step 1: Replace with clear pattern**

```typescript
let existing = byCountry.get(event.country);
if (!existing) {
  existing = [];
  byCountry.set(event.country, existing);
}
existing.push(event);
```

**Step 2: Build check**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/services/conflict/index.ts
git commit -m "fix: simplify mapConflictPayload Map access pattern"
```

---

## Phase 2: High-Severity Issues

### Task 9: Add optional chaining for panel render calls

**Files:**
- Modify: `src/app/data-loader.ts` (lines 741, 756, 1743-1744, 2220, 2234, 2248, 2263)

**Context:** Multiple panel render calls use direct property access without optional chaining. If a panel is not configured for the current variant, accessing `.renderResults`, `.renderHeatmap`, etc. throws.

**Step 1: Add `?.` to all panel render calls**

Find every line that casts a panel and calls a method on it. Add `?.` before the method call:

```typescript
// Before:
(this.ctx.panels['heatmap'] as HeatmapPanel).renderHeatmap(data);
// After:
(this.ctx.panels['heatmap'] as HeatmapPanel | undefined)?.renderHeatmap(data);

// Before:
monitorPanel.renderResults(this.ctx.allNews);
// After:
monitorPanel?.renderResults(this.ctx.allNews);
```

**Step 2: Build check**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/app/data-loader.ts
git commit -m "fix: add optional chaining for panel render calls in data-loader"
```

---

### Task 10: Fix stale panel data when payloads are empty

**Files:**
- Modify: `src/app/data-loader.ts` (applyUcdpEvents ~line 2414, applyConflict ~line 2132, applyClimate ~line 2115)

**Context:** When API returns valid but empty data (e.g. `data.length === 0`), these methods return early without clearing the panel. The panel keeps showing old stale data.

**Step 1: Clear panels on valid empty data**

```typescript
// In applyUcdpEvents:
if (result.success && result.data.length === 0) {
  ucdpPanel?.setEvents([]);
  return;
}

// In applyConflict:
if (data.count === 0) {
  conflictPanel?.setEvents([]);
  return;
}

// In applyClimate:
if (anomalies.length === 0) {
  climatePanel?.setAnomalies([]);
  return;
}
```

**Step 2: Build check**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/app/data-loader.ts
git commit -m "fix: clear panel data when API returns valid empty results"
```

---

### Task 11: Guard `initMilitaryVesselStream` against double-init

**Files:**
- Modify: `src/app/data-loader.ts` (find `initMilitaryVesselStream` call sites)
- Modify: `src/services/military-vessels.ts`

**Context:** `initMilitaryVesselStream()` can be called from multiple load paths. If called twice, it creates duplicate streams and intervals.

**Step 1: Add idempotency guard**

In `src/services/military-vessels.ts`, add:

```typescript
let initialized = false;

export function initMilitaryVesselStream(): void {
  if (initialized) return;
  initialized = true;
  // ... existing logic
}
```

**Step 2: Build check**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/services/military-vessels.ts
git commit -m "fix: guard initMilitaryVesselStream against duplicate initialization"
```

---

### Task 12: Fix military interval cleanup

**Files:**
- Modify: `src/services/military-flights.ts:377-379`
- Modify: `src/services/military-vessels.ts:419-421`

**Context:** `setInterval(cleanupFlightHistory, ...)` and `setInterval(cleanup, ...)` are never cleared. In SPAs with hot-reload, this creates multiple intervals.

**Step 1: Store interval IDs and add cleanup functions**

```typescript
let cleanupIntervalId: ReturnType<typeof setInterval> | null = null;

export function initMilitaryFlights(): void {
  if (!cleanupIntervalId) {
    cleanupIntervalId = setInterval(cleanupFlightHistory, HISTORY_CLEANUP_INTERVAL);
  }
}

export function destroyMilitaryFlights(): void {
  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
  }
}
```

Apply the same pattern to `military-vessels.ts`.

**Step 2: Wire destroy functions into App.destroy()**

Ensure `destroyMilitaryFlights()` and `destroyMilitaryVessels()` are called in the app's teardown.

**Step 3: Build check**

Run: `npx tsc --noEmit`

**Step 4: Commit**

```bash
git add src/services/military-flights.ts src/services/military-vessels.ts
git commit -m "fix: store and cleanup military service intervals on destroy"
```

---

### Task 13: Add missing `destroy()` methods to components

**Files:**
- Modify: `src/components/MobileWarningModal.ts`
- Modify: `src/components/PlaybackControl.ts`
- Modify: `src/components/SignalModal.ts`
- Modify: `src/components/SearchModal.ts`

**Step 1: Add destroy() to each**

Each component needs a `destroy()` that:
- Removes the component element from DOM
- Removes any document-level event listeners
- Clears any stored references

For `SignalModal`: the `escHandler` is removed in `hide()` but not if the modal is torn down without hiding. `destroy()` should call `hide()` first, then remove the element.

For `PlaybackControl`: remove all element listeners.

For `SearchModal`: call `close()` and remove the overlay.

For `MobileWarningModal`: remove the element and any listeners.

**Step 2: Build check**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/components/MobileWarningModal.ts src/components/PlaybackControl.ts src/components/SignalModal.ts src/components/SearchModal.ts
git commit -m "fix: add destroy() methods to modal and control components"
```

---

### Task 14: Fix VirtualList ResizeObserver leak

**Files:**
- Modify: `src/components/VirtualList.ts`

**Step 1: Store and disconnect ResizeObserver**

```typescript
private resizeObserver: ResizeObserver | null = null;

// In constructor or init:
this.resizeObserver = new ResizeObserver(...);
this.resizeObserver.observe(this.element);

// In destroy:
destroy(): void {
  this.resizeObserver?.disconnect();
  this.resizeObserver = null;
  // ... rest
}
```

**Step 2: Build check**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/components/VirtualList.ts
git commit -m "fix: disconnect ResizeObserver in VirtualList.destroy()"
```

---

### Task 15: Add fetch timeouts to services missing them

**Files:**
- Modify: `src/services/weather.ts`
- Modify: `src/services/gdacs.ts`
- Modify: `src/services/eonet.ts`
- Modify: `src/services/military-flights.ts`
- Modify: `src/services/maritime/index.ts`

**Step 1: Add `AbortSignal.timeout()` to each fetch**

```typescript
const response = await fetch(url, {
  headers: { /* existing */ },
  signal: AbortSignal.timeout(15_000),
});
```

Apply to all fetch calls in these files that lack a timeout.

**Step 2: Build check**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/services/weather.ts src/services/gdacs.ts src/services/eonet.ts src/services/military-flights.ts src/services/maritime/index.ts
git commit -m "fix: add AbortSignal.timeout to fetch calls in weather, GDACS, EONET, military, maritime"
```

---

### Task 16: Add response shape validation for external APIs

**Files:**
- Modify: `src/services/gdacs.ts:65`
- Modify: `src/services/weather.ts:47`
- Modify: `src/services/eonet.ts:125`
- Modify: `src/services/usa-spending.ts:113`

**Step 1: Validate response structure before use**

```typescript
const data = await response.json();
if (!data || !Array.isArray(data.features)) {
  console.warn('[GDACS] Invalid response structure');
  return [];
}
```

Apply the same pattern for each API: check the expected top-level property exists and is the right type.

**Step 2: Build check**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/services/gdacs.ts src/services/weather.ts src/services/eonet.ts src/services/usa-spending.ts
git commit -m "fix: validate external API response shapes before use"
```

---

## Phase 3: Observability (silent error handling)

### Task 17: Add logging to all silent catch blocks in data-loader.ts

**Files:**
- Modify: `src/app/data-loader.ts`

**Context:** 15+ empty `catch {}` blocks hide failures. Add `console.warn('[DataLoader] <context>:', err)` to each.

**Step 1: Find and fix all empty catches**

Run: `grep -n 'catch.*{.*}' src/app/data-loader.ts` and replace each empty catch with a logged one.

Lines to fix: 205, 216, 674, 785, 842, 890, 913, 924, 947, 963, 1215, 1233, 1260, 1324, 1354, 1385, 1427, 1444, 1553, 1796, 1836, 1985, 2088, 2160, 2194.

Keep `setSourcesReady` (line 185) intentionally silent.

**Step 2: Build check**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/app/data-loader.ts
git commit -m "fix: add logging to 25 silent catch blocks in data-loader.ts"
```

---

### Task 18: Add logging to silent catches in App.ts, main.ts, relay-http.ts

**Files:**
- Modify: `src/App.ts`
- Modify: `src/main.ts`
- Modify: `src/services/relay-http.ts`

**Context:** Consolidate the fixes from the original plan Tasks 3, 5, 6.

**Step 1: App.ts — add logging to ML worker catches**

Replace all `.catch(() => {})` with `.catch((e) => console.warn('[App] ...:', e))`.

**Step 2: main.ts — add logging to SW registration**

```typescript
.catch((e) => console.warn('[PWA] SW registration failed:', e));
```

**Step 3: relay-http.ts — log fetch failures**

```typescript
} catch (e) {
  console.warn(`[relay-http] fetchRelayPanel(${channel}) failed:`, e);
  return null;
}
```

**Step 4: Build check**

Run: `npx tsc --noEmit`

**Step 5: Commit**

```bash
git add src/App.ts src/main.ts src/services/relay-http.ts
git commit -m "fix: add logging to silent catches in App, main, relay-http"
```

---

### Task 19: Add logging to silent catches across services

**Files:**
- Modify: `src/services/economic/index.ts`
- Modify: `src/services/supply-chain/index.ts`
- Modify: `src/services/trade/index.ts`
- Modify: `src/services/bootstrap.ts`
- Modify: `src/services/maritime/index.ts`

**Context:** 20+ `catch { return null }` blocks across service files hide errors.

**Step 1: Add logging to each**

For every `catch { return null }` or `catch { return [] }`, add:
```typescript
catch (err) {
  console.warn('[ServiceName] operation failed:', err);
  return null;
}
```

**Step 2: Build check**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/services/economic/index.ts src/services/supply-chain/index.ts src/services/trade/index.ts src/services/bootstrap.ts src/services/maritime/index.ts
git commit -m "fix: add logging to silent catches across service modules"
```

---

### Task 20: Add logging to component catches

**Files:**
- Modify: `src/components/GulfEconomiesPanel.ts`
- Modify: `src/components/TechEventsPanel.ts`
- Modify: `src/components/GlobalDigestPanel.ts`

**Step 1: Replace empty catches with logged ones**

```typescript
.catch((err) => { console.warn('[GulfEconomiesPanel] fetch error:', err); });
```

**Step 2: Build check**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/components/GulfEconomiesPanel.ts src/components/TechEventsPanel.ts src/components/GlobalDigestPanel.ts
git commit -m "fix: add logging to silent catches in panel components"
```

---

## Phase 4: Type Safety & Correctness

### Task 21: Fix sourcesReady wiring

**Files:**
- Modify: `src/App.ts:455-461`

**Context:** `sourcesReady` is `Promise.resolve()`, making the 3s race in data-loader meaningless.

**Step 1: Capture promises**

```typescript
const sourcesPromise = loadNewsSources();
const flagsPromise = loadFeatureFlags();
const sourcesReady = Promise.all([sourcesPromise, flagsPromise]);
this.dataLoader.setSourcesReady(sourcesReady);
```

Verify `loadNewsSources` and `loadFeatureFlags` return promises (they're async, so they do).

**Step 2: Build check**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/App.ts
git commit -m "fix: wire sourcesReady to actual loadNewsSources/loadFeatureFlags promises"
```

---

### Task 22: Define typed relay push handler interfaces

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/App.ts:639-685`

**Context:** `setupRelayPush()` uses `as any` 12+ times. Define interfaces and use runtime `'method' in obj` checks.

**Step 1: Define handler interfaces in types**

```typescript
export interface AiDigestHandler { applyAiDigest(payload: unknown): void; }
export interface AiAnalysisHandler { applyAiAnalysis(payload: unknown): void; }
export interface InstabilityAnalysisHandler { applyInstabilityAnalysis(payload: unknown): void; }
export interface AiOverviewHandler { applyAiOverview(payload: unknown): void; }
export interface PushHandler { applyPush(payload: unknown): void; }
```

**Step 2: Replace `as any` with type guards**

```typescript
subscribeRelayPush('ai:intel-digest', (payload) => {
  const panel = this.state.panels['global-digest'];
  if (panel && 'applyAiDigest' in panel) {
    (panel as AiDigestHandler).applyAiDigest(payload);
  }
});
```

**Step 3: Remove eslint-disable comments**

**Step 4: Build check**

Run: `npx tsc --noEmit`

**Step 5: Commit**

```bash
git add src/types/index.ts src/App.ts
git commit -m "refactor: replace any casts with typed relay push handler interfaces"
```

---

### Task 23: Fix duplicate fullscreen icon

**Files:**
- Modify: `src/app/event-handlers.ts:246`

**Step 1: Use distinct icons**

```typescript
fullscreenBtn.textContent = document.fullscreenElement ? '\u2716' : '\u26F6';
```

**Step 2: Commit**

```bash
git add src/app/event-handlers.ts
git commit -m "fix: use distinct fullscreen/exit-fullscreen icons"
```

---

### Task 24: Replace non-null assertions with null checks

**Files:**
- Modify: `src/admin/login.ts:37-38, 42, 56`
- Modify: `src/components/SummarizeViewModal.ts:40-42`
- Modify: `src/components/PlaybackControl.ts:41-44`
- Modify: `src/components/SignalModal.ts:126, 246`

**Step 1: Replace `!` with null checks and early returns**

For admin login, also clear the password input after use:

```typescript
const btn = container.querySelector<HTMLButtonElement>('#admin-login-btn');
const errEl = container.querySelector<HTMLParagraphElement>('#admin-login-error');
if (!btn || !errEl) return;
```

**Step 2: Build check**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/admin/login.ts src/components/SummarizeViewModal.ts src/components/PlaybackControl.ts src/components/SignalModal.ts
git commit -m "fix: replace non-null assertions with null checks"
```

---

### Task 25: Fix UCDP retry off-by-one

**Files:**
- Modify: `src/app/data-loader.ts:999`

**Context:** UCDP retry uses `attempt < 3` but `attempt` starts at 1, resulting in only 2 retries.

**Step 1: Fix the loop condition**

Change `attempt < 3` to `attempt <= 3` (or `attempt < 4`).

**Step 2: Build check**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/app/data-loader.ts
git commit -m "fix: correct UCDP retry count off-by-one"
```

---

## Phase 5: Performance

### Task 26: Pause header clock when tab is hidden

**Files:**
- Modify: `src/app/event-handlers.ts`

**Step 1: Check `document.hidden` inside tick**

The simplest approach:
```typescript
const tick = () => {
  if (document.hidden) return;
  // existing tick logic
};
```

**Step 2: Commit**

```bash
git add src/app/event-handlers.ts
git commit -m "perf: skip header clock tick when tab is hidden"
```

---

### Task 27: Throttle idle detection listener

**Files:**
- Modify: `src/app/event-handlers.ts:340-354`

**Step 1: Throttle the reset handler**

```typescript
import { throttle } from '@/utils';

// In setupIdleDetection:
this.boundIdleResetHandler = throttle(() => {
  if (this.ctx.isIdle) {
    this.ctx.isIdle = false;
    document.body?.classList.remove('animations-paused');
  }
  this.resetIdleTimer();
}, 2000);
```

**Step 2: Build check**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/app/event-handlers.ts
git commit -m "perf: throttle idle detection to reduce timer churn"
```

---

### Task 28: Fix StrategicRisk/PosturePanel refresh timeout leak

**Files:**
- Modify: `src/components/StrategicRiskPanel.ts`
- Modify: `src/components/StrategicPosturePanel.ts`

**Step 1: Store timeout on instance and clear in destroy()**

```typescript
private refreshTimeout: ReturnType<typeof setTimeout> | null = null;

destroy(): void {
  if (this.refreshTimeout) {
    clearTimeout(this.refreshTimeout);
    this.refreshTimeout = null;
  }
  super.destroy();
}
```

**Step 2: Build check**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/components/StrategicRiskPanel.ts src/components/StrategicPosturePanel.ts
git commit -m "fix: clear refresh timeouts in StrategicRisk/PosturePanel destroy()"
```

---

## Phase 6: Code Quality & Cleanup

### Task 29: Guard debug globals behind DEV check

**Files:**
- Modify: `src/main.ts:251-255`

**Step 1: Wrap in DEV guard**

```typescript
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).geoDebug = {
    cells: debugGetCells,
    count: getCellCount,
  };
}
```

**Step 2: Commit**

```bash
git add src/main.ts
git commit -m "fix: guard debug globals behind import.meta.env.DEV"
```

---

### Task 30: Extract duplicated unhappy layer list

**Files:**
- Modify: `src/config/panels.ts`
- Modify: `src/App.ts:92, 189`

**Step 1: Add shared constant**

```typescript
export const UNHAPPY_LAYERS: readonly (keyof MapLayers)[] = [
  'conflicts', 'bases', 'hotspots', 'nuclear', 'irradiators', 'sanctions',
  'military', 'protests', 'pipelines', 'waterways', 'ais', 'flights',
  'spaceports', 'minerals', 'natural', 'fires', 'outages', 'cyberThreats',
  'weather', 'economic', 'cables', 'datacenters', 'ucdpEvents',
  'displacement', 'climate', 'iranAttacks',
] as const;
```

**Step 2: Import and use in App.ts**

**Step 3: Commit**

```bash
git add src/config/panels.ts src/App.ts
git commit -m "refactor: extract UNHAPPY_LAYERS constant to eliminate duplication"
```

---

### Task 31: Fix localStorage map-height value consistency

**Files:**
- Modify: `src/app/event-handlers.ts` (lines 764, 782, 808)

**Step 1: Store only numeric values**

```typescript
// Line 764:
localStorage.setItem('map-height', String(clamped));
// Line 782:
localStorage.setItem('map-height', String(mapContainer.offsetHeight));
// Line 808:
localStorage.setItem('map-height', String(finalHeight));
```

**Step 2: Commit**

```bash
git add src/app/event-handlers.ts
git commit -m "fix: store numeric map-height in localStorage for consistency"
```

---

### Task 32: Fix maritime polling race condition

**Files:**
- Modify: `src/services/maritime/index.ts:298-333`

**Step 1: Replace boolean flag with promise guard**

```typescript
let pollPromise: Promise<void> | null = null;

async function pollSnapshot(force = false): Promise<void> {
  if (pollPromise && !force) return;
  pollPromise = (async () => {
    try {
      // ... existing logic
    } finally {
      pollPromise = null;
    }
  })();
  return pollPromise;
}
```

**Step 2: Build check**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/services/maritime/index.ts
git commit -m "fix: replace inFlight boolean with promise guard in maritime polling"
```

---

## Phase 7: Event Handler Listener Leaks (Critical)

### Task 33: Clean up window/document listeners in event-handlers.ts destroy()

**Files:**
- Modify: `src/app/event-handlers.ts`

**Context:** `destroy()` does not remove most of the listeners added during init and setup. This causes memory leaks and stale-context bugs if the app is torn down and re-initialized. This is the single largest leak surface in the codebase.

**Step 1: Store all handler references as instance properties**

Add private properties for every handler currently added anonymously:

```typescript
private boundStorageHandler: ((e: StorageEvent) => void) | null = null;
private boundFocalPointsHandler: (() => void) | null = null;
private boundThemeChangedHandler: (() => void) | null = null;
private panelIntersectionObserver: IntersectionObserver | null = null;
private boundMapResizeMove: ((e: MouseEvent) => void) | null = null;
private boundMapResizeUp: (() => void) | null = null;
private boundMapResizeBlur: (() => void) | null = null;
private boundMapResizeVisibility: (() => void) | null = null;
private boundMapWidthResizeMove: ((e: MouseEvent) => void) | null = null;
private boundMapWidthResizeUp: (() => void) | null = null;
private boundWindowResize: (() => void) | null = null;
private boundMapFullscreenEscape: ((e: KeyboardEvent) => void) | null = null;
private boundTvKeydownHandler: ((e: KeyboardEvent) => void) | null = null;
```

**Step 2: Assign handlers instead of inline anonymous functions**

For each `addEventListener` call that currently uses an anonymous function, assign to the stored property first, then pass it.

Example for storage:
```typescript
this.boundStorageHandler = (e: StorageEvent) => {
  if (e.key === STORAGE_KEYS.panels && e.newValue) {
    // ... existing logic
  }
};
window.addEventListener('storage', this.boundStorageHandler);
```

**Step 3: Remove all in destroy()**

```typescript
destroy(): void {
  if (this.boundStorageHandler) window.removeEventListener('storage', this.boundStorageHandler);
  if (this.boundFocalPointsHandler) window.removeEventListener('focal-points-ready', this.boundFocalPointsHandler);
  if (this.boundThemeChangedHandler) window.removeEventListener('theme-changed', this.boundThemeChangedHandler);
  this.panelIntersectionObserver?.disconnect();
  if (this.boundMapResizeMove) document.removeEventListener('mousemove', this.boundMapResizeMove);
  if (this.boundMapResizeUp) document.removeEventListener('mouseup', this.boundMapResizeUp);
  if (this.boundMapResizeBlur) window.removeEventListener('blur', this.boundMapResizeBlur);
  if (this.boundMapResizeVisibility) document.removeEventListener('visibilitychange', this.boundMapResizeVisibility);
  if (this.boundMapWidthResizeMove) document.removeEventListener('mousemove', this.boundMapWidthResizeMove);
  if (this.boundMapWidthResizeUp) document.removeEventListener('mouseup', this.boundMapWidthResizeUp);
  if (this.boundWindowResize) window.removeEventListener('resize', this.boundWindowResize);
  if (this.boundMapFullscreenEscape) document.removeEventListener('keydown', this.boundMapFullscreenEscape);
  if (this.boundTvKeydownHandler) document.removeEventListener('keydown', this.boundTvKeydownHandler);
  // ... existing destroy logic
}
```

**Step 4: Build check**

Run: `npx tsc --noEmit`

**Step 5: Commit**

```bash
git add src/app/event-handlers.ts
git commit -m "fix: clean up all window/document listeners in EventHandlerManager.destroy()"
```

---

### Task 34: Fix map resize dblclick double-fire

**Files:**
- Modify: `src/app/event-handlers.ts:813-816`

**Context:** On map resize handle dblclick, both `transitionend` and `setTimeout(onEnd, 500)` can fire `onEnd`, causing double execution.

**Step 1: Add a guard**

```typescript
let resizeEndFired = false;
const onEnd = () => {
  if (resizeEndFired) return;
  resizeEndFired = true;
  // ... existing onEnd logic
};
mapContainer.addEventListener('transitionend', onEnd, { once: true });
setTimeout(onEnd, 500);
```

**Step 2: Build check**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/app/event-handlers.ts
git commit -m "fix: prevent double-fire on map resize dblclick transition"
```

---

## Phase 8: Admin XSS Fixes (Critical)

### Task 35: Escape API content in admin page innerHTML

**Files:**
- Modify: `src/admin/pages/app-keys.ts`
- Modify: `src/admin/pages/secrets.ts`
- Modify: `src/admin/pages/feature-flags.ts`

**Context:** These admin pages interpolate API data (`k.description`, `s.name`, `s.description`, `f.key`, `f.description`, `strVal`) directly into innerHTML without escaping. XSS risk.

**Step 1: Import escapeHtml**

Each file needs:
```typescript
import { escapeHtml } from '@/utils/sanitize';
```

**Step 2: Escape all dynamic values**

In `app-keys.ts`:
```typescript
<td style="padding:8px 4px">${escapeHtml(k.description ?? '—')}</td>
<td style="padding:8px 4px;color:var(--text-muted)">${escapeHtml(k.created_at?.slice(0, 10) ?? '')}</td>
```

In `secrets.ts`:
```typescript
<td style="padding:8px 4px;font-family:monospace">${escapeHtml(s.name)}</td>
<td style="padding:8px 4px;color:var(--text-muted)">${escapeHtml(s.description ?? '')}</td>
```

In `feature-flags.ts` — escape `f.key`, `f.description`, and `strVal` in both HTML content and attribute values (`value="..."`, `data-key="..."`).

**Step 3: Build check**

Run: `npx tsc --noEmit`

**Step 4: Commit**

```bash
git add src/admin/pages/app-keys.ts src/admin/pages/secrets.ts src/admin/pages/feature-flags.ts
git commit -m "fix: escape API content in admin page innerHTML to prevent XSS"
```

---

### Task 36: Add error handling to admin login

**Files:**
- Modify: `src/admin/login.ts:39-52`

**Context:** `attempt()` calls `supabase.auth.signInWithPassword` without try/catch. If it throws, the UI stays stuck in loading state.

**Step 1: Wrap in try/catch**

```typescript
async function attempt(): Promise<void> {
  const emailEl = container.querySelector<HTMLInputElement>('#admin-email');
  const passwordEl = container.querySelector<HTMLInputElement>('#admin-password');
  if (!emailEl || !passwordEl || !btn || !errEl) return;

  const email = emailEl.value.trim();
  const password = passwordEl.value;
  if (!email || !password) {
    errEl.textContent = 'Email and password required.';
    errEl.style.display = 'block';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Signing in…';
  errEl.style.display = 'none';

  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error || !data.session) {
      btn.disabled = false;
      btn.textContent = 'Sign In';
      errEl.textContent = 'Invalid email or password.';
      errEl.style.display = 'block';
      return;
    }
    passwordEl.value = '';
    onSuccess(data.user, data.session.access_token);
  } catch {
    btn.disabled = false;
    btn.textContent = 'Sign In';
    errEl.textContent = 'An unexpected error occurred.';
    errEl.style.display = 'block';
  }
}
```

**Step 2: Build check**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/admin/login.ts
git commit -m "fix: add try/catch and null checks to admin login"
```

---

## Phase 9: Workers, Utils, and Remaining Fixes

### Task 37: Add worker message validation

**Files:**
- Modify: `src/workers/analysis.worker.ts:82-147`
- Modify: `src/workers/ml.worker.ts`

**Step 1: Validate incoming messages**

```typescript
// analysis.worker.ts
self.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || typeof message.type !== 'string') {
    console.warn('[analysis.worker] Invalid message:', message);
    return;
  }
  switch (message.type) {
    // ... existing cases
    default:
      console.warn('[analysis.worker] Unknown message type:', message.type);
  }
});
```

**Step 2: Fix ML worker reset**

In `ml.worker.ts`, clear `loadingPromises` in the reset handler:
```typescript
case 'reset': {
  loadedPipelines.clear();
  loadingPromises.clear();
  self.postMessage({ type: 'reset-complete' });
  break;
}
```

**Step 3: Build check**

Run: `npx tsc --noEmit`

**Step 4: Commit**

```bash
git add src/workers/analysis.worker.ts src/workers/ml.worker.ts
git commit -m "fix: add message validation and fix reset in workers"
```

---

### Task 38: Fix panel-layout.ts wrong zoom variable

**Files:**
- Modify: `src/app/panel-layout.ts:669`

**Context:** `setCenter` is called with `zoom` (can be `undefined`) instead of `effectiveZoom` (the computed fallback value).

**Step 1: Fix the variable**

```typescript
// Before:
this.ctx.map.setCenter(lat, lon, zoom);
// After:
this.ctx.map.setCenter(lat, lon, effectiveZoom);
```

**Step 2: Build check**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/app/panel-layout.ts
git commit -m "fix: use effectiveZoom instead of potentially-undefined zoom in panel-layout"
```

---

### Task 39: Add panel-layout.ts window resize listener cleanup

**Files:**
- Modify: `src/app/panel-layout.ts:849`

**Step 1: Store the handler and remove in destroy()**

```typescript
private boundEnsureCorrectZones: (() => void) | null = null;

// In createPanels:
this.boundEnsureCorrectZones = () => this.ensureCorrectZones();
window.addEventListener('resize', this.boundEnsureCorrectZones);

// In destroy:
if (this.boundEnsureCorrectZones) {
  window.removeEventListener('resize', this.boundEnsureCorrectZones);
}
```

**Step 2: Build check**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/app/panel-layout.ts
git commit -m "fix: clean up window resize listener in PanelLayoutManager.destroy()"
```

---

### Task 40: Fix country-intel race conditions

**Files:**
- Modify: `src/app/country-intel.ts:183-186`

**Context:** Fire-and-forget stock/market promises can update the UI for the wrong country if the user switches quickly.

**Step 1: Add token checks in async callbacks**

Use the existing `briefRequestToken` pattern — check that the token hasn't changed before updating the UI:

```typescript
const token = this.briefRequestToken;
stockPromise.then((stockData) => {
  if (this.briefRequestToken !== token) return; // country changed
  // ... update UI
});
```

**Step 2: Build check**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/app/country-intel.ts
git commit -m "fix: add token guard to prevent stale country data updates"
```

---

### Task 41: Cap reverse-geocode cache size

**Files:**
- Modify: `src/utils/reverse-geocode.ts:11-12`

**Step 1: Add size limit**

```typescript
const MAX_CACHE_SIZE = 500;

// Before setting cache:
if (cache.size >= MAX_CACHE_SIZE) {
  const firstKey = cache.keys().next().value;
  if (firstKey !== undefined) cache.delete(firstKey);
}
cache.set(key, result);
```

**Step 2: Build check**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/utils/reverse-geocode.ts
git commit -m "fix: cap reverse-geocode cache at 500 entries to prevent memory growth"
```

---

### Task 42: Fix dashboard URL.revokeObjectURL timing

**Files:**
- Modify: `src/admin/dashboard.ts:124`

**Step 1: Delay revocation**

```typescript
a.click();
document.body.removeChild(a);
setTimeout(() => URL.revokeObjectURL(a.href), 1000);
```

**Step 2: Commit**

```bash
git add src/admin/dashboard.ts
git commit -m "fix: delay URL.revokeObjectURL to allow download to complete"
```

---

### Task 43: Remove dead code in proxy.ts

**Files:**
- Modify: `src/utils/proxy.ts:24-28`

**Context:** Both branches of an if/else return `localPath`.

**Step 1: Simplify**

```typescript
return localPath;
```

**Step 2: Commit**

```bash
git add src/utils/proxy.ts
git commit -m "fix: remove dead if/else branch in proxy.ts"
```

---

## Summary

| Phase | Tasks | Severity |
|-------|-------|----------|
| 1: Critical Bugs | 1–8 | Critical |
| 2: High Issues | 9–16 | High |
| 3: Observability | 17–20 | High/Medium |
| 4: Type Safety | 21–25 | Medium |
| 5: Performance | 26–28 | Medium |
| 6: Cleanup | 29–32 | Low/Medium |
| 7: Event Handler Leaks | 33–34 | Critical |
| 8: Admin XSS | 35–36 | Critical |
| 9: Workers, Utils, Remaining | 37–43 | High/Medium |

**Total: 43 tasks across 9 phases covering ~115 issues.**
