# Page Load Performance Optimization Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reduce the time-to-interactive (TTI) for the main dashboard page by eliminating sequential waterfalls, reducing HTTP round-trips, and adding client-side caching for repeat visits.

**Architecture:** The current page load follows a deeply sequential waterfall: `loadNewsSources()` blocks before `App` is even created, then `App.init()` chains `initDB` → `initI18n` → `mlWorker.init` → `fetchBootstrapData` → `resolveUserRegion` → `panelLayout.init` → `preloadCountryGeometry` → `loadAllData` — each awaiting the previous. Only `initI18n` truly needs to complete before the UI shell renders (panel labels use `t()`). Everything else either has graceful fallbacks or is not needed for first paint.

**Tech Stack:** TypeScript (Vite SPA), Vercel Edge Functions, Upstash Redis, IndexedDB (`src/services/persistent-cache.ts`).

---

## Current Critical Path (sequential, ~3–6s)

```
loadNewsSources ──await──► new App ──► app.init():
                                        ├── await initDB()           (~10-50ms)
                                        ├── await initI18n()         (~10-50ms)
                                        ├── await mlWorker.init()    (~50-200ms, conditional)
                                        ├── await fetchBootstrapData (~100-800ms)
                                        ├── await resolveUserRegion  (~0-3000ms)
                                        ├── panelLayout.init()       (sync)
                                        ├── ... UI setup ...
                                        ├── await preloadCountryGeometry (~100-500ms)
                                        └── await loadAllData()      (~500-2000ms)
```

Total sequential wait: **~1–6.5s** before data appears in panels.

## What Must Be Awaited vs. What Shouldn't

| Operation | Must await before render? | Reason |
|-----------|--------------------------|--------|
| `initI18n()` | **YES** | Panel labels use `t()` — garbage without it |
| `loadNewsSources()` | Only before `loadAllData` | News panels need feed definitions, but UI shell doesn't |
| `fetchBootstrapData()` | **NO** | Every service falls back to individual API calls on miss |
| `initDB()` | **NO** | IndexedDB is for persistent cache, not first render |
| `mlWorker.init()` | **NO** | ML features aren't visible on first paint |
| `resolveUserRegion()` | **NO** | Map defaults to 'global', can recenter async |
| `preloadCountryGeometry()` | **NO** | Country borders appear async, map works without them |

## Target Critical Path (async-first, ~50ms to UI shell)

```
await initI18n()  ────────────────────────  (~10-50ms, ONLY hard await)
          │
          ▼
   panelLayout.init()  (sync, immediate)   ← UI shell visible
   ... UI setup ... (sync, immediate)
          │
          ├── void initDB()                  (fire-and-forget)
          ├── void mlWorker.init()            (fire-and-forget)
          ├── void resolveUserRegion()        (fire-and-forget, recenters map when done)
          ├── void preloadCountryGeometry()   (fire-and-forget)
          │
          ├── fetchBootstrapData ──┐
          └── loadNewsSources ─────┤  await Promise.all (~200-600ms)
                                   │
                                   ▼
                            loadAllData()    (panels fill in progressively)
```

Total wait before UI shell: **~10–50ms** (just i18n).
Total wait before data starts loading: **~200–600ms** (bootstrap + feeds, concurrent).

---

## Task 1: Restructure `App.init()` — Async-First Architecture

**Files:**
- Modify: `src/main.ts:241-248`
- Modify: `src/App.ts:333-447`

This is the single biggest change. It restructures the entire init from "await everything sequentially" to "await only what's required, fire-and-forget the rest."

**Step 1: Remove the blocking `loadNewsSources` from `main.ts`**

In `src/main.ts`, remove the blocking call so `App` is constructed immediately:

```typescript
} else {
  void (async () => {
    const app = new App('app');
    await app.init();
    clearChunkReloadGuard(chunkReloadStorageKey);
  })().catch(console.error);
}
```

**Step 2: Rewrite `App.init()` with three phases**

