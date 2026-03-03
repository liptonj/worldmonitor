# Fix Console Errors: CSP Hash, EONET Log Level, GDELT Circuit Breaker, RSS Smartraveller Timeout

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Silence or fix the four categories of browser/server console errors visible on production: a CSP hash mismatch blocking an inline script, noisy `console.error` for expected EONET upstream outages, repeated GDELT RPC errors firing without proper deduplication, and Smartraveller RSS proxy calls waiting the full 12-second timeout when that domain is consistently unreachable.

**Architecture:** Pure fixes — no new features. Task 1 is a CSP investigation-then-patch. Tasks 2–4 are one-liners or small config changes. Each is independent and can be committed separately.

**Tech Stack:** TypeScript, Vite 5, Vercel Edge Functions, Vercel `vercel.json` HTTP headers, `api/rss-proxy.js`

---

## Background & Root Causes

| Error | Root Cause | Impact |
|---|---|---|
| `Executing inline script violates CSP … sha256-Op9U4cSnqEjTUG+…` | A fifth inline script is injected in production (Vercel/Cloudflare edge) that has a hash not in the `index.html` meta CSP | Script is blocked on every page load; functionality may be degraded |
| `[EONET] Failed to fetch natural events: Error: EONET API error: 503` | NASA EONET API is down (upstream); `fetchEonetEvents` correctly catches the error and returns `[]`; but uses `console.error` which looks alarming | Noisy red error in console; app still works (GDACS provides fallback data) |
| `[GDELT-Intel] RPC error: internal error` × 3 | The backend GDELT intelligence service is returning HTTP 200 with `{ error: 'internal error' }` in the body; three concurrent topic fetches each log independently | Three red lines on every page load; circuit breaker will kick in after 2 failures (5-min cooldown) |
| `GET https://info.5ls.us/api/rss-proxy?url=…smartraveller…  504` × 3 | `www.smartraveller.gov.au` consistently refuses connections from Vercel edge IPs; the proxy waits the full 12s default timeout before failing | Extends page load time by 12s × 3 parallel fetches (though `Promise.allSettled` prevents blocking the UI) |

---

## CSP Hash Analysis

The `index.html` meta CSP currently has exactly 4 script hashes:

| Hash | Script |
|---|---|
| `sha256-LnMFPWZxTgVOr2VYwIh9mhQ3l/l3+a3SfNOLERnuHfY=` | Full-variant inline detection script (line 94 of built `dist/index.html`) |
| `sha256-+SFBjfmi2XfnyAT3POBxf6JIKYDcNXtllPclOcaNBI0=` | Happy-variant / `settings.html` theme script |
| `sha256-AhZAmdCW6h8iXMyBcvIrqN71FGNk4lwLD+lPxx43hxg=` | Tech-variant inline script |
| `sha256-PnEBZii+iFaNE2EyXaJhRq34g6bdjRJxpLfJALdXYt8=` | Finance-variant inline script |

The **blocked** hash `sha256-Op9U4cSnqEjTUG+fFrRBIbufoUoIFJeShlEDneEmJJ4=` is NOT in the local build (`dist/index.html` has only one inline script). It is being injected at the Vercel/Cloudflare edge on the live production site. The fix is to identify it via `curl` and add it to the CSP.

---

## Task 1: Identify and Add the Missing CSP Hash

**Files:**
- Modify: `index.html` (the `<meta http-equiv="Content-Security-Policy">` tag on line 6)
- Modify: `vercel.json` (the `script-src` inside the `/(.*)`  headers entry)

### Step 1: Fetch live production HTML and extract inline script hashes

Run:

```bash
curl -s -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" \
  https://worldmonitor.app/ \
  | python3 -c "
import sys, hashlib, base64, re

html = sys.stdin.read()

# Extract all executable inline scripts (not type=module, not type=application/ld+json, not src=)
for m in re.finditer(r'<script(?![^>]*(?:type=[\"']module[\"']|type=[\"']application/ld\+json[\"']|src=))[^>]*>([^<]*(?:<(?!/script>)[^<]*)*)</script>', html):
    content = m.group(1)
    h = hashlib.sha256(content.encode()).digest()
    b64 = base64.b64encode(h).decode()
    print(f'sha256-{b64}: {content[:80].strip()}')
"
```

Expected output: all inline scripts with their hashes. You should see `sha256-LnMFPWZxTgVOr2VYwIh9mhQ3l/l3+a3SfNOLERnuHfY=` (the variant detection script) plus the blocked `sha256-Op9U4cSnqEjTUG+fFrRBIbufoUoIFJeShlEDneEmJJ4=` for a NEW script injected by the edge.

### Step 2: Confirm the new hash and identify the script

The new script is almost certainly injected by Vercel's Speed Insights / Cloudflare Beacon. Verify its content from the curl output above.

### Step 3: Add the hash to `index.html`

