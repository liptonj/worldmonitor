# Fix wss:// Fetch Scheme + CSP Hash Mismatch Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix two production-blocking regressions: (1) every API call fails because `VITE_WS_API_URL=wss://info.5ls.us` is used as an HTTP fetch base URL, and (2) Vite's modulepreload polyfill inline script is blocked by the production CSP.

**Architecture summary:**

The app has two distinct URL uses for `VITE_WS_API_URL`:
- **HTTP redirect target** — `installWebApiRedirect()` rewrites `/api/*` fetch calls to `${WS_API_URL}/api/*`. This needs an `https://` scheme.
- **WebSocket relay** — a separate relay connection that legitimately uses `wss://`.

When the env var is `wss://info.5ls.us`, the HTTP redirect silently sends all `fetch()` calls with a `wss://` URL, which the Fetch API rejects entirely. The fix is a one-line scheme normalization.

The CSP issue is that Vite 5+ injects a `<link rel="modulepreload">` polyfill as an inline `<script>` during build. Its SHA256 hash changes across Vite versions and is not in the `index.html` CSP allowlist. The fix is `build.modulePreload: { polyfill: false }` — modern browsers (Chrome 66+, Firefox 115+, Safari 17+) support modulepreload natively; the polyfill only benefits browsers from ~2020 and earlier.

**Tech Stack:** TypeScript, Vite 5, `src/services/runtime.ts`, `vite.config.ts`, `index.html`

---

## Error Root-Cause Map

| Console Error | Root Cause | Task |
|---|---|---|
| `Fetch API cannot load wss://info.5ls.us/api/*. URL scheme "wss" is not supported.` | `installWebApiRedirect()` uses raw `WS_API_URL` (`wss://...`) as HTTP fetch base | Task 1 |
| `Executing inline script violates Content Security Policy … sha256-Op9U4c…` | Vite injects modulepreload polyfill inline script; its hash is not in CSP | Task 2 |
| `GET https://info.5ls.us/api/rss-proxy?url=…smartraveller… 504` | Upstream RSS server slow; separate server-side issue | N/A (companion plan) |
| `GET https://eonet.gsfc.nasa.gov/api/v3/events 503` | NASA upstream temporarily down; circuit-breaker handles gracefully | N/A |

---

## Task 1: Fix `wss://` scheme in HTTP API redirect

**Root cause:** `src/services/runtime.ts:417` — `const API_BASE = WS_API_URL;`. When `VITE_WS_API_URL=wss://info.5ls.us`, `API_BASE` becomes `wss://info.5ls.us`. Every `/api/*` fetch is rewritten to `wss://info.5ls.us/api/...`, which `window.fetch` rejects immediately.

**Files:**
- Modify: `src/services/runtime.ts` (around line 417 — inside `installWebApiRedirect()`)

**Step 1: Read the function context**

```bash
sed -n '407,455p' src/services/runtime.ts
```

Expected: see `const API_BASE = WS_API_URL;` on line ~417.

**Step 2: Apply the one-line fix**

In `src/services/runtime.ts`, inside `installWebApiRedirect()`, change line 417:

```typescript
// BEFORE
const API_BASE = WS_API_URL;

// AFTER — normalize WebSocket scheme to HTTP for fetch() compatibility
const API_BASE = WS_API_URL.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://');
```

**Why:** `fetch()` only accepts `http://` and `https://` schemes. `wss://` is a WebSocket scheme. The replace normalizes the base URL without changing the host or path, so the redirect still points to the correct server. The WebSocket relay code elsewhere reads `WS_API_URL` directly (not `API_BASE`) and is unaffected.

**Step 3: Verify type-check passes**

```bash
npx tsc --noEmit
```

Expected: no errors.

**Step 4: Manual smoke-test in dev**

```bash
VITE_WS_API_URL=wss://info.5ls.us npm run dev
```

Open `http://localhost:5173`. In Network tab, confirm `/api/bootstrap` is redirected to `https://info.5ls.us/api/bootstrap` (not `wss://`). Confirm no "URL scheme 'wss' is not supported" errors in console.

**Step 5: Commit**

```bash
git add src/services/runtime.ts
git commit -m "fix(runtime): normalize wss:// to https:// in HTTP API redirect base URL"
```

---

## Task 2: Fix Vite modulepreload polyfill CSP hash violation

