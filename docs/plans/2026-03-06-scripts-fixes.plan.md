# Scripts Directory Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 10 high-severity, 11 medium-severity, and 6 low-severity issues found during deep code review of the 20 files in `scripts/`.

**Architecture:** Each task targets one file (or one concern) with focused fixes. Tasks are ordered by severity (critical/high first), then by blast radius. The relay (`ais-relay.cjs`) gets its own multi-issue task since it's the most important and most complex file.

**Tech Stack:** Bash, Node.js (CJS + ESM `.mjs` / `.mts`), WebSocket, Upstash Redis REST API, Supabase, ioredis

---

## Part A — Critical / High Severity

### Task 1: Fix CORS wildcard fallback and ICAO API key exposure in `ais-relay.cjs`

**Files:**
- Modify: `scripts/ais-relay.cjs:4320` (CORS fallback)
- Modify: `scripts/ais-relay.cjs:4145` (ICAO key in URL)
- Modify: `scripts/ais-relay.cjs:3979-3989` (unbounded redirect following)
- Modify: `scripts/ais-relay.cjs:29` (VITE_ env fallback)

**Step 1: Fix CORS — don't fall back to `*` when origin is unrecognized**

Line 4320 currently sets `Access-Control-Allow-Origin` to `corsOrigin || '*'`, which means any unrecognized origin (or missing origin) gets `*`. This defeats the purpose of the allowlist. Change:

```javascript
// OLD
res.setHeader('Access-Control-Allow-Origin', corsOrigin || '*');
```

to:

```javascript
if (corsOrigin) {
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
} else {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS[0]);
}
```

Note: non-browser clients (curl, server-to-server) don't send `Origin` — these are still authed via the shared secret header, so not setting `*` is safe.

**Step 2: Move ICAO API key from query string to header**

Line 4145 passes `api_key` as a query parameter, which leaks it in server access logs and potentially CDN logs:

