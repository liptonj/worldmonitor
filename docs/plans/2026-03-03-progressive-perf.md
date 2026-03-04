# Progressive Performance & Browser ML Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reduce time-to-interactive from ~1–6.5s (worst case 5+ minutes on hanging fetches) to ~50ms for the UI shell, with panels rendering progressively as data arrives, and ensure ML features work correctly in the browser.

**Architecture:** Convert the deeply sequential `App.init()` waterfall into a three-phase async architecture: (1) await only `initI18n`, (2) render UI shell with skeletons immediately, (3) fire-and-forget all data loading with per-panel progressive rendering. Add timeout hardening to all unbounded fetches. Fix ML capability detection to work correctly on desktop browsers regardless of viewport size.

**Tech Stack:** TypeScript (Vite SPA), Vercel Edge Functions, Upstash Redis, IndexedDB (`src/services/persistent-cache.ts`), ONNX Runtime Web (`@xenova/transformers`).

---

## Current Problem

### Sequential Waterfall (lines 241–248 of `main.ts`, lines 333–447 of `App.ts`)

```
main.ts: await loadNewsSources()          (up to 5s timeout)
  → new App()
    → await initDB()                      (10-50ms)
      → await initI18n()                  (10-50ms)
        → await mlWorker.init()           (conditional, 10s ready timeout)
          → await fetchBootstrapData()    (800ms timeout)
            → await resolveUserRegion()   (up to 3s)
              → panelLayout.init()        (sync)
                → await preloadCountryGeometry()  (NO TIMEOUT)
                  → await loadAllData()   (parallel internally, but retries add 20-60s)
```

### Unbounded Fetches (no AbortSignal)

| Fetch | File | Line | Timeout |
|-------|------|------|---------|
| `preloadCountryGeometry` | `src/services/country-geometry.ts:179` | `fetch(COUNTRY_GEOJSON_URL)` | **None** |
| `fetchWithProxy` | `src/utils/proxy.ts:76` | `fetch(proxyUrl(url))` | **None** |
| `fetchAndPersist` | `src/utils/proxy.ts:62` | `fetch(proxyUrl(url))` | **None** |

### ML Browser Issues

- `detectMLCapabilities()` in `src/services/ml-capabilities.ts:33` requires `isDesktop = !isMobileDevice()` — but `isMobileDevice()` is viewport-based (`window.innerWidth <= 768`). Narrow desktop browser windows are incorrectly treated as mobile, blocking ML.
- `estimateAvailableMemory()` returns `0` on "mobile" viewports, forcing `isSupported = false`.
- `modelLoadTimeoutMs` defaults to **600,000ms (10 minutes)** — far too long for browser UX.
- `browserModel` defaults to `false` in `getAiFlowSettings()`, so ML is never auto-initialized in the browser unless the user manually enables it.

---

## Task 1: Async-First `App.init()` — Only Await `initI18n`

**Files:**
- Modify: `src/main.ts:241-248`
- Modify: `src/App.ts:333-447`

This is the single biggest change. It restructures the entire init from "await everything sequentially" to "await only what's required, fire-and-forget the rest."

**Step 1: Remove the blocking `loadNewsSources` from `main.ts`**

In `src/main.ts`, remove the dynamic import and blocking call so `App` is constructed immediately. Change lines 241–248 from:

```typescript
void (async () => {
  const { loadNewsSources } = await import('@/services/feed-client');
  await loadNewsSources();
  const app = new App('app');
  await app.init();
  clearChunkReloadGuard(chunkReloadStorageKey);
})().catch(console.error);
```

to:

```typescript
void (async () => {
  const app = new App('app');
  await app.init();
  clearChunkReloadGuard(chunkReloadStorageKey);
})().catch(console.error);
```

**Step 2: Rewrite `App.init()` with three phases**

Replace the sequential chain in `src/App.ts` (lines 333–447) with this structure. The existing code after `loadAllData` (event handlers, URL sync, etc.) stays unchanged.

