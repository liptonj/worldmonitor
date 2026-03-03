# Fix 401/403/CORS/CSP/Map-Render Errors Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Resolve the 401 Unauthorized, 403 Forbidden, CORS policy, CSP inline-script, and map `TypeError: Cannot read properties of null (reading 'id')` errors reported in the browser console so the app loads data and renders map layers correctly.

**Architecture summary:**

The app runs in two modes:

1. **Web (browser)** — Vite dev server or Vercel production. API calls go to `/api/*` (same-origin). Auth is origin-checked: requests from `localhost`, `5ls.us`, or `worldmonitor.app` do not require an API key.
2. **Desktop (Tauri)** — Sidecar local API + cloud fallback. Cloud fallback requires `X-WorldMonitor-Key` from `WORLDMONITOR_VALID_KEYS`.

The `WORLDMONITOR_VALID_KEYS` env var is set in `.env` (local dev). On the deployed server (`info.5ls.us`), this env var must be set in the Vercel dashboard. If it is NOT set there (or empty), any request without a matching key will get a 401 — even from trusted origins if a key happens to be sent.

Auth logic file: `api/_api-key.js`  
Gateway file: `server/gateway.ts`  
Runtime/fetch intercept: `src/services/runtime.ts`

---

## Error Root-Cause Map

| Console Error | Root Cause | Fix |
|---|---|---|
| `401` on `/api/bootstrap`, `/api/economic/v1/get-macro-signals`, etc. | `WORLDMONITOR_VALID_KEYS` not set on the Vercel deployment at `info.5ls.us`, OR a key is being sent that doesn't match | Task 1 |
| `403` on `POST /api/infrastructure/v1/record-baseline-snapshot` | Origin header missing or blocked; gateway returns 403 before checking auth | Task 2 |
| `403` on `POST /api/news/v1/summarize-article` | Same as above (origin check fails) | Task 2 |
| `CORS` on `https://gamma-api.polymarket.com` | Browser-side code calling Gamma API directly; blocked by Gamma CORS policy | Task 3 |
| `CSP inline script` violation | Vite HMR injects inline scripts that are not in the `index.html` CSP hash allowlist | Task 4 |
| `wss://info.5ls.us` not in hostname allowlist | `VITE_WS_API_URL` is set to `wss://info.5ls.us` in the server's environment but the `ALLOWED_REDIRECT_HOSTS` regex only allows `https://` not `wss://` | Task 5 |
| `TypeError: Cannot read properties of null (reading 'id')` in DeckGLMap/maplibre | Map layer receives null/undefined items from an empty API response (caused by the 401s above) | Task 6 (self-heals once 401s are fixed; add defensive guard) |
| `On cooldown for 300s` messages | Expected circuit-breaker behavior after repeated 401 failures; self-heals after auth is fixed | N/A |
| `503` from `eonet.gsfc.nasa.gov` | NASA upstream temporarily down; handled in companion plan `2026-03-02-fix-api-502-503-504-errors.md` | See companion plan |

---

## Task 1: Fix 401 errors — verify and align `WORLDMONITOR_VALID_KEYS` on deployed server

**Context:** `api/_api-key.js` `validateApiKey()` returns `{ valid: false, required: true }` when the origin is unknown or the key doesn't match `WORLDMONITOR_VALID_KEYS`. The `.env` sets `WORLDMONITOR_VALID_KEYS=wm_6f32b724be231b7cad070dd80e802c0c89ad635b91dc8f23`, but this only applies to local `vercel dev`. If the deployed Vercel project doesn't have this env var set, any request to the deployed API will 401.

The console shows requests to `https://info.5ls.us/api/...` 401-ing. `info.5ls.us` is a preview/custom domain pointing to the Vercel deployment.

**Files to read:**
- `api/_api-key.js` (already read above — understand auth flow)
- `.env` (already read — local key is set)

**Step 1: Diagnose — check what origin the browser is sending**

Open browser DevTools Network tab on `http://info.5ls.us:3000` (or wherever the app is served), click any failing `/api/...` request, and check the Request Headers section. Look for:

- `Origin:` header — should be `https://info.5ls.us` or `http://info.5ls.us`
- `X-WorldMonitor-Key:` header — check if one is being sent