Replace the sequential chain (lines 333-447) with this structure:

```typescript
import { loadNewsSources } from '@/services/feed-client';

public async init(): Promise<void> {
  const initStart = performance.now();

  // ── PHASE 1: Minimum for UI shell (only hard await) ──
  await initI18n();

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

  // Region resolves async — map starts at 'global', recenters when ready
  void resolveUserRegion().then(region => {
    this.state.resolvedLocation = region;
  });

  // ── PHASE 3: Render UI shell immediately ──
  this.panelLayout.init();

  // Happy variant: pre-populate panels from persistent cache for instant render
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

  // ── PHASE 4: Await only what data loading needs, then load ──
  this.dataLoader.syncDataFreshnessWithLayers();

  // Bootstrap + news sources + country geometry run concurrently.
  // Once bootstrap + feeds complete, loadAllData can begin.
  // Country geometry loads independently (map works without it).
  void preloadCountryGeometry();
  await Promise.all([fetchBootstrapData(), loadNewsSources()]);
  await this.dataLoader.loadAllData();

  startLearning();

  // ... rest of init unchanged ...
}
```

**Step 3: Remove the dynamic import of `feed-client` from `main.ts`**

Since `loadNewsSources` is now called inside `App.init()`, the dynamic `import('@/services/feed-client')` in `main.ts` (line 243) is no longer needed.

**Step 4: Verify**

Run: `npx tsc --noEmit`
Expected: No type errors.

Run: `npm run build`
Expected: Build succeeds.

**Step 5: Manually test**

Open the app in browser. Verify:
- Map appears immediately (not waiting for bootstrap)
- Panels show loading states, then fill with data
- News feeds load correctly
- Country geometry borders appear (may take a moment)
- ML features work if enabled

**Step 6: Commit**

```bash
git add src/main.ts src/App.ts
git commit -m "perf: async-first init — only await initI18n before render, fire-and-forget the rest"
```

**What changed and why:**

| Before (sequential) | After (async-first) | Savings |
|---------------------|---------------------|---------|
| `await loadNewsSources()` before App | Runs in Phase 4 concurrently with bootstrap | ~200-600ms |
| `await initDB()` | `void initDB()` — fire-and-forget | ~10-50ms |
| `await initI18n()` | `await initI18n()` — **only hard await** | 0ms (still needed) |
| `await mlWorker.init()` | `void mlWorker.init()` — fire-and-forget | ~50-200ms |
| `await fetchBootstrapData()` before layout | Runs in Phase 4, panels use fallback fetches if not ready | ~100-800ms |
| `await resolveUserRegion()` before layout | `void resolveUserRegion()` — recenters map async | ~0-3000ms |
| `await preloadCountryGeometry()` blocks loadAllData | `void preloadCountryGeometry()` — fire-and-forget | ~100-500ms |

**Result:** UI shell visible after **~10-50ms** (just i18n). Data starts loading after **~200-600ms** (bootstrap + feeds concurrent). Total time to first data in panels: **~0.7-2.6s** vs. previous **~1-6.5s**.

---

## Task 2: Increase Bootstrap Timeout

**Files:**
- Modify: `src/services/bootstrap.ts:12`

The current bootstrap timeout is 800ms. This is too aggressive — when it fails, every panel falls through to individual API calls, causing a storm of ~15+ separate requests that is much slower overall. The bootstrap endpoint is a single Redis pipeline call on an edge function; P95 should be well under 2s.

**Step 1: Increase timeout to 3000ms**

In `src/services/bootstrap.ts`, change line 12:

```typescript
const resp = await fetch('/api/bootstrap', {
  signal: AbortSignal.timeout(3000),
});
```

**Step 2: Commit**

```bash
git add src/services/bootstrap.ts
git commit -m "perf: increase bootstrap timeout to 3s — prevent fallback request storms"
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
  newsSources:    'wm:config:sources:v1:full',  // populated by /api/config/news-sources
  featureFlags:   'wm:config:flags:v1',         // populated by /api/config/feature-flags
};
```