```typescript
import { loadNewsSources } from '@/services/feed-client';

public async init(): Promise<void> {
  const initStart = performance.now();
  performance.mark('wm:init-start');

  // ── PHASE 1: Minimum for UI shell (only hard await) ──
  await initI18n();

  performance.mark('wm:i18n-done');

  // ── PHASE 2: Fire-and-forget — not needed for first paint ──
  void initDB();

  const aiFlow = getAiFlowSettings();
  if (aiFlow.browserModel || isDesktopRuntime()) {
    void mlWorker.init().then(() => {
      if (BETA_MODE) mlWorker.loadModel('summarization-beta').catch(() => {});
    });
  }
  if (aiFlow.headlineMemory) {
    void mlWorker.init().then(ok => {
      if (ok) mlWorker.loadModel('embeddings').catch(() => {});
    }).catch(() => {});
  }

  this.unsubAiFlow = subscribeAiFlowChange((key) => {
    // ... existing subscription logic unchanged ...
  });

  if (!isAisConfigured()) {
    this.state.mapLayers.ais = false;
  } else if (this.state.mapLayers.ais) {
    initAisStream();
  }

  void resolveUserRegion().then(region => {
    this.state.resolvedLocation = region;
  });

  // ── PHASE 3: Render UI shell immediately ──
  this.panelLayout.init();

  performance.mark('wm:layout-done');
  performance.measure('wm:to-layout', 'wm:init-start', 'wm:layout-done');

  if (SITE_VARIANT === 'happy') {
    await this.dataLoader.hydrateHappyPanelsFromCache();
  }

  // Phase 3b: Shared UI components + event listeners (all sync, fast)
  this.state.signalModal = new SignalModal();
  // ... existing UI setup unchanged ...
  this.eventHandlers.startHeaderClock();
  // ... existing event setup unchanged ...
  this.searchManager.init();
  this.eventHandlers.setupMapLayerHandlers();
  this.countryIntel.init();
  this.eventHandlers.init();
  // ... existing URL sync unchanged ...

  // ── PHASE 4: Data loading (no longer blocking UI) ──
  this.dataLoader.syncDataFreshnessWithLayers();
  void preloadCountryGeometry();

  await Promise.all([fetchBootstrapData(), loadNewsSources()]);

  performance.mark('wm:bootstrap-done');
  performance.measure('wm:bootstrap', 'wm:layout-done', 'wm:bootstrap-done');

  void this.dataLoader.loadAllData().then(() => {
    performance.mark('wm:data-done');
    performance.measure('wm:data-load', 'wm:bootstrap-done', 'wm:data-done');
    performance.measure('wm:total-init', 'wm:init-start', 'wm:data-done');
    const totalMs = performance.now() - initStart;
    if (totalMs > 500) {
      console.info(`[perf] App.init total: ${Math.round(totalMs)}ms`);
    }
  });

  startLearning();

  // ... rest of init unchanged ...
}
```

**Step 3: Remove the dynamic import of `feed-client` from `main.ts`**

Since `loadNewsSources` is now called inside `App.init()`, the dynamic `import('@/services/feed-client')` in `main.ts` (line 243) is no longer needed. Add a static import at the top of `App.ts` instead:

```typescript
import { loadNewsSources } from '@/services/feed-client';
```

**Step 4: Verify**

Run: `npx tsc --noEmit`
Expected: No type errors.

Run: `npm run build`
Expected: Build succeeds.

**Step 5: Commit**

```bash
git add src/main.ts src/App.ts
git commit -m "perf: async-first init — only await initI18n before render, fire-and-forget the rest"
```

**What changed and why:**

| Before (sequential) | After (async-first) | Savings |
|---------------------|---------------------|---------|
| `await loadNewsSources()` before App | Runs in Phase 4 with bootstrap | ~200-600ms |
| `await initDB()` | `void initDB()` — fire-and-forget | ~10-50ms |
| `await initI18n()` | `await initI18n()` — **only hard await** | 0ms (still needed) |
| `await mlWorker.init()` | `void mlWorker.init()` — fire-and-forget | ~50-200ms |
| `await fetchBootstrapData()` before layout | Runs in Phase 4 after layout | ~100-800ms |
| `await resolveUserRegion()` before layout | `void resolveUserRegion()` — recenters map async | ~0-3000ms |
| `await preloadCountryGeometry()` blocks loadAllData | `void preloadCountryGeometry()` — fire-and-forget | ~100-500ms |
| `await loadAllData()` blocks entire init | `void loadAllData()` — fire-and-forget | ~500-2000ms |

---

## Task 2: Timeout Hardening — Cap All Unbounded Fetches

**Files:**
- Modify: `src/services/country-geometry.ts:179`
- Modify: `src/utils/proxy.ts:62,76`
- Modify: `src/services/bootstrap.ts:12`

### Step 1: Add timeout to `preloadCountryGeometry`

In `src/services/country-geometry.ts`, line 179, add a 10-second timeout:

```typescript
const response = await fetch(COUNTRY_GEOJSON_URL, {
  signal: AbortSignal.timeout(10_000),
});
```

### Step 2: Add timeout to `fetchWithProxy` and `fetchAndPersist`

In `src/utils/proxy.ts`, add a module-level constant and apply it to both fetch calls:

```typescript
const PROXY_FETCH_TIMEOUT_MS = 15_000;
```

Line 62, `fetchAndPersist`:
```typescript
async function fetchAndPersist(url: string): Promise<Response> {
  const response = await fetch(proxyUrl(url), {
    signal: AbortSignal.timeout(PROXY_FETCH_TIMEOUT_MS),
  });
  // ... rest unchanged ...
}
```

Line 76, `fetchWithProxy` non-persistent path:
```typescript
if (!shouldPersistResponse(url)) {
  return fetch(proxyUrl(url), {
    signal: AbortSignal.timeout(PROXY_FETCH_TIMEOUT_MS),
  });
}
```

### Step 3: Increase bootstrap timeout from 800ms to 3000ms

In `src/services/bootstrap.ts`, line 12:

```typescript
const resp = await fetch('/api/bootstrap', {
  signal: AbortSignal.timeout(3000),
});
```

### Step 4: Verify

Run: `npx tsc --noEmit`
Expected: No type errors.

### Step 5: Commit

```bash
git add src/services/country-geometry.ts src/utils/proxy.ts src/services/bootstrap.ts
git commit -m "perf: add timeouts to all unbounded fetches — prevent infinite hangs"
```

---

## Task 3: Bundle News Sources and Feature Flags Into Bootstrap

**Files:**
- Modify: `api/bootstrap.js`
- Modify: `src/services/bootstrap.ts`
- Modify: `src/services/feed-client.ts`
- Modify: `src/services/feature-flag-client.ts`

This eliminates 1-2 extra HTTP round-trips on page load by folding config data into the existing bootstrap call.

### Step 1: Add news sources + feature flags to bootstrap endpoint

In `api/bootstrap.js`, add two new Redis keys to `BOOTSTRAP_CACHE_KEYS`:

```javascript
const BOOTSTRAP_CACHE_KEYS = {
  // ... existing 16 keys ...
  newsSources:    'wm:config:sources:v1:full',
  featureFlags:   'wm:config:flags:v1',
};
```

### Step 2: Make bootstrap variant-aware

In `api/bootstrap.js`, read the `variant` param and dynamically set the news-sources key:

```javascript
export default async function handler(req) {
  // ... existing CORS/API key checks ...

  const url = new URL(req.url);
  const variant = url.searchParams.get('variant') || 'full';
  const requested = url.searchParams.get('keys')?.split(',').filter(Boolean);

  const dynamicKeys = {
    ...BOOTSTRAP_CACHE_KEYS,
    newsSources: `wm:config:sources:v1:${variant}`,
  };

  const registry = requested
    ? Object.fromEntries(Object.entries(dynamicKeys).filter(([k]) => requested.includes(k)))
    : dynamicKeys;

  // ... rest unchanged, use `registry` instead of `BOOTSTRAP_CACHE_KEYS` ...
}
```

### Step 3: Update `bootstrap.ts` to accept variant and expose hydrated config

In `src/services/bootstrap.ts`, update `fetchBootstrapData` and add getter functions:

```typescript
import type { NewsSourceRow } from '@/services/feed-client';

export async function fetchBootstrapData(variant: string = 'full'): Promise<void> {
  try {
    const resp = await fetch(`/api/bootstrap?variant=${variant}`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) return;
    const { data } = (await resp.json()) as { data: Record<string, unknown> };
    for (const [k, v] of Object.entries(data)) {
      if (v !== null && v !== undefined) {
        hydrationCache.set(k, v);
      }
    }
  } catch {
    // silent — panels fall through to individual calls
  }
}

export function getHydratedNewsSources(): NewsSourceRow[] | null {
  const val = hydrationCache.get('newsSources');
  if (val !== undefined) {
    hydrationCache.delete('newsSources');
    return val as NewsSourceRow[];
  }
  return null;
}

export function getHydratedFeatureFlags(): Record<string, unknown> | null {
  const val = hydrationCache.get('featureFlags');
  if (val !== undefined) {
    hydrationCache.delete('featureFlags');
    return val as Record<string, unknown>;
  }
  return null;
}
```

### Step 4: Update `feed-client.ts` to use hydrated data