If `Origin` is `http://info.5ls.us` (plain HTTP), it matches the `isTrustedBrowserOrigin` check in `_api-key.js` and should NOT need a key. If it is 401-ing, the key being sent is invalid.

**Step 2: Check if `WORLDMONITOR_VALID_KEYS` is set on Vercel**

```bash
# If you have Vercel CLI installed:
vercel env ls
# Look for WORLDMONITOR_VALID_KEYS in the output
```

Or check the Vercel dashboard: Project → Settings → Environment Variables.

**Step 3: Determine if a key is being sent from the browser**

In `src/services/runtime-config.ts` (or wherever `WORLDMONITOR_API_KEY` is read), check if a key is being loaded from `localStorage` or settings and sent as `X-WorldMonitor-Key`. If yes, and the key in the browser doesn't match `WORLDMONITOR_VALID_KEYS` on Vercel, all API calls will 401.

```bash
rg "WORLDMONITOR_API_KEY\|X-WorldMonitor-Key" src/ --type ts | head -20
```

**Step 4: Fix — sync the key**

Option A (simplest): Ensure `WORLDMONITOR_VALID_KEYS` on the Vercel deployment includes the key from `.env`. On Vercel dashboard, set:
```
WORLDMONITOR_VALID_KEYS=wm_6f32b724be231b7cad070dd80e802c0c89ad635b91dc8f23
```

Option B: Clear the key from browser localStorage (if a stale/wrong key is stored). In the browser console:
```javascript
localStorage.removeItem('worldmonitor-api-key');
// or whatever key name is used
```

Option C: If the app is running locally and hitting the local Vercel dev server, ensure `vercel dev` is running so `.env` is loaded.

**Step 5: Verify fix**

Reload the app and confirm the Network tab shows `200` on `/api/bootstrap` and `/api/economic/v1/get-macro-signals`.

**No code changes needed for this task** — it is a configuration issue. Only proceed to code changes if the diagnosis in Steps 1–3 reveals a logic bug in the auth flow.

---

## Task 2: Fix 403 on `POST /api/infrastructure/v1/record-baseline-snapshot` and `POST /api/news/v1/summarize-article`

**Context:** The `gateway.ts` returns 403 when `isDisallowedOrigin(request)` returns true. This happens when the `Origin` header is present but does NOT match `ALLOWED_ORIGIN_PATTERNS` in `server/cors.ts`. A plain-HTTP origin like `http://info.5ls.us:3000` (dev server) matches `^https:\/\/(.*\.)?5ls\.us$` only for HTTPS. If the page is served over HTTP, the Origin won't match and the gateway returns 403.

**Files:**
- `server/cors.ts` (already read)
- `api/_cors.js` (already read)

**Step 1: Confirm root cause**

In the browser DevTools, check the Request Headers for the failing POST request. Specifically look at the `Origin` header value. If it is `http://info.5ls.us:3000` (plain HTTP with port), it will not match the pattern `^https:\/\/(.*\.)?5ls\.us$`.

**Step 2: Fix `server/cors.ts` — add HTTP localhost-like patterns for local dev**

Read the file:
```bash
cat server/cors.ts
```

Add a dev-mode pattern that also allows `http://info.5ls.us:*` when `NODE_ENV !== 'production'`. The TypeScript version is in `server/cors.ts` and the JavaScript version is in `api/_cors.js`.

In `server/cors.ts`, update `DEV_PATTERNS` to include:
```typescript
const DEV_PATTERNS: RegExp[] = [
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
  /^http:\/\/info\.5ls\.us(:\d+)?$/,  // Add: local dev over HTTP
];
```

In `api/_cors.js`, add the same pattern to `ALLOWED_ORIGIN_PATTERNS` inside the dev-only branch. Find the existing dev patterns:
```javascript
// In api/_cors.js, the file has no dev/prod split — all patterns are always active.
// Add the HTTP variant of 5ls.us:
/^http:\/\/(.*\.)?5ls\.us(:\d+)?$/,   // Add: allows HTTP origin for local testing
```

**Important:** The JS file (`api/_cors.js`) is used in Vercel Edge Functions and is always in "production" mode once deployed. This addition allows `http://5ls.us:*` in dev testing; it does NOT affect production since production traffic is HTTPS.

**Step 3: Run type-check**

```bash
npm run typecheck
```

Expected: no errors.

**Step 4: Commit**

