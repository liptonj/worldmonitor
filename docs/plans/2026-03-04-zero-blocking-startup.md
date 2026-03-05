# Zero-Blocking Startup Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate all blocking `await`s from the critical path so the app shell renders immediately and data loads progressively in the background.

**Architecture:** Three independent fixes: (1) `initDisplayPrefs` fires after first paint with a dynamic Supabase import so the SDK is removed from the critical bundle; (2) `loadNewsSources`/`loadFeatureFlags` become fire-and-forget in `App.init()` while `loadNews` waits for sources internally via a shared promise; (3) a server-side cron warms the news digest cache every 10 minutes so cold-start 25s builds never hit a real user.

**Tech Stack:** TypeScript, Vite (dynamic import), `node:test` + `node:assert` for unit tests, Vercel cron.

---

## Context for implementer

The app was showing a **completely blank screen for 50-70 seconds** before any content appeared. Root causes found:

1. **`initDisplayPrefs()`** in `main.ts` is `await`ed before `new App()`. It calls Supabase RPC with **no timeout**. Supabase cold starts can take 10-70s. The function fetches admin defaults for time format / timezone / temp unit — data almost always overridden by `localStorage` anyway.

2. **`display-prefs.ts` statically imports `@supabase/supabase-js`** — this pulls the entire Supabase SDK into the critical path bundle, increasing parse time for every user even if they never change display settings.

3. **`await Promise.all([loadNewsSources(), loadFeatureFlags()])`** in `App.init()` blocks `loadAllData()` by up to 5s on cold bootstrap cache. Both already have fast-paths from IndexedDB bootstrap cache (resolve in ~0ms for returning users) but block on cold start.

**Key files:**
- `src/main.ts` — entry point, where `initDisplayPrefs` is awaited
- `src/utils/display-prefs.ts` — statically imports `@supabase/supabase-js`
- `src/App.ts` — `App.init()`, contains the phase structure and the `await Promise.all` for sources/flags
- `src/app/data-loader.ts` — `loadNews()` calls `getFeeds()` which requires sources to be loaded
- `api/cron/warm-digest.ts` + `vercel.json` — cron pattern to follow, add digest warmer
- `server/worldmonitor/news/v1/list-feed-digest.ts` — server digest builder, has `OVERALL_DEADLINE_MS = 25_000`

**Test runner:** `npm run test:data` (runs `tests/*.test.mjs` via `node:test`)

**Existing test patterns:** Look at `tests/startup-load-profile.test.mjs` and `tests/bootstrap.test.mjs` for style.

---

## Task 1: Remove `await initDisplayPrefs()` from critical path in `main.ts`

**Files:**
- Modify: `src/main.ts` (around line 246)
- Create: `tests/display-prefs-nonblocking.test.mjs`

**What this fixes:** The Supabase RPC call with no timeout that causes the 50-70s blank screen.

**Step 1: Write the failing test**