Note: The news-sources cache key is variant-specific. The bootstrap endpoint should accept a `variant` query param and use it to pick the right key.

**Step 2: Make bootstrap variant-aware**

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

  // ... rest unchanged ...
}
```

**Step 3: Update `bootstrap.ts` to populate feed-client and feature-flag caches**

```typescript
import type { NewsSourceRow } from '@/services/feed-client';

export async function fetchBootstrapData(variant: string): Promise<void> {
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

**Step 4: Update `feed-client.ts` to use hydrated data**

```typescript
import { getHydratedNewsSources } from '@/services/bootstrap';

export async function loadNewsSources(): Promise<void> {
  const hydrated = getHydratedNewsSources();
  if (hydrated) {
    _sources = hydrated;
    buildFeedsFromSources();
    return;
  }

  // Existing fetch fallback...
  try {
    const variant = SITE_VARIANT || 'full';
    // ... existing fetch code ...
  } catch { /* ... */ }
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

**Step 5: Update `feature-flag-client.ts` to use hydrated data**

```typescript
import { getHydratedFeatureFlags } from '@/services/bootstrap';

export async function loadFeatureFlags(): Promise<void> {
  const hydrated = getHydratedFeatureFlags();
  if (hydrated) {
    _flags = hydrated;
    return;
  }

  // Existing fetch fallback...
  try { /* ... */ } catch { /* ... */ }
}
```

**Step 6: Update `App.init()` to call `loadFeatureFlags` in the parallel block**

```typescript
const [, , , , resolvedRegion] = await Promise.all([
  initDB(),
  initI18n(),
  needsMlWorker ? mlWorker.init().then(() => { ... }) : Promise.resolve(),
  fetchBootstrapData(SITE_VARIANT || 'full'),
  resolveUserRegion(),
]);

// Post-bootstrap: load news sources and feature flags from hydration (instant if bootstrap succeeded)
await Promise.all([
  loadNewsSources(),
  loadFeatureFlags(),
]);
```

Note the two-phase approach: bootstrap must complete first so the hydration cache is populated, THEN news sources and feature flags read from it (instant) or fall back to their own fetches.

**Step 7: Verify**

Run: `npx tsc --noEmit`
Expected: No type errors.

Run: `npm run build`
Expected: Build succeeds.

**Step 8: Commit**

```bash
git add api/bootstrap.js src/services/bootstrap.ts src/services/feed-client.ts src/services/feature-flag-client.ts src/App.ts
git commit -m "perf: bundle news sources + feature flags into bootstrap — eliminates 2 HTTP round-trips"
```

---

## Task 4: Persist Bootstrap Data to IndexedDB for Instant Repeat Visits

**Files:**
- Modify: `src/services/bootstrap.ts`

On repeat visits, the bootstrap data is re-fetched from the server even though it's often identical. By persisting to IndexedDB (using the existing `persistent-cache.ts` infrastructure), we can hydrate panels instantly from the last-known-good data while the fresh bootstrap loads in the background.

**Step 1: Add persistent cache integration to `bootstrap.ts`**

```typescript
import { loadCacheEntry, saveCacheEntry } from '@/services/persistent-cache';

const BOOTSTRAP_CACHE_KEY = 'bootstrap:v2';
const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

export async function fetchBootstrapData(variant: string): Promise<void> {
  // Phase 1: Load stale data from IndexedDB for instant hydration
  try {
    const cached = await loadCacheEntry(BOOTSTRAP_CACHE_KEY);
    if (cached?.data && typeof cached.data === 'object') {
      const age = Date.now() - (cached.updatedAt ?? 0);
      if (age < STALE_THRESHOLD_MS) {
        for (const [k, v] of Object.entries(cached.data as Record<string, unknown>)) {
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
    saveCacheEntry(BOOTSTRAP_CACHE_KEY, data).catch(() => {});
  } catch {
    // If server fetch failed but we had stale data, panels will use that
  }
}
```

**Step 2: Verify**

Run: `npx tsc --noEmit`
Expected: No type errors.

**Step 3: Commit**

```bash
git add src/services/bootstrap.ts
git commit -m "perf: persist bootstrap data to IndexedDB — instant hydration on repeat visits"
```

---

## Task 5: Cache API Key Validation Results

**Files:**
- Modify: `api/_api-key.js`

When an API key is present (desktop clients), every single API request triggers a Supabase `verify_app_key` RPC. This adds ~50-200ms per request. Key validity rarely changes — a 60-second cache is safe and eliminates most of this overhead.

**Step 1: Add in-memory validation cache**

```javascript
const KEY_CACHE = new Map();
const KEY_CACHE_TTL_MS = 60_000;

async function isValidKey(rawKey) {
  const hash = await sha256hex(rawKey);

  // Check cache
  const cached = KEY_CACHE.get(hash);
  if (cached && Date.now() - cached.ts < KEY_CACHE_TTL_MS) {
    return cached.valid;
  }

  // ... existing env-var check ...

  // ... existing Supabase RPC check ...
  const valid = /* result of validation */;
  KEY_CACHE.set(hash, { valid, ts: Date.now() });

  // Evict oldest entries if cache grows too large
  if (KEY_CACHE.size > 100) {
    const oldest = KEY_CACHE.keys().next().value;
    KEY_CACHE.delete(oldest);
  }

  return valid;
}
```

Note: Edge functions are stateless across requests in production — this cache helps within a single function invocation's lifetime (concurrent requests) and on warm instances where the runtime keeps the module alive between invocations.

**Step 2: Commit**

```bash
git add api/_api-key.js
git commit -m "perf: cache API key validation — avoid repeated Supabase RPC calls"
```

---

## Task 6: Add Performance Instrumentation

**Files:**
- Modify: `src/App.ts` (inside `init()`)

Add timing marks so we can measure the impact of these changes and catch regressions.

**Step 1: Add performance marks around the init phases**

```typescript
public async init(): Promise<void> {
  const initStart = performance.now();
  performance.mark('wm:init-start');

  // ... parallel init block ...

  performance.mark('wm:init-parallel-done');
  performance.measure('wm:parallel-init', 'wm:init-start', 'wm:init-parallel-done');

  // ... panelLayout.init, UI setup ...

  performance.mark('wm:layout-done');

  // ... loadAllData ...

  performance.mark('wm:data-done');
  performance.measure('wm:data-load', 'wm:layout-done', 'wm:data-done');
  performance.measure('wm:total-init', 'wm:init-start', 'wm:data-done');

  const totalMs = performance.now() - initStart;
  if (totalMs > 500) {
    console.info(`[perf] App.init: ${Math.round(totalMs)}ms`);
  }
}
```

**Step 2: Commit**

```bash
git add src/App.ts
git commit -m "perf: add performance marks to App.init() for monitoring"
```

---

## Summary of Expected Improvements

| Change | Estimated Savings | Risk |
|--------|------------------|------|
| Task 1: Async-first init (only await i18n, fire-and-forget the rest) | **500–4000ms** to UI shell | Low — all fire-and-forget ops have fallbacks |
| Task 2: Increase bootstrap timeout | **Prevents 15+ fallback requests** | Low — longer wait beats request storm |
| Task 3: Bundle config into bootstrap | **Eliminates 2 HTTP round-trips (~200-600ms)** | Medium — requires bootstrap to be variant-aware |
| Task 4: Persistent bootstrap cache | **Instant repeat-visit hydration** | Low — stale data replaced by fresh |
| Task 5: Cache API key validation | **50–200ms per API request (desktop)** | Low — 60s TTL, in-memory |
| Task 6: Performance instrumentation | Measurement only | None |

**Cumulative expected improvement:** UI shell visible in **~10-50ms** (was ~1-6.5s). First data in panels in **~0.7-2.6s**. Repeat visits near-instant with IndexedDB hydration.