```javascript
// OLD
const apiUrl = `https://dataservices.icao.int/api/notams-realtime-list?api_key=${ICAO_API_KEY}&format=json&locations=${encodeURIComponent(locations)}`;
```

Change to pass as header if the API supports it, or at minimum keep using query string but log a masked version. Check ICAO API docs — if header isn't supported, add a comment documenting the tradeoff.

**Step 3: Add redirect depth limit to `ytFetchDirect`**

Line 3988–3989 does recursive redirect following with no depth limit. Add a max:

```javascript
function ytFetchDirect(targetUrl, redirectCount = 0) {
  if (redirectCount > 5) return Promise.reject(new Error('Too many redirects'));
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl);
    const req = https.request({
      hostname: target.hostname,
      path: target.pathname + target.search,
      method: 'GET',
      headers: { 'User-Agent': CHROME_UA, 'Accept-Encoding': 'gzip, deflate' },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return ytFetchDirect(res.headers.location, redirectCount + 1).then(resolve, reject);
      }
      // ... rest of handler unchanged
```

**Step 4: Remove `VITE_AISSTREAM_API_KEY` fallback**

Line 29 falls back to `VITE_AISSTREAM_API_KEY`, which is a client-side env var prefix. Server-side relay code should never reference `VITE_` prefixed vars:

```javascript
// OLD
const API_KEY = process.env.AISSTREAM_API_KEY || process.env.VITE_AISSTREAM_API_KEY;
// NEW
const API_KEY = process.env.AISSTREAM_API_KEY;
```

**Step 5: Commit**

```bash
git add scripts/ais-relay.cjs
git commit -m "fix(relay): fix CORS wildcard fallback, bound YT redirects, remove VITE_ env fallback"
```

---

### Task 2: Fix `eval` injection and `env_set` sed injection in `update-relay.sh`

**Files:**
- Modify: `scripts/update-relay.sh:116-124` (env_set function)
- Modify: `scripts/update-relay.sh:394-398` (setup_pm2_startup eval)

**Step 1: Sanitize `env_set` key parameter**

Replace the `env_set` function (lines 116–124) with a version that validates the key against `^[A-Za-z_][A-Za-z0-9_]*$` and escapes sed metacharacters in the value:

```bash
env_set() {
  local key="$1" value="$2"
  if ! [[ "${key}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    die "env_set: invalid key name '${key}'"
  fi
  local escaped_value
  escaped_value="$(printf '%s' "${value}" | sed 's/[&/\|]/\\&/g')"
  if [[ -f "${ENV_FILE}" ]] && awk -F= -v k="${key}" '$1==k{found=1} END{exit !found}' "${ENV_FILE}"; then
    sed -i.bak "s|^${key}=.*|${key}=${escaped_value}|" "${ENV_FILE}" && rm -f "${ENV_FILE}.bak"
  else
    echo "${key}=${value}" >> "${ENV_FILE}"
  fi
  log ".env updated: ${key}=<set>"
}
```

**Step 2: Replace `eval` with safer command execution**

Replace line 398 `eval "${sudo_cmd}"` with `bash -c`:

```bash
    bash -c "${sudo_cmd}" || warn "pm2 startup command failed — run it manually: ${sudo_cmd}"
```

**Step 3: Verify**

Run: `bash scripts/update-relay.sh --verify-only`
Expected: Environment validation passes (or fails on missing env, which is expected locally).

**Step 4: Commit**

```bash
git add scripts/update-relay.sh
git commit -m "fix(scripts): sanitize env_set inputs and remove eval in update-relay.sh"
```

---

### Task 3: Fix dedup logic bug in `build-military-bases-final.mjs`

**Files:**
- Modify: `scripts/build-military-bases-final.mjs:406-413`

**Step 1: Fix the dead logic**

Lines 408–413 have a functional bug: `byOsmId.has('__no_id_' + Math.random())` always returns `false` (the random key can never exist in the map), and uses `__no_id_` prefix vs `__noid_` on line 411. Replace lines 406–413:

```javascript
  for (const entry of merged) {
    const oid = entry._osmId;
    if (!oid) {
      byOsmId.set('__noid_' + merged.indexOf(entry), entry);
      continue;
    }
```

**Step 2: Wrap `JSON.parse` in `loadJson` with try/catch**

```javascript
function loadJson(filepath, label) {
  if (!existsSync(filepath)) {
    console.warn(`  WARNING: ${label} not found at ${filepath} — skipping`);
    return null;
  }
  const raw = readFileSync(filepath, 'utf-8');
  try {
    const data = JSON.parse(raw);
    console.log(`  Loaded ${label}: ${Array.isArray(data) ? data.length : 'N/A'} entries`);
    return data;
  } catch (err) {
    console.error(`  ERROR: Failed to parse ${label}: ${err.message}`);
    return null;
  }
}
```

**Step 3: Add `.catch()` to `main()`**

Replace `main();` (line 586) with:

```javascript
main().catch(err => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});
```

**Step 4: Commit**

```bash
git add scripts/build-military-bases-final.mjs
git commit -m "fix(scripts): fix dedup logic bug and add error handling in build-military-bases-final"
```

---

### Task 4: Remove hardcoded developer path in `seed-iran-events.mjs`

**Files:**
- Modify: `scripts/seed-iran-events.mjs:111`

**Step 1: Remove the hardcoded path**

Line 111 has a hardcoded developer home directory:

```javascript
// OLD — line 111
envPath = join('/Users/eliehabib/Documents/GitHub/worldmonitor', '.env.local');
```

Remove this entire fallback. The script should only check `.env.local` and `.env` relative to the project root:

```javascript
function loadEnvFile() {
  const envPath = ['.env.local', '.env']
    .map(f => join(__dirname, '..', f))
    .find(p => existsSync(p));
  if (!envPath) return;
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}
```

**Step 2: Wrap `JSON.parse(readFileSync(...))` with try/catch**

Line 153 `const raw = JSON.parse(readFileSync(dataPath, 'utf8'));` can throw. Wrap it:

```javascript
  let raw;
  try {
    raw = JSON.parse(readFileSync(dataPath, 'utf8'));
  } catch (err) {
    console.error(`Failed to parse ${dataPath}: ${err.message}`);
    process.exit(1);
  }
```

**Step 3: Commit**

```bash
git add scripts/seed-iran-events.mjs
git commit -m "fix(scripts): remove hardcoded developer path and add JSON parse safety in seed-iran-events"
```

---

### Task 5: Validate `--output` path and add fetch timeout in `fetch-gpsjam.mjs`

**Files:**
- Modify: `scripts/fetch-gpsjam.mjs` (after line 36, lines 41–49)

**Step 1: Add path validation for `--output`**

After `const outputPath = getArg('output', null);` (line 36), add:

```javascript
if (outputPath) {
  const resolved = path.resolve(outputPath);
  const projectRoot = path.resolve(__dirname, '..');
  if (!resolved.startsWith(projectRoot + path.sep) && resolved !== projectRoot) {
    console.error(`[gpsjam] --output path must be under project root. Got: ${resolved}`);
    process.exit(1);
  }
}
```

**Step 2: Add fetch timeout to `fetchText`**

Add `signal: AbortSignal.timeout(30_000)` to the fetch call at line 42.

**Step 3: Commit**

```bash
git add scripts/fetch-gpsjam.mjs
git commit -m "fix(scripts): add output path validation and fetch timeout in fetch-gpsjam"
```

---

### Task 6: Harden SQL escaping in `generate-seed-sql.mts`

**Files:**
- Modify: `scripts/generate-seed-sql.mts:71`

**Step 1: Extend `esc()` to handle control characters**

```typescript
// OLD
const esc = (s: string) => s.replace(/'/g, "''");
// NEW
const esc = (s: string) =>
  s.replace(/'/g, "''").replace(/[\x00-\x1f\x7f]/g, '');
```

**Step 2: Commit**

```bash
git add scripts/generate-seed-sql.mts
git commit -m "fix(scripts): harden SQL escaping to strip control characters"
```

---

### Task 7: Fix env validation ordering in `seed-news-sources.mts`

**Files:**
- Modify: `scripts/seed-news-sources.mts:7-17`

**Step 1: Move validation before usage, remove non-null assertions**

```typescript
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});
```

**Step 2: Commit**

```bash
git add scripts/seed-news-sources.mts
git commit -m "fix(scripts): validate env vars before use in seed-news-sources"
```

---

## Part B — Medium Severity

### Task 8: Harden systemd service file

**Files:**
- Modify: `scripts/worldmonitor-relay.service`

**Step 1: Add `User=` and absolute `ExecStart` path**

```ini
[Service]
Type=simple
User=worldmonitor
WorkingDirectory=/opt/worldmonitor
ExecStart=/usr/bin/node /opt/worldmonitor/scripts/ais-relay.cjs
Restart=always
RestartSec=10
EnvironmentFile=/opt/worldmonitor/.env
```

**Step 2: Commit**

```bash
git add scripts/worldmonitor-relay.service
git commit -m "fix(scripts): add User directive and absolute ExecStart in systemd service"
```

---

### Task 9: Fix `fix-generated-ts.sh` path handling

**Files:**
- Modify: `scripts/fix-generated-ts.sh`

**Step 1: Add project root resolution and missing dir guard**

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
GENERATED_DIR="${ROOT_DIR}/src/generated"
DIRECTIVE="// @ts-nocheck"

if [[ ! -d "${GENERATED_DIR}" ]]; then
  exit 0
fi

find "${GENERATED_DIR}" -name '*.ts' -type f | while IFS= read -r f; do
  first_line=$(head -1 "$f")
  if [[ "$first_line" != "$DIRECTIVE" ]]; then
    tmp=$(mktemp)
    { echo "$DIRECTIVE"; cat "$f"; } > "$tmp" && mv "$tmp" "$f"
  fi
done
```

**Step 2: Commit**

```bash
git add scripts/fix-generated-ts.sh
git commit -m "fix(scripts): use absolute paths and handle missing dir in fix-generated-ts.sh"
```

---

### Task 10: Add fetch timeout and `.catch()` in `fetch-pizzint-bases.mjs`

**Files:**
- Modify: `scripts/fetch-pizzint-bases.mjs:113` (add timeout)
- Modify: `scripts/fetch-pizzint-bases.mjs:268` (add .catch)

**Step 1: Add `signal: AbortSignal.timeout(35_000)` to the fetch in `fetchPage`**

**Step 2: Replace `main();` with `main().catch(err => { console.error('FATAL:', err.message || err); process.exit(1); });`**

**Step 3: Commit**

```bash
git add scripts/fetch-pizzint-bases.mjs
git commit -m "fix(scripts): add fetch timeout and top-level error handler in fetch-pizzint-bases"
```

---

### Task 11: Add fetch timeout in `fetch-mirta-bases.mjs`

**Files:**
- Modify: `scripts/fetch-mirta-bases.mjs:103`

**Step 1: Add `signal: AbortSignal.timeout(60_000)` to the fetch in `fetchAllFeatures`**

Line 103 `const resp = await fetch(url);` has no timeout:

```javascript
const resp = await fetch(url, { signal: AbortSignal.timeout(60_000) });
```

**Step 2: Commit**

```bash
git add scripts/fetch-mirta-bases.mjs
git commit -m "fix(scripts): add fetch timeout in fetch-mirta-bases"
```

---

### Task 12: Add fetch timeout in `fetch-osm-bases.mjs`

**Files:**
- Modify: `scripts/fetch-osm-bases.mjs:36-44`

Already has a manual `AbortController` + `setTimeout` pattern. But the `clearTimeout` in the catch path is correct. The 5-minute timeout is appropriate for Overpass API. No change needed — mark as reviewed/OK.

---

### Task 13: Add pipeline result safety checks in `seed-military-bases.mjs`

**Files:**
- Modify: `scripts/seed-military-bases.mjs:157-174`

**Step 1: Add `Number()` coercion and error checking to validate function**

After the pipeline request (lines 157–163), add:

```javascript
  if (zcardResult.error) throw new Error(`ZCARD failed: ${zcardResult.error}`);
  if (hlenResult.error) throw new Error(`HLEN failed: ${hlenResult.error}`);

  const geoCount = Number(zcardResult.result);
  const metaCount = Number(hlenResult.result);

  if (!Number.isFinite(geoCount) || !Number.isFinite(metaCount)) {
    throw new Error(`Invalid counts — GEO: ${zcardResult.result}, META: ${hlenResult.result}`);
  }
```

**Step 2: Commit**

```bash
git add scripts/seed-military-bases.mjs
git commit -m "fix(scripts): add pipeline result validation in seed-military-bases"
```

---

### Task 14: Add `generate-oref-locations.mjs` fetch timeout

**Files:**
- Modify: `scripts/generate-oref-locations.mjs:22`

**Step 1: Add timeout**

```javascript
const res = await fetch(CITIES_URL, { signal: AbortSignal.timeout(15_000) });
```

**Step 2: Commit**

```bash
git add scripts/generate-oref-locations.mjs
git commit -m "fix(scripts): add fetch timeout in generate-oref-locations"
```

---

## Part C — Low Severity

### Task 15: Add error context to swallowed catch in `seed-ucdp-events.mjs`

**Files:**
- Modify: `scripts/seed-ucdp-events.mjs:128` (log before returning FAILED)
- Modify: `scripts/seed-ucdp-events.mjs:220-225` (wrap JSON.parse in try/catch)

**Step 1: Replace `.catch(() => FAILED)` with `.catch(err => { console.warn(...); return FAILED; })`**

**Step 2: Wrap `JSON.parse(getData.result)` (line 222) in try/catch**

**Step 3: Commit**

```bash
git add scripts/seed-ucdp-events.mjs
git commit -m "fix(scripts): add error logging for failed pages and safe JSON parse in seed-ucdp-events"
```

---

### Task 16: Add `readFileSync` error handling in `validate-rss-feeds.mjs`

**Files:**
- Modify: `scripts/validate-rss-feeds.mjs:17`

**Step 1: Wrap in try/catch**

```javascript
function extractFeeds() {
  let src;
  try {
    src = readFileSync(FEEDS_PATH, 'utf8');
  } catch (err) {
    console.error(`Failed to read feeds file at ${FEEDS_PATH}: ${err.message}`);
    process.exit(1);
  }
```

**Step 2: Commit**

```bash
git add scripts/validate-rss-feeds.mjs
git commit -m "fix(scripts): add file read error handling in validate-rss-feeds"
```

---

### Task 17: Harden `seed-iran-events.mjs` JSON.parse verification

Already addressed in Task 4 — this task is covered.

---

## Issue Summary

| # | File | Severity | Issue |
|---|------|----------|-------|
| 1 | `ais-relay.cjs` | **Critical** | CORS falls back to `*` when origin unrecognized |
| 1 | `ais-relay.cjs` | **High** | ICAO API key exposed in URL query string |
| 1 | `ais-relay.cjs` | **High** | `ytFetchDirect` has unbounded recursive redirect following |
| 1 | `ais-relay.cjs` | **High** | Server-side code references `VITE_` prefixed env var |
| 2 | `update-relay.sh` | **High** | `eval` injection + `env_set` sed metachar injection |
| 3 | `build-military-bases-final.mjs` | **High** | Dead dedup logic (`Math.random()` always false, prefix typo) |
| 4 | `seed-iran-events.mjs` | **High** | Hardcoded developer path `/Users/eliehabib/...` |
| 5 | `fetch-gpsjam.mjs` | **High** | `--output` path traversal + missing fetch timeout |
| 6 | `generate-seed-sql.mts` | **High** | SQL `esc()` missing control char handling |
| 7 | `seed-news-sources.mts` | **High** | Non-null assertion before validation |
| 8 | `worldmonitor-relay.service` | **Medium** | No `User=`, relative `ExecStart` |
| 9 | `fix-generated-ts.sh` | **Medium** | Relative paths, missing dir guard |
| 10 | `fetch-pizzint-bases.mjs` | **Medium** | No fetch timeout, no `.catch()` on main |
| 11 | `fetch-mirta-bases.mjs` | **Medium** | No fetch timeout |
| 13 | `seed-military-bases.mjs` | **Medium** | Pipeline result type safety |
| 14 | `generate-oref-locations.mjs` | **Medium** | No fetch timeout |
| 15 | `seed-ucdp-events.mjs` | **Low** | Swallowed errors, unsafe `JSON.parse` |
| 16 | `validate-rss-feeds.mjs` | **Low** | No `readFileSync` error handling |

## Files Reviewed & No Significant Issues

| File | Notes |
|------|-------|
| `ais-relay-rss.test.cjs` | Test file — well-structured |
| `fetch-osm-bases.mjs` | Has timeout, error handling, `.catch()` — OK |
| `sync-desktop-version.mjs` | Clean, has `.catch()` — OK |
| `download-node.sh` | Uses `set -euo pipefail`, SHA256 verification — OK |
| `desktop-package.mjs` | Uses `spawnSync` (no shell injection), validates args — OK |
| `build-sidecar-sebuf.mjs` | Has try/catch, uses esbuild safely — OK |

## Cross-Cutting Concern: Duplicated `loadEnvFile()`

The following scripts all contain nearly identical `loadEnvFile()` implementations:
- `seed-ucdp-events.mjs`
- `seed-military-bases.mjs`
- `seed-iran-events.mjs`
- `fetch-gpsjam.mjs`
- `fetch-pizzint-bases.mjs`

**Recommendation (deferred):** Extract to a shared `scripts/lib/env.mjs` module. Not included in this plan to keep blast radius small, but should be a follow-up refactor.