```bash
git add server/cors.ts api/_cors.js
git commit -m "fix: allow http://5ls.us:* origin in CORS patterns for local dev access"
```

---

## Task 3: Fix CORS error on `gamma-api.polymarket.com`

**Context:** The browser console shows:
```
Access to fetch at 'https://gamma-api.polymarket.com/events?...' from origin 'https://info.5ls.us'
has been blocked by CORS policy
```

This is happening in `src/services/prediction/index.ts`. The code has a `probeDirectFetchCapability()` function that sets `directFetchWorks = false` for non-desktop runtimes. However, the `directFetchProbe` Promise still fires (line 82) with a fetch to `${GAMMA_API}/events?...`.

**Files:**
- `src/services/prediction/index.ts` (already read)

**Step 1: Read the full `probeDirectFetchCapability` function**

```bash
sed -n '70,110p' src/services/prediction/index.ts
```

**Step 2: Identify the probe call site**

Look for where `probeDirectFetchCapability()` or `directFetchProbe` is called. If it is called even when `isDesktopRuntime()` returns false, the fetch runs and causes the CORS error.

**Step 3: Add early guard to prevent the probe fetch**

In `probeDirectFetchCapability()`, the code should return early BEFORE starting the network request, not after. Fix the early return so it prevents the fetch:

```typescript
async function probeDirectFetchCapability(): Promise<boolean> {
  // Browser runtime cannot call Gamma API directly due CORS.
  // Early guard: skip the network probe entirely — don't even start the fetch.
  if (!isDesktopRuntime()) {
    directFetchWorks = false;
    return false;
  }
  // ... rest of function (only runs on desktop)
  if (directFetchWorks !== null) return directFetchWorks;
  // ...existing fetch probe code...
}
```

Verify the guard is placed BEFORE `directFetchProbe = (async () => { ... })()` — if the probe is already assigned at the start of the function and the early return is inside the async arrow, the fetch still starts. The fix is to add the guard before any async work begins.

**Step 4: Run type-check**

```bash
npm run typecheck
```

Expected: no errors.

**Step 5: Commit**

```bash
git add src/services/prediction/index.ts
git commit -m "fix: skip Gamma API probe fetch in browser runtime to prevent CORS error"
```

---

## Task 4: Fix CSP inline-script violation (Vite dev mode)

**Context:** The CSP in `index.html` line 6 uses `sha256-*` hashes for the known inline script on line 95. However, Vite's dev server injects **additional** inline scripts for HMR (Hot Module Replacement) that are not hash-listed. These generate the CSP violation warning.

This is a dev-mode-only issue. In production builds, Vite does not inject inline scripts and the CSP hashes are valid. The warning is cosmetic for local dev but is worth suppressing.

**Files:**
- `index.html`
- `vite.config.ts`

**Step 1: Read the vite config for the dev server section**

```bash
grep -n "server\|headers\|ContentSecurity\|csp" vite.config.ts | head -30
```

**Step 2: Add `'unsafe-inline'` to `script-src` for dev mode OR remove CSP header from dev server**

Option A (Recommended — suppress CSP header in Vite dev server only):

In `vite.config.ts`, find the `server` config block and add custom headers that remove the CSP in dev:

```typescript
server: {
  headers: {
    // Remove the HTML meta CSP in dev mode — Vite HMR needs inline scripts.
    // Production CSP is set via the index.html meta tag (not affected by this).
    'Content-Security-Policy': '',
  },
},
```

However, a `<meta>` CSP tag in `index.html` cannot be overridden by server headers (meta tags take precedence for browsers when served via HTTP, or vice versa depending on browser). The safest approach is:

Option B (Recommended — use a separate dev HTML file or vite plugin):

In `vite.config.ts`, use the existing `htmlVariantPlugin` or add a new plugin to strip the `<meta http-equiv="Content-Security-Policy"...>` tag when building in dev mode:

```typescript
function devCspStripPlugin(): Plugin {
  return {
    name: 'dev-csp-strip',
    apply: 'serve', // Only applies during `vite dev`, not builds
    transformIndexHtml(html) {
      // Strip the CSP meta tag so Vite HMR inline scripts are not blocked
      return html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*\/>/i, '<!-- CSP removed in dev mode -->');
    },
  };
}
```

Add to the plugins array in `vite.config.ts`:
```typescript
plugins: [
  devCspStripPlugin(),
  // ... existing plugins
]
```

