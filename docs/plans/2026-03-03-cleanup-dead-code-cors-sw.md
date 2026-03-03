# Cleanup: Dead Code, CORS Tightening & Node.js Pinning

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove three categories of outstanding technical debt: orphaned dead-code files, a CORS HTTP-permission gap in production, and an undocumented Node.js version constraint that causes local SW build failures.

**Architecture:** Pure cleanup — no new features. Deleting files reduces attack surface and bundle risk; tightening CORS prevents unintended HTTP origin acceptance; pinning Node.js via `.nvmrc` + `package.json#engines` eliminates the terser/workbox crash on Node v25.

**Tech Stack:** TypeScript, Vite 5, vite-plugin-pwa 1.2.0 / workbox-build 7.4.0, Vercel Edge Functions

---

## Background & Root Causes

| Issue | Root Cause | Impact |
|---|---|---|
| `DownloadBanner.ts` / `CommunityWidget.ts` exist but are never imported | Feature removed without deleting the source file | Dead code ships in repo; tree-shaker drops it at build time, but it clutters the codebase and confuses future devs |
| `trackDownloadClicked` / `trackDownloadBannerDismissed` in `analytics.ts` | Same as above — functions left behind when their callers were deleted | Exported no-ops that lint tools can't catch as "unused" because they are re-exported |
| `api/_cors.js` allows `http://5ls.us` in all envs | Pattern `^https?://` covers HTTP too, not just HTTPS | In production, any `http://5ls.us` origin passes CORS; localhost patterns already cover legit HTTP dev use |
| SW build exits with terser crash on Node v25 | workbox-build 7.4.0 uses terser internally; its async Promise chain breaks on Node 25's stricter exit handling | `npm run build` fails locally; Vercel builds on Node 20/22 and succeed, so production is unaffected — but local devs get a broken build |

---

## Task 1: Delete Orphaned Component Files

**Files:**
- Delete: `src/components/DownloadBanner.ts`
- Delete: `src/components/CommunityWidget.ts`

**Step 1: Confirm no imports exist**

```bash
grep -rn "DownloadBanner\|CommunityWidget\|mountCommunityWidget" src/ --include="*.ts"
```

Expected: only the two file definitions themselves appear (no external consumers).

**Step 2: Delete the files**

```bash
cd /Users/jolipton/Projects/worldmonitor
rm src/components/DownloadBanner.ts
rm src/components/CommunityWidget.ts
```

**Step 3: Type-check to confirm no breakage**

```bash
npx tsc --noEmit 2>&1
```

Expected: zero errors (the warning about `npm devdir` env config is benign and can be ignored).

**Step 4: Commit**

```bash
git add -A
git commit -m "chore: delete orphaned DownloadBanner and CommunityWidget components"
```

---

## Task 2: Remove Orphaned Analytics Functions

**Files:**
- Modify: `src/services/analytics.ts` lines 105–111

These two functions are intentional no-ops exported by the analytics module, but their callers (DownloadBanner) were removed in a prior cleanup. They should be deleted now.

**Step 1: Confirm the functions are not imported anywhere**

```bash
grep -rn "trackDownloadClicked\|trackDownloadBannerDismissed" src/ --include="*.ts"
```

Expected: only the two function definitions in `src/services/analytics.ts` appear — no import sites.

**Step 2: Open `src/services/analytics.ts` and remove lines 105–111**

The exact block to remove (verify line numbers match before deleting):

```typescript
export function trackDownloadClicked(_platform: string): void {
  // Intentionally no-op.
}

export function trackDownloadBannerDismissed(): void {
  // Intentionally no-op.
}
```

After removal, ensure there is no blank-line gap that looks wrong — the function above (`trackCriticalBannerAction`) and the function below (`trackWebcamSelected`) should have exactly one blank line between them.

**Step 3: Type-check**

```bash
npx tsc --noEmit 2>&1
```

Expected: zero errors.

**Step 4: Commit**

```bash
git add src/services/analytics.ts
git commit -m "chore: remove orphaned trackDownloadClicked and trackDownloadBannerDismissed analytics stubs"
```

---

## Task 3: Tighten CORS to HTTPS-Only for 5ls.us

**Files:**
- Modify: `api/_cors.js` line 3

The pattern `^https?://(.*\.)?5ls\.us(:\d+)?$` allows HTTP origins from `5ls.us` in all environments, including production. The local-dev HTTP case is already covered by the `localhost` and `127.0.0.1` patterns on lines 6–7.

**Step 1: Read the current pattern**

Open `api/_cors.js` and confirm line 3 reads:
```js
/^https?:\/\/(.*\.)?5ls\.us(:\d+)?$/,
```

**Step 2: Change `https?` → `https`**