In `src/services/feed-client.ts`, update `loadNewsSources`:

```typescript
import { getHydratedNewsSources } from '@/services/bootstrap';

export async function loadNewsSources(): Promise<void> {
  const hydrated = getHydratedNewsSources();
  if (hydrated) {
    _sources = hydrated;
    buildFeedsFromSources();
    return;
  }

  // Existing fetch fallback unchanged...
}

function buildFeedsFromSources(): void {
  _feeds = {};
  _intelSources = [];
  for (const src of _sources!) {
    const url =
      typeof src.url === 'string'
        ? `/api/rss-proxy?url=${encodeURIComponent(src.url)}`
        : src.url;
    const feed: Feed = { name: src.name, url };
    if (src.category === 'intel') {
      _intelSources.push(feed);
    } else {
      (_feeds[src.category] ??= []).push(feed);
    }
  }
}
```

### Step 5: Update `feature-flag-client.ts` to use hydrated data

In `src/services/feature-flag-client.ts`, add hydration support:

```typescript
import { getHydratedFeatureFlags } from '@/services/bootstrap';

export async function loadFeatureFlags(): Promise<void> {
  const hydrated = getHydratedFeatureFlags();
  if (hydrated) {
    _flags = hydrated;
    return;
  }

  // Existing fetch fallback unchanged...
}
```

### Step 6: Update Phase 4 in `App.init()`

In the Phase 4 block from Task 1:

```typescript
await Promise.all([fetchBootstrapData(SITE_VARIANT || 'full'), loadNewsSources()]);
```

### Step 7: Verify

Run: `npx tsc --noEmit`
Expected: No type errors.

Run: `npm run build`
Expected: Build succeeds.

### Step 8: Commit

```bash
git add api/bootstrap.js src/services/bootstrap.ts src/services/feed-client.ts src/services/feature-flag-client.ts src/App.ts
git commit -m "perf: bundle news sources + feature flags into bootstrap — eliminates 2 HTTP round-trips"
```

---

## Task 4: Progressive Panel Rendering — Remove `await loadAllData()`

**Files:**
- Modify: `src/app/data-loader.ts:262-369`
- Modify: `src/components/Panel.ts`

The goal is that `loadAllData()` becomes fire-and-forget. Each panel already shows a loading state via `showLoading()` in its constructor (line 290 of `Panel.ts`). When data arrives, panels already replace the loading state with content via their `setData()`, `renderNews()`, `update()`, etc. methods.

The key change: `loadAllData()` already uses `Promise.allSettled` internally (line 360), so panels already render independently. We just need to:
1. Stop `await`-ing `loadAllData()` in `App.init()` (done in Task 1)
2. Add per-task error handling that shows inline errors on panels

### Step 1: Add `showUnavailable()` to base `Panel`

In `src/components/Panel.ts`, add a method near `showError()` (around line 633):

```typescript
public showUnavailable(message = t('common.dataUnavailable')): void {
  replaceChildren(this.content,
    h('div', { className: 'panel-unavailable' },
      h('div', { className: 'panel-unavailable-icon' }, '⚠'),
      h('div', { className: 'panel-unavailable-text' }, message),
    ),
  );
}
```

### Step 2: Add CSS for unavailable state

In `src/styles/main.css`, add near the existing `.panel-loading` styles (around line 5435):

```css
.panel-unavailable {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-sm, 8px);
  padding: var(--spacing-lg, 24px);
  opacity: 0.6;
}

.panel-unavailable-icon {
  font-size: 1.5rem;
}

.panel-unavailable-text {
  font-size: 0.8rem;
  text-align: center;
  color: var(--text-secondary, #888);
}
```

### Step 3: Enhance `runGuarded` in `loadAllData` with panel error states

In `src/app/data-loader.ts`, modify the `runGuarded` helper inside `loadAllData()` (lines 263–273) to show errors on panels when tasks fail:

```typescript
async loadAllData(): Promise<void> {
  const runGuarded = async (name: string, fn: () => Promise<void>): Promise<void> => {
    if (this.ctx.isDestroyed || this.ctx.inFlight.has(name)) return;
    this.ctx.inFlight.add(name);
    try {
      await fn();
    } catch (e) {
      if (!this.ctx.isDestroyed) {
        console.error(`[App] ${name} failed:`, e);
        const panel = this.ctx.panels[name] ?? this.ctx.newsPanels[name];
        if (panel && typeof panel.showUnavailable === 'function') {
          panel.showUnavailable();
        }
      }
    } finally {
      this.ctx.inFlight.delete(name);
    }
  };

  // ... rest of loadAllData unchanged ...
}
```