**Step 3: Run `npm run dev` and verify no CSP violation appears in console**

```bash
npm run dev
```

Open `http://localhost:5173` and check console — should have no `Content Security Policy` violation errors.

**Step 4: Verify production build is not affected**

```bash
npm run build
# Then check dist/index.html still has the CSP meta tag:
grep "Content-Security-Policy" dist/index.html
```

Expected: CSP tag is present in the production build.

**Step 5: Commit**

```bash
git add vite.config.ts
git commit -m "fix: strip CSP meta tag in Vite dev mode to allow HMR inline scripts"
```

---

## Task 5: Fix `VITE_WS_API_URL` blocked — hostname allowlist mismatch

**Context:** The console shows:
```
[runtime] VITE_WS_API_URL blocked — not in hostname allowlist: wss://info.5ls.us
```

This comes from `src/services/runtime.ts` line 408:
```typescript
const ALLOWED_REDIRECT_HOSTS = /^https:\/\/([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)*(worldmonitor\.app|5ls\.us)(:\d+)?$/;
```

The regex only allows `https://` but `VITE_WS_API_URL` is set to `wss://info.5ls.us`. The `isAllowedRedirectTarget` function parses the URL then checks `parsed.origin` against the regex. `new URL('wss://info.5ls.us').origin` returns `wss://info.5ls.us` which does NOT match `^https://...`.

The `.env` shows `VITE_WS_API_URL=` (empty) locally, but the deployed server must have this set to `wss://info.5ls.us`, triggering the blockage.

**Files:**
- `src/services/runtime.ts` lines 394–411

**Step 1: Read the `isAllowedRedirectTarget` function**

```bash
sed -n '394,412p' src/services/runtime.ts
```

**Step 2: Fix the regex to accept `wss://` and `https://` origins for trusted hosts**

In `src/services/runtime.ts`, change:

```typescript
// OLD
const ALLOWED_REDIRECT_HOSTS = /^https:\/\/([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)*(worldmonitor\.app|5ls\.us)(:\d+)?$/;

function isAllowedRedirectTarget(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ALLOWED_REDIRECT_HOSTS.test(parsed.origin) || parsed.hostname === 'localhost';
  } catch {
    return false;
  }
}
```

To:

```typescript
// NEW — accepts both https:// and wss:// origins for the trusted domains
const ALLOWED_REDIRECT_HOSTS = /^(https|wss):\/\/([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)*(worldmonitor\.app|5ls\.us)(:\d+)?$/;

function isAllowedRedirectTarget(url: string): boolean {
  try {
    const parsed = new URL(url);
    // Check both the origin (for https) and the full href start (for wss, which has no 'origin' per spec)
    const normalized = `${parsed.protocol}//${parsed.host}`;
    return ALLOWED_REDIRECT_HOSTS.test(normalized) || parsed.hostname === 'localhost';
  } catch {
    return false;
  }
}
```

**Step 3: Run type-check**

```bash
npm run typecheck
```

Expected: no errors.

**Step 4: Commit**

```bash
git add src/services/runtime.ts
git commit -m "fix: allow wss:// protocol in VITE_WS_API_URL hostname allowlist check"
```

---

## Task 6: Fix `TypeError: Cannot read properties of null (reading 'id')` in DeckGLMap

**Context:** The map throws `Uncaught TypeError: Cannot read properties of null (reading 'id')` originating from `deck-stack` and `maplibre`. This happens when a deck.gl Layer receives an array that contains `null` items — specifically in data arrays that come from API responses. When the API 401s, data arrays are empty or partially populated, and map layer data callbacks may receive `null` entries.

The error originates from the GeoJson/ScatterPlot layers in `src/components/DeckGLMap.ts` when `getSourcePosition`, `getTargetPosition`, or similar callbacks access `.id` on a `null` item.

**Files:**
- `src/components/DeckGLMap.ts`

**Step 1: Identify the layers using `.id` on items**

```bash
rg "\.id\b" src/components/DeckGLMap.ts | grep -v "//\|layerId\|layer\.id\|deck\.id\|map\.id" | head -30
```

**Step 2: Add null guards on data array callbacks**

For each deck.gl layer that uses an accessor like `getPosition`, `getSourcePosition`, `getTargetPosition`, `getPath`, etc., wrap the data array to filter out null/undefined items before it reaches deck.gl:

**Pattern A — filter before passing to layer:**
```typescript
// Before:
data: militaryFlights,
getPosition: (d) => [d.lon, d.lat],