Open `index.html` line 6 and in the `<meta http-equiv="Content-Security-Policy">` tag, add the new hash to the `script-src` directive.

Current (relevant excerpt):
```
script-src 'self' 'sha256-LnMFPWZxTgVOr2VYwIh9mhQ3l/l3+a3SfNOLERnuHfY=' 'sha256-+SFBjfmi2XfnyAT3POBxf6JIKYDcNXtllPclOcaNBI0=' 'sha256-AhZAmdCW6h8iXMyBcvIrqN71FGNk4lwLD+lPxx43hxg=' 'sha256-PnEBZii+iFaNE2EyXaJhRq34g6bdjRJxpLfJALdXYt8=' 'wasm-unsafe-eval' https://www.youtube.com https://static.cloudflareinsights.com https://vercel.live
```

Add the new hash after the existing four hashes:
```
script-src 'self' 'sha256-LnMFPWZxTgVOr2VYwIh9mhQ3l/l3+a3SfNOLERnuHfY=' 'sha256-+SFBjfmi2XfnyAT3POBxf6JIKYDcNXtllPclOcaNBI0=' 'sha256-AhZAmdCW6h8iXMyBcvIrqN71FGNk4lwLD+lPxx43hxg=' 'sha256-PnEBZii+iFaNE2EyXaJhRq34g6bdjRJxpLfJALdXYt8=' 'sha256-Op9U4cSnqEjTUG+fFrRBIbufoUoIFJeShlEDneEmJJ4=' 'wasm-unsafe-eval' https://www.youtube.com https://static.cloudflareinsights.com https://vercel.live
```

### Step 4: Also add the hash to `vercel.json`

The `vercel.json` HTTP header CSP currently uses `'unsafe-inline'` for `script-src`. Because the `index.html` meta CSP is more restrictive (hash-only), the combined effect is already hash-only — the `'unsafe-inline'` in `vercel.json` is overridden by the meta tag and has NO effect. For clarity and security, update `vercel.json` to also use hashes instead of `'unsafe-inline'`, so the two CSPs are consistent.

In `vercel.json`, find the `Content-Security-Policy` value in the `/(.*)`  headers section and replace `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'` with:

```json
"script-src 'self' 'sha256-LnMFPWZxTgVOr2VYwIh9mhQ3l/l3+a3SfNOLERnuHfY=' 'sha256-+SFBjfmi2XfnyAT3POBxf6JIKYDcNXtllPclOcaNBI0=' 'sha256-AhZAmdCW6h8iXMyBcvIrqN71FGNk4lwLD+lPxx43hxg=' 'sha256-PnEBZii+iFaNE2EyXaJhRq34g6bdjRJxpLfJALdXYt8=' 'sha256-Op9U4cSnqEjTUG+fFrRBIbufoUoIFJeShlEDneEmJJ4=' 'wasm-unsafe-eval' https://www.youtube.com https://static.cloudflareinsights.com https://vercel.live"
```

### Step 5: Verify the hash list is complete

```bash
# Check local build's inline scripts (should still just be 1)
grep -n "<script" dist/index.html | grep -v 'type="module"\|type="application/ld+json"\|src='
```

Expected: Only the variant detection script at line 94.

### Step 6: Type-check

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: zero errors (or only pre-existing non-blocking warnings).

### Step 7: Commit

```bash
git add index.html vercel.json
git commit -m "security: add missing edge-injected CSP hash and sync vercel.json to use hashes"
```

---

## Task 2: Downgrade EONET Failure from `console.error` to `console.warn`

**Files:**
- Modify: `src/services/eonet.ts` line 169

The `fetchEonetEvents` function already handles 503 errors gracefully (returns `[]`, GDACS provides fallback data). Using `console.error` implies an unrecoverable problem; `console.warn` is correct because the app continues functioning normally.

### Step 1: Open `src/services/eonet.ts` and find the catch block

Current code at lines 168–171:
```typescript
  } catch (error) {
    console.error('[EONET] Failed to fetch natural events:', error);
    return [];
  }
```

### Step 2: Replace `console.error` with `console.warn`

Change to:
```typescript
  } catch (error) {
    console.warn('[EONET] Upstream unavailable (using GDACS fallback):', error);
    return [];
  }
```

### Step 3: Verify no regressions

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: zero errors.

### Step 4: Commit

```bash
git add src/services/eonet.ts
git commit -m "fix(eonet): downgrade upstream 503 log from error to warn (GDACS fallback active)"
```

---

## Task 3: Reduce Smartraveller RSS Proxy Timeout from 12s to 3s

**Files:**
- Modify: `api/rss-proxy.js` (the timeout calculation, around line 385–387)

`www.smartraveller.gov.au` consistently fails to respond from Vercel Edge IPs. Each call wastes 12 seconds before timing out. With 3 parallel feed fetches (`Promise.allSettled`), this wastes ~12 seconds of Vercel function billing per user page load. A 3-second fast-fail is appropriate since there is no realistic chance of success.