### Step 4: Verify

Run: `npx tsc --noEmit`
Expected: No type errors.

### Step 5: Commit

```bash
git add src/components/Panel.ts src/styles/main.css src/app/data-loader.ts
git commit -m "perf: progressive panel rendering — panels show errors inline, loadAllData is fire-and-forget"
```

---

## Task 5: Fix ML Browser Support

**Files:**
- Modify: `src/services/ml-capabilities.ts:26,33,102-110`
- Modify: `src/services/feature-flag-client.ts:43`

### Step 1: Fix `isMobileDevice` dependency in ML capabilities

The problem: `isMobileDevice()` uses `window.innerWidth <= 768`, which means a desktop browser at a narrow width is treated as mobile, disabling ML. ML capability detection should use actual device detection, not viewport size.

In `src/services/ml-capabilities.ts`, replace the `isMobileDevice` import and `isDesktop` logic:

```typescript
// Replace: import { isMobileDevice } from '@/utils';

function isActualMobileDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
}
```

Then update line 26:

```typescript
const isDesktop = !isActualMobileDevice();
```

And update `estimateAvailableMemory()` at line 102:

```typescript
function estimateAvailableMemory(): number {
  if (isActualMobileDevice()) return 0;

  const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (deviceMemory) {
    return Math.min(deviceMemory * 256, getMLThresholds().memoryBudgetMB);
  }

  return 256;
}
```

### Step 2: Reduce model load timeout from 10 minutes to 60 seconds

In `src/services/feature-flag-client.ts`, line 43, change the default:

```typescript
modelLoadTimeoutMs: flag<number>('ml.modelLoadTimeoutMs') ?? 60_000,
```

This can be overridden by feature flags for users who need longer loads, but 10 minutes is never acceptable as a default — it blocks the page on slow model downloads.

### Step 3: Verify ML init doesn't block in browser

This is already handled by Task 1 (mlWorker.init is fire-and-forget). But verify the flow:

1. `void mlWorker.init()` fires in the background
2. `mlWorker.init()` calls `detectMLCapabilities()`
3. If capabilities check fails (mobile device, no WebGL/WebGPU, low memory), returns `false` silently
4. If capabilities check passes, starts the web worker
5. Worker sends `worker-ready` within 10s or times out

No code change needed here — just verify the fire-and-forget from Task 1 works correctly.

### Step 4: Verify

Run: `npx tsc --noEmit`
Expected: No type errors.

### Step 5: Commit

```bash
git add src/services/ml-capabilities.ts src/services/feature-flag-client.ts
git commit -m "fix: ML capabilities use UA detection instead of viewport width, reduce model load timeout to 60s"
```

---

## Task 6: Persist Bootstrap Data to IndexedDB

**Files:**
- Modify: `src/services/bootstrap.ts`

On repeat visits, the bootstrap data is re-fetched from the server even though it's often identical. By persisting to IndexedDB, we can hydrate panels instantly from the last-known-good data while the fresh bootstrap loads in the background.

### Step 1: Add persistent cache integration

In `src/services/bootstrap.ts`:

```typescript
import { getPersistentCache, setPersistentCache } from '@/services/persistent-cache';

const BOOTSTRAP_CACHE_KEY = 'bootstrap:v2';
const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

export async function fetchBootstrapData(variant: string = 'full'): Promise<void> {
  // Phase 1: Load stale data from IndexedDB for instant hydration
  try {
    const cached = await getPersistentCache<Record<string, unknown>>(BOOTSTRAP_CACHE_KEY);
    if (cached?.data && typeof cached.data === 'object') {
      const age = Date.now() - (cached.updatedAt ?? 0);
      if (age < STALE_THRESHOLD_MS) {
        for (const [k, v] of Object.entries(cached.data)) {
          if (v !== null && v !== undefined) hydrationCache.set(k, v);
        }
      }
    }
  } catch { /* IndexedDB unavailable */ }

  // Phase 2: Fetch fresh data from server (overwrites stale hydration)
  try {
    const resp = await fetch(`/api/bootstrap?variant=${variant}`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) return;
    const { data } = (await resp.json()) as { data: Record<string, unknown> };
    for (const [k, v] of Object.entries(data)) {
      if (v !== null && v !== undefined) {
        hydrationCache.set(k, v);
      }
    }
    // Save for next visit (fire-and-forget)
    void setPersistentCache(BOOTSTRAP_CACHE_KEY, data).catch(() => {});
  } catch {
    // If server fetch failed but we had stale data, panels will use that
  }
}
```