// After:
data: militaryFlights?.filter(Boolean) ?? [],
getPosition: (d) => [d.lon, d.lat],
```

**Pattern B — guard inside accessor (for cases where filtering might lose items):**
```typescript
// Before:
getPosition: (d) => [d.lon, d.lat],

// After:
getPosition: (d) => (d ? [d.lon, d.lat] : [0, 0]),
```

Apply both patterns to all layers in `DeckGLMap.ts` that reference `.id`, `.lon`, `.lat`, or other properties.

**Step 3: Look specifically for the layers used in military flights and earthquakes**

These are called out in the error stack trace (the error appears after military flights and earthquakes data loads):

```bash
sed -n '1,50p' src/components/DeckGLMap.ts  # Read imports
rg "militaryFlights\|earthquakes" src/components/DeckGLMap.ts | head -20
```

Find the specific layer definitions using these datasets and add `?.filter(Boolean) ?? []` to their `data` prop.

**Step 4: Verify fix by checking TypeScript**

```bash
npm run typecheck
```

Expected: no errors.

**Step 5: Commit**

```bash
git add src/components/DeckGLMap.ts
git commit -m "fix: add null guards on deck.gl layer data arrays to prevent TypeError on null items"
```

---

## Task 7: End-to-end verification

**Step 1: Start the dev server**

```bash
npm run dev
```

**Step 2: Open browser and check console**

Load `http://localhost:5173`. Confirm:

- [ ] No `Content-Security-Policy` violation in console (Task 4 fix)
- [ ] No `VITE_WS_API_URL blocked — not in hostname allowlist` warning (Task 5 fix)
- [ ] Network tab shows `200` on `/api/bootstrap` (Task 1 fix)
- [ ] Network tab shows `200` on POST requests to `/api/infrastructure/v1/record-baseline-snapshot` and `/api/news/v1/summarize-article` (Task 2 fix)
- [ ] No CORS error for `gamma-api.polymarket.com` (Task 3 fix)
- [ ] No `TypeError: Cannot read properties of null (reading 'id')` in console (Task 6 fix)

**Step 3: Smoke test deployed endpoint**

```bash
# Replace <DEPLOYMENT_URL> with info.5ls.us or the Vercel URL
curl -s -w "\nHTTP %{http_code}" "https://<DEPLOYMENT_URL>/api/bootstrap" | tail -1
# Expected: HTTP 200
```

**Step 4: Final commit (if any cleanup needed)**

```bash
git add -A
git commit -m "fix: resolve 401/403/CORS/CSP/map-render errors in dev and deployed environments"
```

---

## Summary of Changes

| File | Change | Task |
|---|---|---|
| `server/cors.ts` | Add `http://(.*\.)?5ls\.us(:\d+)?` to dev CORS patterns | Task 2 |
| `api/_cors.js` | Add `http://(.*\.)?5ls\.us(:\d+)?` to allowed origins | Task 2 |
| `src/services/prediction/index.ts` | Move `isDesktopRuntime()` guard before async probe fetch | Task 3 |
| `vite.config.ts` | Add `devCspStripPlugin()` to strip CSP meta in dev mode | Task 4 |
| `src/services/runtime.ts` | Extend `ALLOWED_REDIRECT_HOSTS` regex to accept `wss://` protocol | Task 5 |
| `src/components/DeckGLMap.ts` | Add `.filter(Boolean) ?? []` guards on layer data arrays | Task 6 |

**Configuration only (no code change):**

| Config | Change | Task |
|---|---|---|
| Vercel env vars | Set `WORLDMONITOR_VALID_KEYS` on deployed project to match `.env` | Task 1 |
| Browser localStorage | Clear stale `worldmonitor-api-key` if a bad key is stored | Task 1 |

**Priority order:** Task 1 (auth config) → Task 2 (CORS 403) → Task 5 (WS allowlist) → Task 3 (Polymarket CORS) → Task 4 (CSP/dev) → Task 6 (map null guard)

Task 1 unblocks the most errors since the 401s are the root cause of the cooldown-suppressed retry storm and the empty data that leads to the map TypeError.
