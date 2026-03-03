# Middleware Variant Host Detection Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make social OG preview metadata work for any hostname whose subdomain prefix matches a variant (e.g. `tech.info.5ls.us`, `finance.info.5ls.us`), not just the hardcoded `worldmonitor.app` subdomains.

**Architecture:** Replace the exact-match `VARIANT_HOST_MAP` lookup in `middleware.ts` with a helper function `resolveVariantFromHost()` that first tries the exact map (for canonical URLs), then falls back to prefix detection (`host.startsWith('tech.')` etc.) — mirroring the logic already used in `src/config/variant.ts`. The canonical OG image/URL values continue pointing to `worldmonitor.app` so social cards always link back to the primary domain.

**Tech Stack:** TypeScript, Vercel Edge Middleware (Next.js middleware), Node.js built-in test runner (`node:test`)

---

## Background

`middleware.ts` currently looks up the variant using:

```typescript
const variant = VARIANT_HOST_MAP[host]; // exact match only
```

`VARIANT_HOST_MAP` only contains:
- `tech.worldmonitor.app`
- `finance.worldmonitor.app`
- `happy.worldmonitor.app`

So `tech.info.5ls.us` passes `isAllowedHost()` but gets no OG metadata — `variant` is `undefined` and the social preview block is skipped.

`src/config/variant.ts` already handles this correctly with `h.startsWith('tech.')`. The middleware needs the same logic.

---

### Task 1: Create the middleware test file

**Files:**
- Create: `middleware.test.mjs`

**Step 1: Create the test file with failing tests**

```javascript
// middleware.test.mjs
import { strict as assert } from 'node:assert';
import test from 'node:test';

// Helper: build a minimal Request that middleware() receives
function makeRequest(host, { path = '/', ua = 'Twitterbot/1.0' } = {}) {
  return new Request(`https://${host}${path}`, {
    headers: {
      host,
      'user-agent': ua,
    },
  });
}

// Dynamic import so we can re-import after edits if needed
const { default: middleware } = await import('./middleware.ts');

// --- OG variant detection ---

test('serves tech OG for tech.worldmonitor.app (exact map)', async () => {
  const req = makeRequest('tech.worldmonitor.app');
  const res = middleware(req);
  assert.ok(res instanceof Response, 'should return a Response');
  const text = await res.text();
  assert.ok(text.includes('Tech Monitor'), 'should include Tech Monitor title');
  assert.ok(text.includes('tech.worldmonitor.app'), 'OG url should be canonical');
});

test('serves tech OG for tech.info.5ls.us (prefix detection)', async () => {
  const req = makeRequest('tech.info.5ls.us');
  const res = middleware(req);
  assert.ok(res instanceof Response, 'should return a Response');
  const text = await res.text();
  assert.ok(text.includes('Tech Monitor'), 'should include Tech Monitor title');
});

test('serves finance OG for finance.info.5ls.us (prefix detection)', async () => {
  const req = makeRequest('finance.info.5ls.us');
  const res = middleware(req);
  assert.ok(res instanceof Response, 'should return a Response');
  const text = await res.text();
  assert.ok(text.includes('Finance Monitor'), 'should include Finance Monitor title');
});

test('serves happy OG for happy.info.5ls.us (prefix detection)', async () => {
  const req = makeRequest('happy.info.5ls.us');
  const res = middleware(req);
  assert.ok(res instanceof Response, 'should return a Response');
  const text = await res.text();
  assert.ok(text.includes('Happy Monitor'), 'should include Happy Monitor title');
});

test('returns undefined (no OG) for info.5ls.us (no variant prefix)', () => {
  const req = makeRequest('info.5ls.us');
  const res = middleware(req);
  // full/default variant has no OG entry — middleware should not return a Response for root
  assert.equal(res, undefined, 'should not intercept non-variant host at root');
});

test('returns undefined for non-social-bot UA', () => {
  const req = makeRequest('tech.info.5ls.us', { ua: 'Mozilla/5.0 Chrome/120' });
  const res = middleware(req);
  assert.equal(res, undefined, 'regular browsers should not get OG intercept');
});