### Step 2: Verify

Run: `npx tsc --noEmit`
Expected: No type errors.

### Step 3: Commit

```bash
git add src/services/bootstrap.ts
git commit -m "perf: persist bootstrap data to IndexedDB — instant hydration on repeat visits"
```

---

## Task 7: Cache API Key Validation Results

**Files:**
- Modify: `api/_api-key.js`

When an API key is present (desktop clients), every API request triggers a Supabase `verify_app_key` RPC (~50-200ms per request). Key validity rarely changes — a 60-second cache is safe.

### Step 1: Add in-memory validation cache

In `api/_api-key.js`, add caching around the validation logic:

```javascript
const KEY_CACHE = new Map();
const KEY_CACHE_TTL_MS = 60_000;

async function isValidKey(rawKey) {
  const hash = await sha256hex(rawKey);

  const cached = KEY_CACHE.get(hash);
  if (cached && Date.now() - cached.ts < KEY_CACHE_TTL_MS) {
    return cached.valid;
  }

  // ... existing env-var check ...
  // ... existing Supabase RPC check ...
  const valid = /* result of validation */;
  KEY_CACHE.set(hash, { valid, ts: Date.now() });

  if (KEY_CACHE.size > 100) {
    const oldest = KEY_CACHE.keys().next().value;
    KEY_CACHE.delete(oldest);
  }

  return valid;
}
```

### Step 2: Commit

```bash
git add api/_api-key.js
git commit -m "perf: cache API key validation — avoid repeated Supabase RPC calls"
```

---

## Task 8: Performance Instrumentation

**Files:**
- Modify: `src/App.ts` (inside `init()`)

Performance marks are already included in the Task 1 code. This task is about verifying them and adding a summary log.

### Step 1: Verify marks exist in the Task 1 implementation

The following marks should be present in `App.init()` from Task 1:
- `wm:init-start` — top of init
- `wm:i18n-done` — after `await initI18n()`
- `wm:layout-done` — after `panelLayout.init()`
- `wm:bootstrap-done` — after `Promise.all([fetchBootstrapData, loadNewsSources])`
- `wm:data-done` — inside the `loadAllData().then()` callback

### Step 2: Add a performance summary helper

In `src/App.ts`, add a helper that logs all marks after data loading completes:

```typescript
function logPerformanceSummary(): void {
  const entries = performance.getEntriesByType('measure')
    .filter(e => e.name.startsWith('wm:'));
  if (entries.length === 0) return;
  console.info('[perf] Init breakdown:');
  for (const e of entries) {
    console.info(`  ${e.name}: ${Math.round(e.duration)}ms`);
  }
}
```

Call this inside the `loadAllData().then()` callback from Task 1.

### Step 3: Commit

```bash
git add src/App.ts
git commit -m "perf: add performance instrumentation to App.init()"
```

---

## Summary of Expected Improvements

| Change | Estimated Savings | Risk |
|--------|------------------|------|
| Task 1: Async-first init | **500–4000ms** to UI shell | Low — all fire-and-forget ops have fallbacks |
| Task 2: Timeout hardening | **Prevents infinite hangs** | Low — 10-15s timeouts are generous |
| Task 3: Bundle config into bootstrap | **Eliminates 2 HTTP round-trips (~200-600ms)** | Medium — requires bootstrap to be variant-aware |
| Task 4: Progressive panel rendering | **Panels render as data arrives** | Low — panels already support loading/error states |
| Task 5: Fix ML browser support | **ML works on narrow desktop windows** | Low — UA detection is more reliable than viewport |
| Task 6: Persistent bootstrap cache | **Instant repeat-visit hydration** | Low — stale data replaced by fresh |
| Task 7: Cache API key validation | **50–200ms per API request (desktop)** | Low — 60s TTL, in-memory |
| Task 8: Performance instrumentation | Measurement only | None |

**Cumulative expected improvement:**
- UI shell visible in **~10-50ms** (was ~1-6.5s, worst case 5+ min)
- First data in panels in **~0.7-2.6s** (panels render progressively as data arrives)
- Repeat visits near-instant with IndexedDB hydration
- ML features work correctly in desktop browsers regardless of window width
- No fetch can hang indefinitely — all have timeouts