Change line 3 to:
```js
/^https:\/\/(.*\.)?5ls\.us(:\d+)?$/,
```

This removes the `?` after `https`, making the `s` mandatory so only HTTPS origins are accepted.

**Step 3: Verify the allowlist still covers expected origins**

```bash
node -e "
const patterns = [
  /^https:\/\/(.*\.)?worldmonitor\.app\$/,
  /^https:\/\/(.*\.)?5ls\.us(:\d+)?\$/,
  /^https:\/\/worldmonitor-[a-z0-9-]+-elie-[a-z0-9]+\.vercel\.app\$/,
  /^https:\/\/worldmonitor-[a-z0-9-]+\.vercel\.app\$/,
  /^https?:\/\/localhost(:\d+)?\$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?\$/,
  /^https?:\/\/tauri\.localhost(:\d+)?\$/,
  /^https?:\/\/[a-z0-9-]+\.tauri\.localhost(:\d+)?\$/i,
  /^tauri:\/\/localhost\$/,
  /^asset:\/\/localhost\$/,
];
const origins = [
  'https://info.5ls.us',         // must PASS
  'http://info.5ls.us',          // must FAIL
  'https://worldmonitor.app',    // must PASS
  'http://localhost:5173',       // must PASS
  'http://127.0.0.1:4000',       // must PASS
];
origins.forEach(o => {
  const ok = patterns.some(p => p.test(o));
  console.log(ok ? 'PASS' : 'FAIL', o);
});
"
```

Expected output:
```
PASS https://info.5ls.us
FAIL http://info.5ls.us
PASS https://worldmonitor.app
PASS http://localhost:5173
PASS http://127.0.0.1:4000
```

**Step 4: Commit**

```bash
git add api/_cors.js
git commit -m "security: restrict 5ls.us CORS origins to HTTPS only"
```

---

## Task 4: Pin Node.js Version to Prevent SW Build Failure

**Files:**
- Create: `.nvmrc`
- Modify: `package.json` (add `engines` field)

`vite-plugin-pwa@1.2.0` uses `workbox-build@7.4.0` which uses `terser` internally. On Node.js v25 the process exits before terser's async renderChunk Promise resolves, causing:

```
Error: Unable to write the service worker file. 'Unexpected early exit. This happens when Promises returned by plugins cannot resolve.'
```

Vercel builds run on Node 20/22 so production is unaffected. The fix is to document and enforce the supported Node range so local developers use a compatible version.

**Step 1: Create `.nvmrc`**

Create the file `/Users/jolipton/Projects/worldmonitor/.nvmrc` with contents:
```
22
```

This tells nvm/fnm to use Node.js 22 LTS when inside the project directory.

**Step 2: Add `engines` field to `package.json`**

Find the top-level JSON object in `package.json` and add (after the `"private": true` line or similar):

```json
"engines": {
  "node": ">=18 <25"
},
```

The constraint `<25` documents the known incompatibility. This causes npm to warn (but not block) when the wrong version is used.

**Step 3: Verify by checking what a correct build looks like**

If you have nvm installed:
```bash
nvm use 22
npm run build 2>&1 | tail -20
```

Expected: Build completes without the terser/workbox early-exit error. The service worker file (`dist/sw.js`) should be present.

If nvm is not available, run:
```bash
node --version  # confirm v22.x
npm run build 2>&1 | grep -E "Error|warning|built in"
```

**Step 4: Commit**

```bash
git add .nvmrc package.json
git commit -m "chore: pin Node.js to >=18 <25 to avoid workbox terser crash on Node 25"
```

---

## Verification Checklist

After all four tasks are complete:

```bash
# 1. No TypeScript errors
npx tsc --noEmit

# 2. Dead code gone
ls src/components/DownloadBanner.ts 2>/dev/null && echo "FAIL: still exists" || echo "PASS: deleted"
ls src/components/CommunityWidget.ts 2>/dev/null && echo "FAIL: still exists" || echo "PASS: deleted"
grep -n "trackDownloadClicked\|trackDownloadBannerDismissed" src/services/analytics.ts && echo "FAIL: stubs still present" || echo "PASS: stubs removed"

# 3. CORS pattern changed
grep "5ls\.us" api/_cors.js
# Expected: /^https:\/\/(.*\.)?5ls\.us(:\d+)?$/  (no "?" after https)

# 4. Node pinned
cat .nvmrc
node -e "const p = require('./package.json'); console.log('engines:', p.engines)"
```

---

## Notes

- The 504 errors from `smartraveller.gov.au` are upstream (their server) — the code already handles them gracefully via `Promise.allSettled` in `src/services/security-advisories.ts` (lines 208–233). No code change needed.
- The wss:// → https:// fix and CSP modulepreload fix were committed in the previous session (`e971286`, `dd0dc91`) and are already deployed.