test('canonical OG url always points to worldmonitor.app, not 5ls.us', async () => {
  const req = makeRequest('tech.info.5ls.us');
  const res = middleware(req);
  const text = await res.text();
  assert.ok(text.includes('https://tech.worldmonitor.app/'), 'canonical OG url must be worldmonitor.app');
  assert.ok(!text.includes('5ls.us'), 'OG url must not use 5ls.us domain');
});
```

**Step 2: Run to confirm tests fail**

```bash
node --test middleware.test.mjs
```

Expected output: several failures like `TypeError: middleware is not a function` or test assertion failures for the prefix-detection cases. This confirms the tests are real.

**Step 3: Commit the failing tests**

```bash
git add middleware.test.mjs
git commit -m "test: add failing middleware OG variant detection tests"
```

---

### Task 2: Fix `middleware.ts` — replace exact-map lookup with prefix detection

**Files:**
- Modify: `middleware.ts:14-18` (the `VARIANT_HOST_MAP` block and its usage at line 67)

**Step 1: Replace the `VARIANT_HOST_MAP` lookup with `resolveVariantFromHost()`**

Open `middleware.ts`. Make two changes:

**Change A** — replace the static map with a function (around lines 14–18):

```typescript
// BEFORE
const VARIANT_HOST_MAP: Record<string, string> = {
  'tech.worldmonitor.app': 'tech',
  'finance.worldmonitor.app': 'finance',
  'happy.worldmonitor.app': 'happy',
};
```

```typescript
// AFTER
const CANONICAL_VARIANT_HOSTS: Record<string, string> = {
  'tech.worldmonitor.app': 'tech',
  'finance.worldmonitor.app': 'finance',
  'happy.worldmonitor.app': 'happy',
};

function resolveVariantFromHost(host: string): string | null {
  if (CANONICAL_VARIANT_HOSTS[host]) return CANONICAL_VARIANT_HOSTS[host];
  if (host.startsWith('tech.')) return 'tech';
  if (host.startsWith('finance.')) return 'finance';
  if (host.startsWith('happy.')) return 'happy';
  return null;
}
```

**Change B** — update the usage in `middleware()` (around line 67):

```typescript
// BEFORE
const variant = VARIANT_HOST_MAP[host];
if (variant && isAllowedHost(host)) {
```

```typescript
// AFTER
const variant = resolveVariantFromHost(host);
if (variant && isAllowedHost(host)) {
```

**Step 2: Run tests to verify they pass**

```bash
node --test middleware.test.mjs
```

Expected: all 7 tests pass.

**Step 3: Commit the fix**

```bash
git add middleware.ts middleware.test.mjs
git commit -m "fix: resolve OG variant from hostname prefix, not just exact map

tech.info.5ls.us and similar subdomains now receive correct social OG
metadata. Canonical OG image/url still points to worldmonitor.app."
```

---

### Task 3: Add the test to the sidecar test script

**Files:**
- Modify: `package.json` — the `"test:sidecar"` script

**Step 1: Update the test:sidecar script**

Open `package.json` and find `"test:sidecar"`. Add `middleware.test.mjs` to the file list:

```json
"test:sidecar": "node --test src-tauri/sidecar/local-api-server.test.mjs api/_cors.test.mjs api/youtube/embed.test.mjs api/cyber-threats.test.mjs api/usni-fleet.test.mjs scripts/ais-relay-rss.test.cjs api/loaders-xml-wms-regression.test.mjs middleware.test.mjs"
```

**Step 2: Run the full sidecar suite to confirm nothing broke**

```bash
npm run test:sidecar
```

Expected: all tests pass.

**Step 3: Commit**

```bash
git add package.json
git commit -m "chore: add middleware test to test:sidecar suite"
```

---

## Verification

After all tasks complete, manually verify:

1. `npm run test:sidecar` — all pass
2. In browser on localhost, open DevTools Network tab, set User-Agent to `Twitterbot/1.0`, and navigate to `http://localhost:5173/` — you should see the full/default response (no OG intercept since localhost isn't a variant host)
3. The OG tags in the HTML response for `tech.info.5ls.us` must show `og:url = https://tech.worldmonitor.app/` (canonical URL), not `https://tech.info.5ls.us/`