Create `tests/display-prefs-nonblocking.test.mjs`:

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('display-prefs startup contract', () => {
  it('main.ts does not await initDisplayPrefs before App construction', () => {
    const src = readFileSync('src/main.ts', 'utf8');
    // Must NOT have await initDisplayPrefs() before new App(
    // Find the position of 'new App(' and 'await initDisplayPrefs'
    const appPos = src.indexOf('new App(');
    const awaitPos = src.indexOf('await initDisplayPrefs');
    assert.ok(appPos > -1, 'main.ts must contain new App(');
    // Either it's not awaited at all, or it's after app construction
    assert.ok(
      awaitPos === -1 || awaitPos > appPos,
      'initDisplayPrefs must not be awaited before new App() — it blocks first paint'
    );
  });

  it('main.ts does not await initDisplayPrefs at all', () => {
    const src = readFileSync('src/main.ts', 'utf8');
    assert.ok(
      !src.includes('await initDisplayPrefs'),
      'initDisplayPrefs must never be awaited — it calls Supabase with no timeout'
    );
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm run test:data -- --test-name-pattern "display-prefs startup contract"
```

Expected: FAIL — `initDisplayPrefs must not be awaited before new App()`

**Step 3: Fix `main.ts`**

Find this block in `src/main.ts` (around line 244-248):

```typescript
void (async () => {
  await initDisplayPrefs();
  const app = new App('app');
  await app.init();
  clearChunkReloadGuard(chunkReloadStorageKey);
})().catch(console.error);
```

Change to:

```typescript
void (async () => {
  const app = new App('app');
  await app.init();
  clearChunkReloadGuard(chunkReloadStorageKey);
})().catch(console.error);
```

**Step 4: Call `initDisplayPrefs` fire-and-forget after first paint in `App.init()`**

In `src/App.ts`, find the `panelLayout.init()` call (around line 410):

```typescript
// ── PHASE 3: Render UI shell immediately ──
this.panelLayout.init();

performance.mark('wm:layout-done');
```

Add immediately after `this.panelLayout.init()`:

```typescript
// Display prefs: fetch admin defaults in background — never blocks first paint.
// localStorage values (getTimeFormat/getTimezoneMode/getTempUnit) already work without
// this. When it resolves it dispatches 'display-prefs-changed' to update any components.
void initDisplayPrefs().catch(() => {});
```

Also add the import at the top of `src/App.ts` if not already present:

```typescript
import { initDisplayPrefs } from '@/utils/display-prefs';
```

**Step 5: Run test to verify it passes**

```bash
npm run test:data -- --test-name-pattern "display-prefs startup contract"
```

Expected: PASS

**Step 6: Commit**

```bash
git add src/main.ts src/App.ts tests/display-prefs-nonblocking.test.mjs
git commit -m "perf: remove await initDisplayPrefs from critical path — was blocking first paint with Supabase RPC"
```

---

## Task 2: Make `display-prefs.ts` use dynamic Supabase import

**Files:**
- Modify: `src/utils/display-prefs.ts`
- Create: `tests/display-prefs-dynamic-import.test.mjs`

**What this fixes:** `@supabase/supabase-js` is currently a static import in `display-prefs.ts`. Since `display-prefs.ts` is imported by `main.ts`, the entire Supabase SDK ends up in the critical path bundle. Making it a dynamic import means Vite can code-split it out of the main chunk, reducing the JS that must parse before the app starts.

**Step 1: Write the failing test**

Create `tests/display-prefs-dynamic-import.test.mjs`:

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('display-prefs bundle contract', () => {
  it('display-prefs.ts does not statically import @supabase/supabase-js', () => {
    const src = readFileSync('src/utils/display-prefs.ts', 'utf8');
    // Static import at top of file would be: import { createClient } from '@supabase/supabase-js'
    const hasStaticImport = /^import\s+.*from\s+['"]@supabase\/supabase-js['"]/m.test(src);
    assert.ok(
      !hasStaticImport,
      'display-prefs.ts must not statically import @supabase/supabase-js — it bloats the critical path bundle'
    );
  });

  it('display-prefs.ts uses dynamic import for supabase', () => {
    const src = readFileSync('src/utils/display-prefs.ts', 'utf8');
    assert.ok(
      src.includes("import('@supabase/supabase-js')"),
      'display-prefs.ts must use dynamic import() for @supabase/supabase-js'
    );
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm run test:data -- --test-name-pattern "display-prefs bundle contract"
```

Expected: FAIL — static import detected

**Step 3: Rewrite `initDisplayPrefs` in `src/utils/display-prefs.ts`**

Replace the top of the file:

```typescript
// BEFORE — static import (bloats critical bundle)
import { createClient } from '@supabase/supabase-js';
```

With no static import. Then inside the `initDisplayPrefs` function, use a dynamic import:

```typescript
export async function initDisplayPrefs(): Promise<void> {
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

  if (!url || !anonKey) {
    console.warn('[display-prefs] Supabase URL or anon key not configured; using hardcoded defaults');
    return;
  }

  try {
    // Dynamic import — keeps @supabase/supabase-js out of the critical path bundle.
    // This function is only called after first paint, so the async load is fine.
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(url, anonKey, { auth: { persistSession: false } });
    const { data, error } = await supabase.rpc('get_display_settings');

    if (error) {
      console.warn('[display-prefs] Failed to fetch admin defaults:', error.message);
      return;
    }

    if (data && typeof data === 'object') {
      const tf = (data as { time_format?: string }).time_format;
      const tz = (data as { timezone_mode?: string }).timezone_mode;
      const tu = (data as { temp_unit?: string }).temp_unit;

      adminDefaults = {
        time_format: tf === '12h' ? '12h' : '24h',
        timezone_mode: tz === 'local' ? 'local' : 'utc',
        temp_unit: tu === 'fahrenheit' ? 'fahrenheit' : 'celsius',
      };

      // Notify any components that are displaying time/temp to re-render
      window.dispatchEvent(new CustomEvent('display-prefs-changed'));
    }
  } catch (err) {
    console.warn('[display-prefs] Error fetching admin defaults:', err);
  }
}
```

Note: The existing function already calls `window.dispatchEvent(new CustomEvent('display-prefs-changed'))` — verify this is present after the change. If not, add it after setting `adminDefaults` so the clock and any temp displays update once admin defaults arrive.

**Step 4: Run typecheck**

```bash
npm run typecheck
```

Expected: no errors related to `display-prefs.ts`

**Step 5: Run test to verify it passes**

```bash
npm run test:data -- --test-name-pattern "display-prefs bundle contract"
```

Expected: PASS

**Step 6: Commit**

```bash
git add src/utils/display-prefs.ts tests/display-prefs-dynamic-import.test.mjs
git commit -m "perf: dynamic import @supabase/supabase-js in display-prefs — removes SDK from critical path bundle"
```

---

## Task 3: Make `loadNewsSources`/`loadFeatureFlags` non-blocking in `App.init()`

**Files:**
- Modify: `src/App.ts` (around line 480)
- Modify: `src/app/data-loader.ts` — `DataLoaderManager` class constructor + `loadNews()`
- Create: `tests/sources-nonblocking.test.mjs`

**What this fixes:** `await Promise.all([loadNewsSources(), loadFeatureFlags()])` currently blocks `loadAllData()` for up to 5s on cold bootstrap cache. We remove this `await` from `App.init()`. `loadNews()` needs feeds to exist before calling `getFeeds()`, so `DataLoaderManager` stores a `sourcesReady` promise that `loadNews()` awaits internally with a 3s hard cap.

**Step 1: Write the failing test**

Create `tests/sources-nonblocking.test.mjs`:

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('sources/flags non-blocking contract', () => {
  it('App.ts does not await loadNewsSources or loadFeatureFlags before loadAllData', () => {
    const src = readFileSync('src/App.ts', 'utf8');
    // Find loadAllData position
    const loadAllDataPos = src.indexOf('loadAllData()');
    assert.ok(loadAllDataPos > -1, 'App.ts must call loadAllData()');

    // Find any awaited loadNewsSources before loadAllData
    const awaitSourcesMatch = src.match(/await\s+(?:Promise\.all\(\[)?.*?loadNewsSources/s);
    if (awaitSourcesMatch) {
      const awaitPos = src.indexOf(awaitSourcesMatch[0]);
      assert.ok(
        awaitPos > loadAllDataPos,
        'loadNewsSources must not be awaited before loadAllData() is called'
      );
    }
    // If no match, test passes (not awaited at all)
  });

  it('data-loader.ts DataLoaderManager has a setSourcesReady method', () => {
    const src = readFileSync('src/app/data-loader.ts', 'utf8');
    assert.ok(
      src.includes('setSourcesReady'),
      'DataLoaderManager must have setSourcesReady(promise) method for loadNews to await internally'
    );
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm run test:data -- --test-name-pattern "sources/flags non-blocking contract"
```

Expected: FAIL

**Step 3: Add `sourcesReady` to `DataLoaderManager` in `src/app/data-loader.ts`**

Find the `DataLoaderManager` class declaration. Add a private field and setter:

```typescript
// Inside DataLoaderManager class, near other private fields
private sourcesReady: Promise<void> = Promise.resolve(); // default: already ready

public setSourcesReady(promise: Promise<unknown>): void {
  this.sourcesReady = promise.then(() => {}).catch(() => {});
}
```

**Step 4: Update `loadNews()` in `src/app/data-loader.ts` to await sources internally**

In `loadNews()`, find where `getFeeds()` is called (around line 759):

```typescript
const feedsMap = getFeeds();
const categories = Object.entries(feedsMap)
  ...
```

Replace with:

```typescript
// Wait for news sources to be loaded — but never more than 3s.
// App.init() fires loadNewsSources() and flags in parallel without awaiting them,
// so on a warm bootstrap cache this resolves in ~0ms (IndexedDB fast-path).
// On cold cache, we wait up to 3s then proceed with whatever is available
// (stale digest path handles empty feeds gracefully).
const SOURCES_WAIT_MS = 3000;
await Promise.race([
  this.sourcesReady,
  new Promise<void>((resolve) => setTimeout(resolve, SOURCES_WAIT_MS)),
]);

const feedsMap = getFeeds();
const categories = Object.entries(feedsMap)
  ...
```

**Step 5: Update `App.init()` in `src/App.ts` to remove the blocking await**

Find this block (around line 475-485):

```typescript
void fetchBootstrapData(SITE_VARIANT || 'full').then(() => {
  performance.mark('wm:bootstrap-done');
  performance.measure('wm:bootstrap', 'wm:layout-done', 'wm:bootstrap-done');
}).catch(() => {});

await Promise.all([loadNewsSources(), loadFeatureFlags()]);

void this.dataLoader.loadAllData()
```

Replace with:

```typescript
void fetchBootstrapData(SITE_VARIANT || 'full').then(() => {
  performance.mark('wm:bootstrap-done');
  performance.measure('wm:bootstrap', 'wm:layout-done', 'wm:bootstrap-done');
}).catch(() => {});

// Fire sources and flags immediately — no await. loadNews() waits for them
// internally (up to 3s) via the sourcesReady promise. Every other task
// (markets, predictions, fred, bis, etc.) runs immediately without waiting.
const sourcesReady = Promise.all([loadNewsSources(), loadFeatureFlags()]);
this.dataLoader.setSourcesReady(sourcesReady);

void this.dataLoader.loadAllData()
```

**Step 6: Run typecheck**

```bash
npm run typecheck
```

Expected: no errors

**Step 7: Run tests**

```bash
npm run test:data -- --test-name-pattern "sources/flags non-blocking contract"
```

Expected: PASS

**Step 8: Commit**

```bash
git add src/App.ts src/app/data-loader.ts tests/sources-nonblocking.test.mjs
git commit -m "perf: remove blocking await for loadNewsSources/loadFeatureFlags — loadNews waits internally, everything else fires immediately"
```

---

## Task 4: Add digest cache warming cron

**Files:**
- Create: `api/cron/warm-digest.ts`
- Modify: `vercel.json`
- Create: `tests/warm-digest-cron.test.mjs`

**What this fixes:** On cold Redis cache (after deploy or TTL expiry), `buildDigest` on the server takes up to 25s to fetch all RSS feeds. The first user after a cold cache hits this delay. A cron that runs every 10 minutes ensures the cache is always warm so users always get a ~50ms response.

**Step 1: Write the failing test**

Create `tests/warm-digest-cron.test.mjs`:

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('digest cache warming cron', () => {
  it('vercel.json has a warm-digest cron entry', () => {
    const config = JSON.parse(readFileSync('vercel.json', 'utf8'));
    const crons = config.crons ?? [];
    const digestCron = crons.find(c => c.path === '/api/cron/warm-digest');
    assert.ok(digestCron, 'vercel.json must have a /api/cron/warm-digest cron entry');
    // Every 10 minutes: "*/10 * * * *"
    assert.strictEqual(digestCron.schedule, '*/10 * * * *', 'Digest cron must run every 10 minutes');
  });

  it('warm-digest cron file exists', () => {
    // Will throw if file does not exist
    const src = readFileSync('api/cron/warm-digest.ts', 'utf8');
    assert.ok(src.includes('warm-digest') || src.includes('digest'), 'warm-digest.ts must reference digest');
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm run test:data -- --test-name-pattern "digest cache warming cron"
```

Expected: FAIL — file not found

**Step 3: Create `api/cron/warm-digest.ts`**

Follow the exact same pattern as `api/cron/warm-aviation-cache.ts`. The cron hits the `listFeedDigest` handler for each variant to populate Redis.

```typescript
export const config = { runtime: 'edge' };

import { timingSafeEqual as _timingSafeEqual } from '../../api/_cors.js';

// Warm the news digest cache for all variants by calling the internal RPC.
// This prevents the first real user from hitting a cold 25s buildDigest call.
const VARIANTS = ['full', 'tech', 'finance', 'happy'] as const;
const LANGS = ['en'] as const; // extend if multi-language digest is needed

async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const aBuf = encoder.encode(a);
  const bBuf = encoder.encode(b);
  if (aBuf.byteLength !== bBuf.byteLength) return false;
  const key = await crypto.subtle.importKey('raw', aBuf, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, bBuf);
  return crypto.subtle.verify('HMAC', key, sig, bBuf);
}

export default async function handler(req: Request): Promise<Response> {
  // Verify cron secret to prevent unauthorized invocation
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get('authorization');
  if (cronSecret) {
    const token = authHeader?.replace('Bearer ', '') ?? '';
    const valid = await timingSafeEqual(token, cronSecret);
    if (!valid) {
      return new Response('Unauthorized', { status: 401 });
    }
  }

  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'https://worldmonitor.app';

  const results: Array<{ variant: string; lang: string; status: number; ok: boolean }> = [];

  for (const variant of VARIANTS) {
    for (const lang of LANGS) {
      try {
        const url = `${baseUrl}/api/news/v1/list-feed-digest?variant=${variant}&lang=${lang}`;
        const res = await fetch(url, {
          headers: { 'X-WorldMonitor-Key': process.env.API_KEY ?? '' },
          signal: AbortSignal.timeout(30_000),
        });
        results.push({ variant, lang, status: res.status, ok: res.ok });
      } catch (err) {
        results.push({ variant, lang, status: 0, ok: false });
        console.error(`[warm-digest] Failed for ${variant}/${lang}:`, err);
      }
    }
  }

  const allOk = results.every(r => r.ok);
  console.log('[warm-digest] Results:', JSON.stringify(results));

  return new Response(JSON.stringify({ results }), {
    status: allOk ? 200 : 207,
    headers: { 'Content-Type': 'application/json' },
  });
}
```

**Step 4: Add cron to `vercel.json`**

Find the `"crons"` array in `vercel.json`:

```json
"crons": [
  { "path": "/api/cron/warm-aviation-cache", "schedule": "0 6 * * *" }
],
```

Add the digest warmer:

```json
"crons": [
  { "path": "/api/cron/warm-aviation-cache", "schedule": "0 6 * * *" },
  { "path": "/api/cron/warm-digest", "schedule": "*/10 * * * *" }
],
```

**Step 5: Run tests**

```bash
npm run test:data -- --test-name-pattern "digest cache warming cron"
```

Expected: PASS

**Step 6: Commit**

```bash
git add api/cron/warm-digest.ts vercel.json tests/warm-digest-cron.test.mjs
git commit -m "perf: add cron to warm news digest cache every 10min — prevents 25s cold-start build hitting real users"
```

---

## Final verification

Run all tests:

```bash
npm run test:data
```

Run typecheck:

```bash
npm run typecheck
```

Expected: all pass, no type errors.