**Root cause:** Vite 5 injects a small inline `<script>` (the [modulepreload polyfill](https://vitejs.dev/config/build-options.html#build-modulepreload)) into every production HTML output. Its SHA256 hash changes across Vite versions. The `index.html` CSP `script-src` directive has four hardcoded SHA256 hashes for known inline scripts, but none matches the current Vite polyfill. Browsers block the script, logging a CSP violation on every production page load.

The fix is to disable the polyfill injection. All target browsers (Chrome 66+, Firefox 115+, Safari 17+) support `<link rel="modulepreload">` natively. The polyfill only benefits browsers from ~2020.

**Files:**
- Modify: `vite.config.ts` (inside the `build:` block, around line 730)

**Step 1: Read the build block**

```bash
sed -n '728,760p' vite.config.ts
```

Expected: see `build: { chunkSizeWarningLimit: 1200, rollupOptions: { ... } }` with no `modulePreload` key yet.

**Step 2: Add `modulePreload: { polyfill: false }` to the build config**

In `vite.config.ts`, update the `build:` block:

```typescript
// BEFORE
build: {
  chunkSizeWarningLimit: 1200,
  rollupOptions: {
    ...
  },
},

// AFTER
build: {
  chunkSizeWarningLimit: 1200,
  modulePreload: { polyfill: false },
  rollupOptions: {
    ...
  },
},
```

**Why:** With `polyfill: false`, Vite skips injecting the inline polyfill `<script>`. Modern browsers handle `<link rel="modulepreload">` natively. There is no functional regression for the target audience of this app.

**Step 3: Verify type-check passes**

```bash
npx tsc --noEmit
```

Expected: no errors.

**Step 4: Build and verify the polyfill script is gone**

```bash
npm run build 2>&1 | tail -10
```

Then inspect the output HTML:

```bash
grep -c "modulepreload polyfill\|ModulePreload\|sha256" dist/index.html
```

Expected: zero occurrences of the polyfill script in `dist/index.html`. The CSP meta tag in `dist/index.html` should still contain only the original four SHA256 hashes.

**Step 5: Verify the CSP hashes are still valid**

The four hashes in `index.html` correspond to:
- The theme/variant detection IIFE on line 95
- Other known inline scripts

None of these changed. Confirm by checking that the hash list in `dist/index.html` matches `index.html`:

```bash
grep "sha256-" dist/index.html
```

Expected: same four hashes as in `index.html` line 6.

**Step 6: Commit**

```bash
git add vite.config.ts
git commit -m "fix(build): disable Vite modulepreload polyfill to prevent CSP hash violation"
```

---

## Task 3: End-to-end verification

**Step 1: Start dev server with WSS env var to simulate production**

```bash
VITE_WS_API_URL=wss://info.5ls.us npm run dev
```

**Step 2: Check browser console — no wss:// errors**

Open `http://localhost:5173`. Confirm:
- [ ] No `Fetch API cannot load wss://…` errors
- [ ] Network tab shows `/api/bootstrap` redirected to `https://info.5ls.us/api/bootstrap` (200 OK or expected response)
- [ ] No CSP violation for inline scripts (note: the CSP is stripped in dev by `devCspStripPlugin`, so this check is for the production build)

**Step 3: Production build CSP check**

```bash
npm run build && grep "Content-Security-Policy" dist/index.html
```

Confirm the CSP meta tag is present and unchanged in production output.

**Step 4: Optional — deploy to staging and verify**

After deploying to `info.5ls.us`:
- Open DevTools console. Confirm no `wss://` fetch errors and no CSP violation errors on page load.
- Confirm panels load data (Network tab shows `200` responses from `https://info.5ls.us/api/*`).

---

## Summary of Changes

| File | Change | Task |
|---|---|---|
| `src/services/runtime.ts:417` | `const API_BASE = WS_API_URL.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://');` | Task 1 |
| `vite.config.ts` (build block) | Add `modulePreload: { polyfill: false }` | Task 2 |

**Priority:** Task 1 first — it unblocks all API calls (critical). Task 2 second — it stops the CSP noise in production logs.

**Not in scope:**
- 504 errors from `smartraveller.gov.au` — upstream RSS server issue (companion plan)
- 503 from `eonet.gsfc.nasa.gov` — upstream temporarily down, circuit-breaker handles it