### Step 1: Read the current timeout logic in `api/rss-proxy.js`

Find the section that currently reads (around line 385):
```javascript
// Google News is slow - use longer timeout
const isGoogleNews = hostname === 'news.google.com';
const timeout = isGoogleNews ? 20000 : 12000;
```

### Step 2: Add a fast-fail set and update the timeout calculation

Add after the `RELAY_ONLY_DOMAINS` set (around line 27) a new set:

```javascript
// Domains that consistently time out from Vercel edge IPs — fail fast to save cost.
const FAST_FAIL_DOMAINS = new Set([
  'www.smartraveller.gov.au',
]);
```

Then replace the timeout calculation block:
```javascript
// Google News is slow - use longer timeout
const isGoogleNews = hostname === 'news.google.com';
const timeout = isGoogleNews ? 20000 : 12000;
```

With:
```javascript
// Tuned timeouts per domain class:
//   slow  – Google News CDN is legitimately slow
//   fast-fail – consistently unreachable from Vercel edge (saves function billing time)
//   default – standard 12s for everything else
const isGoogleNews = hostname === 'news.google.com';
const isFastFail = FAST_FAIL_DOMAINS.has(hostname);
const timeout = isGoogleNews ? 20000 : isFastFail ? 3000 : 12000;
```

### Step 3: Verify the logic manually

```bash
node -e "
const FAST_FAIL_DOMAINS = new Set(['www.smartraveller.gov.au']);
const cases = [
  { hostname: 'www.smartraveller.gov.au', expected: 3000 },
  { hostname: 'news.google.com', expected: 20000 },
  { hostname: 'feeds.bbci.co.uk', expected: 12000 },
];
cases.forEach(({ hostname, expected }) => {
  const isGoogleNews = hostname === 'news.google.com';
  const isFastFail = FAST_FAIL_DOMAINS.has(hostname);
  const timeout = isGoogleNews ? 20000 : isFastFail ? 3000 : 12000;
  const status = timeout === expected ? 'PASS' : 'FAIL';
  console.log(status, hostname, '→', timeout, 'ms');
});
"
```

Expected:
```
PASS www.smartraveller.gov.au → 3000 ms
PASS news.google.com → 20000 ms
PASS feeds.bbci.co.uk → 12000 ms
```

### Step 4: Commit

```bash
git add api/rss-proxy.js
git commit -m "perf(rss-proxy): fast-fail smartraveller.gov.au after 3s (was 12s; consistently unreachable)"
```

---

## Notes on Non-Actionable Errors

### GDELT RPC "internal error" × 3
- **Status:** Handled correctly — the circuit breaker (`maxFailures: 2`, 5-min cooldown) will stop retrying after 2 failures. After the cooldown, it retries once.
- **Why 3 errors?** Three concurrent topic fetches (`loadActiveTopic` → `$5` → `createPanels`) each call `fetchGdeltArticles` independently with different queries, each hitting the broken backend.
- **Action:** None required — the circuit breaker suppresses further calls within the cooldown window. If this persists (backend continuously down), investigate Vercel function logs for the intelligence edge function (`/api/intelligence/v1/search-gdelt-documents`) to see the upstream GDELT error.

### aria-hidden YouTube
- **Status:** This is a YouTube player SDK bug — the YouTube iframe's internal DOM sets `aria-hidden` on a parent element while a button inside it retains focus. We do not control the YouTube player's internal DOM.
- **Action:** None — this is a known YouTube accessibility issue reported to YouTube. The warning is cosmetic and has no functional impact.

### EONET 503 (upstream NASA outage)
- **Status:** Already handled — `fetchEonetEvents` catches the error and returns `[]`; `fetchNaturalEvents` merges GDACS data as fallback. After Task 2, the log will be `console.warn` instead of `console.error`.
- **Action:** Completed by Task 2.

---

## Verification Checklist

After all tasks are complete:

```bash
# 1. TypeScript clean
npx tsc --noEmit 2>&1 | grep -E "error TS" | head -10

# 2. CSP hash present in index.html
grep "Op9U4cSnqEjTUG" index.html && echo "PASS: hash added" || echo "FAIL: hash missing"

# 3. CSP consistent in vercel.json (no unsafe-inline in script-src)
grep "unsafe-inline" vercel.json | grep "script-src" && echo "FAIL: unsafe-inline still present" || echo "PASS: cleaned"

# 4. EONET warn not error
grep "console.error.*EONET" src/services/eonet.ts && echo "FAIL: still console.error" || echo "PASS: changed to warn"

# 5. Smartraveller fast-fail set present
grep "FAST_FAIL_DOMAINS" api/rss-proxy.js && echo "PASS: set exists" || echo "FAIL: set missing"
grep "smartraveller" api/rss-proxy.js | grep "FAST_FAIL_DOMAINS\|3000" && echo "PASS: timeout reduced" || echo "FAIL: timeout not reduced"
```
