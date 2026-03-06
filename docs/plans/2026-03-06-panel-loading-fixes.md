# Panel Loading Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 10 panels that are not loading data. All data must come from the relay server (`scripts/ais-relay.cjs`) — no Vercel API routes are used for data anymore.

**Architecture:** All panels receive data via the relay WebSocket push (`broadcastToChannel`) or relay HTTP endpoints (`/panel/:channel`). The relay fetches from external APIs directly, caches in Redis, and broadcasts. The frontend services use the generated gRPC clients which currently call Vercel `/api/...` routes — these need to either (A) be pointed at the relay's existing HTTP proxy endpoints, or (B) receive data purely via WS push using `apply*` methods in `data-loader.ts`.

**Current state of each failing panel:**

| Panel | WS Channel | Relay Status | Root Cause |
|---|---|---|---|
| Live Intelligence | `intelligence` | `warmIntelligenceAndBroadcast` → 401 from Vercel (LLM route) | `RELAY_SHARED_SECRET` ≠ Vercel's expected key |
| Economic Indicators | `fred` + `oil` + `bis` | Relay broadcasts these ✓ but `isFeatureAvailable('economicFred')` gates them | Feature flags not hydrated from relay |
| Security Advisories | *(none)* | Relay has `/rss` proxy endpoint — frontend still calls `/api/rss-proxy` (Vercel) | Need relay channel or frontend to use relay `/rss` proxy |
| Population Exposure | *(computed)* | Derived from conflict events — depends on ACLED being available | ACLED token missing |
| Climate Anomalies | *(none)* | Relay has no climate channel — client calls `/api/climate/v1/...` (Vercel) | Need relay to fetch NOAA/climate data and broadcast |
| Armed Conflicts | *(none)* | Relay has ACLED + UCDP fetchers internally (serving HTTP) but no WS broadcast | Need to add `conflict` WS channel or have client use relay HTTP |
| UHRC (UCDP Events) | *(none)* | Relay has `ucdpFetchAllEvents` and `/ucdp-events` HTTP proxy endpoint | Frontend calls `/api/conflict/v1/list-ucdp-events` (Vercel), not relay |
| Israel Sirens | `oref` | Relay broadcasts `oref` channel ✓ but `OREF_PROXY_AUTH` missing | `OREF_PROXY_AUTH` not set — `configured: false` broadcast |
| Trade Policy | `trade` | Relay broadcasts `trade` channel via WTO API but WTO times out | WTO timeout too short + missing `WTO_API_KEY` |
| Fires (Satellite) | `natural` | Relay has `fetchNatural` → disabled because `NASA_FIRMS_API_KEY` missing | `NASA_FIRMS_API_KEY` not set on server |

**Tech Stack:** Node.js CommonJS (`scripts/ais-relay.cjs`), TypeScript frontend, Redis, NOAA API, ACLED API, UCDP API, WTO API, NASA FIRMS API

---

## Task 1: Fix Live Intelligence (401 on warm)

**Goal:** `warmIntelligenceAndBroadcast` POSTs to Vercel `/api/intelligence/v1/get-global-intel-digest` and gets 401. Fix the auth.

**Files:**
- `scripts/ais-relay.cjs` — lines ~400-445 (`warmIntelligenceAndBroadcast`)

**Step 1: Read current auth header being sent**

```bash
grep -n 'warmIntelligenceAndBroadcast\|RELAY_SHARED_SECRET\|RELAY_WARMER_API_KEY\|Authorization.*warm\|intelligence.*Bearer' scripts/ais-relay.cjs | head -20
```

**Step 2: Find what the relay sends**

The function likely sends:
```javascript
Authorization: `Bearer ${RELAY_SHARED_SECRET}`
```
or:
```javascript
'x-relay-key': RELAY_SHARED_SECRET
```

**Step 3: Confirm what value is set on the server**

On the server: `grep -E 'RELAY_SHARED_SECRET|RELAY_WARMER_API_KEY' /opt/worldmonitor/.env`

**Step 4: Align the values**

The Vercel intelligence route validates against a key set in its own env vars. The relay must send the same value. Options:

- **Option A**: Set `RELAY_SHARED_SECRET` on Vercel = same value as on the relay server
- **Option B**: The relay still has `RELAY_WARMER_API_KEY` — check:
  ```bash
  grep RELAY_WARMER_API_KEY scripts/ais-relay.cjs | head -5
  ```
  If it does, set that in Vercel env = same value as relay's `RELAY_SHARED_SECRET`

**Step 5: No code change needed** — this is a server/Vercel env var alignment. Document the finding as a comment in `scripts/update-relay.sh`:

```bash
# RELAY_SHARED_SECRET must match RELAY_WARMER_API_KEY set in Vercel env vars
# for the intelligence warm-and-broadcast to work.
```

**Step 6: Commit**
```bash
git add scripts/update-relay.sh
git commit -m "docs: note RELAY_SHARED_SECRET must match Vercel RELAY_WARMER_API_KEY"
```

---

## Task 2: Fix Feature Flag Hydration (Economic Indicators, Trade Policy gating)

**Goal:** `isFeatureAvailable('economicFred')` and `isFeatureAvailable('wtoTrade')` return false because the relay-delivered `config:feature-flags` channel data is not applied to `runtimeConfig.featureToggles`.

**Files:**
- `src/services/feature-flag-client.ts`
- `src/services/runtime-config.ts`
- `src/App.ts` — look for `loadFeatureFlags` call

**Step 1: Trace the flag flow**

```bash
grep -n 'loadFeatureFlags\|setFeatureToggle\|featureToggles\|applyFlags' src/App.ts | head -20
grep -n 'applyRemote\|economicFred\|wtoTrade' src/services/runtime-config.ts | head -20
```

**Step 2: Understand the gap**

`feature-flag-client.ts` loads flags into `_flags` module variable and exposes `isFeatureEnabled(key)` (lowercase key like `'ml.semanticClustering'`).

`runtime-config.ts` has its own `runtimeConfig.featureToggles` with keys like `'economicFred'`, `'wtoTrade'`. These are completely separate systems.

The relay sends Supabase-stored feature flags via `config:feature-flags` → `featureFlags` hydration key. Check what keys those flags actually use:

```bash
redis-cli GET relay:config:feature-flags 2>/dev/null || echo "check on server"
```

On server: `redis-cli GET relay:config:feature-flags | python3 -m json.tool`

**Step 3: Check if Supabase has the right runtime feature rows**

In Supabase SQL editor:
```sql
SELECT key, value FROM feature_flags WHERE key IN (
  'economicFred', 'wtoTrade', 'nasaFirms', 'acledConflicts', 'ucdpConflicts'
);
```

If missing, insert:
```sql
INSERT INTO feature_flags (key, value) VALUES
  ('economicFred', 'true'),
  ('wtoTrade', 'true'),
  ('nasaFirms', 'true'),
  ('acledConflicts', 'true'),
  ('ucdpConflicts', 'true')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
```

**Step 4: Wire relay feature flags into runtime-config toggles**

In `src/App.ts`, find where `loadFeatureFlags()` is called. After it, add code to sync keys that match `RuntimeFeatureId` into `runtimeConfig`:

```bash
grep -n 'loadFeatureFlags\|loadNewsSources\|fetchBootstrap\|init.*sequence' src/App.ts | head -20
```

In `src/App.ts`, after `await loadFeatureFlags()`:

```typescript
// Sync relay-delivered feature toggles into runtime-config
import { setFeatureToggle, type RuntimeFeatureId, RUNTIME_FEATURES } from '@/services/runtime-config';
import { areFlagsLoaded } from '@/services/feature-flag-client';
// The relay stores toggle flags using the RuntimeFeatureId keys directly.
// Sync any that exist to runtimeConfig so isFeatureAvailable() returns the right value.
if (areFlagsLoaded()) {
  const featureIds = RUNTIME_FEATURES.map(f => f.id);
  for (const id of featureIds) {
    const val = isFeatureEnabled(id);  // from feature-flag-client
    if (val !== undefined) setFeatureToggle(id as RuntimeFeatureId, val);
  }
}
```

Note: `isFeatureEnabled` in `feature-flag-client.ts` returns `boolean` not `boolean | undefined` — check exact API before writing code. May need to check `areFlagsLoaded() && _flags?.[id] !== undefined`.

**Step 5: Write a test**

```bash
# In tests/feature-flags.test.mjs or similar test file
# Verify that after loadFeatureFlags() with a mock payload containing 'economicFred: true',
# isFeatureAvailable('economicFred') returns true
```

**Step 6: Commit**
```bash
git add src/App.ts
git commit -m "fix: sync relay feature flags into runtime-config toggles on startup"
```

---

## Task 3: Fix Security Advisories (RSS proxy via relay)

**Goal:** `fetchSecurityAdvisories` calls `/api/rss-proxy` (Vercel). Relay already has an `/rss` proxy endpoint. Point the frontend at the relay's RSS proxy instead.

**Files:**
- `src/services/security-advisories.ts` — `advisoryFeedUrl()` function (line 7-10)
- `src/services/relay-http.ts` — has `RELAY_HTTP_BASE`

**Step 1: Verify relay's RSS proxy works**

```bash
grep -n "pathname.*rss\|'/rss'\|\"/rss\"" scripts/ais-relay.cjs | head -10
```

The relay serves RSS at `/rss?url=<encoded>` — check the exact endpoint format:
```bash
grep -n -A5 "pathname.*startsWith.*rss\|rss.*proxy" scripts/ais-relay.cjs | head -30
```

**Step 2: Update `advisoryFeedUrl` to use relay**

```typescript
// src/services/security-advisories.ts
import { RELAY_HTTP_BASE, getRelayFetchHeaders } from '@/services/relay-http';

function advisoryFeedUrl(feedUrl: string): string {
  if (isDesktopRuntime()) return proxyUrl(feedUrl);
  return `${RELAY_HTTP_BASE}/rss?url=${encodeURIComponent(feedUrl)}`;
}
```

Also update the `fetch` call in `fetchSecurityAdvisories` to include `getRelayFetchHeaders()`:

```typescript
const response = await fetch(advisoryFeedUrl(feed.url), {
  headers: { 
    Accept: 'application/rss+xml, application/xml, text/xml, */*',
    ...getRelayFetchHeaders(),
  },
  ...(signal ? { signal } : {}),
});
```

**Step 3: Verify relay RSS endpoint auth**

The relay's `/rss` endpoint is behind `isAuthorizedRequest` (same as bootstrap). Since we fixed `isAuthorizedRequest` to also accept `RELAY_WS_TOKEN`, and `getRelayFetchHeaders()` sends that token, this should work.

**Step 4: Commit**
```bash
git add src/services/security-advisories.ts
git commit -m "fix: route security advisories RSS proxy through relay instead of Vercel"
```

---

## Task 4: Fix Armed Conflicts + UHRC/UCDP (add relay WS channels)

**Goal:** The relay already fetches ACLED data internally (for `strategic-risk`) and has full UCDP fetching logic (`ucdpFetchAllEvents`). Add `conflict` and `ucdp-events` as proper broadcast channels.

**Files:**
- `scripts/ais-relay.cjs` — add fetchers and crons for new channels
- `src/app/data-loader.ts` — add `applyConflictEvents` and `applyUcdpEvents` handlers
- `src/App.ts` — add `subscribeRelayPush` calls

**Step 1: Understand existing ACLED fetcher in relay**

```bash
grep -n 'fetchStrategicRisk\|fetchAcled\|acleddata\|ACLED_ACCESS_TOKEN' scripts/ais-relay.cjs | head -20
```

`fetchStrategicRisk` uses ACLED data to compute scores. We need a separate fetcher that returns raw conflict events for the map/panel.

**Step 2: Add `fetchAcledEvents` function to relay**

In `scripts/ais-relay.cjs`, after the existing `fetchStrategicRisk` function, add:

```javascript
async function fetchAcledEvents() {
  const token = process.env.ACLED_ACCESS_TOKEN;
  if (!token) { console.warn('[relay] ACLED_ACCESS_TOKEN not set — conflict channel disabled'); return null; }
  const email = process.env.ACLED_EMAIL || '';
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const params = new URLSearchParams({
    key: token, email, event_date: thirtyDaysAgo, event_date_where: 'BETWEEN',
    event_date_end: new Date().toISOString().slice(0, 10),
    fields: 'event_id_cnty,event_date,event_type,sub_event_type,country,region,location,latitude,longitude,fatalities,actor1,actor2,source',
    limit: '500', page: '1',
  });
  const resp = await fetch(`https://acleddata.com/api/acled/read?${params}`, {
    headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) throw new Error(`ACLED HTTP ${resp.status}`);
  const json = await resp.json();
  return { events: json.data ?? [], count: json.count ?? 0 };
}
```

**Step 3: Add `conflict` and `ucdp-events` cron entries**

Find where the existing crons are (e.g., near line 6280+) and add:

```javascript
// Every 15 min — conflict events (ACLED)
cron.schedule('*/15 * * * *', async () => {
  try { await directFetchAndBroadcast('conflict', 'relay:conflict:v1', 900, fetchAcledEvents); }
  catch (err) { console.error('[relay] conflict cron error:', err?.message ?? err); }
});

// Every 30 min — UCDP events (re-use existing ucdpFetchAllEvents)
cron.schedule('*/30 * * * *', async () => {
  try { await directFetchAndBroadcast('ucdp-events', UCDP_REDIS_KEY, 1800, () => ucdpFetchAllEvents().then(d => d || null)); }
  catch (err) { console.error('[relay] ucdp-events cron error:', err?.message ?? err); }
});
```

**Step 4: Add to `PHASE4_CHANNEL_KEYS` for bootstrap**

```javascript
'conflict': 'relay:conflict:v1',
'ucdp-events': 'conflict:ucdp-events:v1',
```

Also add to `BROADCAST_CHANNELS` array.

**Step 5: Add `applyConflictEvents` and `applyUcdpEvents` in `data-loader.ts`**

```bash
grep -n 'applyIranEvents\|renderConflict\|setConflictData' src/app/data-loader.ts | head -20
```

Look at how conflict data is currently used in `fetchConflictEvents` and create an equivalent `applyConflictEvents(payload)` method that drives the same rendering path.

**Step 6: Wire subscriptions in `App.ts`**

```typescript
subscribeRelayPush('conflict',    (p) => { void dl.applyConflictEvents(p); });
subscribeRelayPush('ucdp-events', (p) => { void dl.applyUcdpEvents(p); });
```

**Step 7: Commit**
```bash
git add scripts/ais-relay.cjs src/app/data-loader.ts src/App.ts
git commit -m "feat: add conflict and ucdp-events relay channels to replace Vercel routes"
```

---

## Task 5: Fix Climate Anomalies (add relay channel)

**Goal:** The relay has no climate data source. Add `climate` channel using NOAA/NCEI or ERA5 data, or use the relay's `/rss` proxy to aggregate climate RSS feeds.

**Files:**
- `scripts/ais-relay.cjs` — add `fetchClimate` function and cron
- `src/services/climate/index.ts` — check `getHydratedData('climateAnomalies')` path
- `src/App.ts` — add `subscribeRelayPush('climate', ...)`
- `src/app/data-loader.ts` — verify `applyClimate` method exists or add it

**Step 1: Check if `applyClimate` exists in data-loader**

```bash
grep -n 'applyClimate\|applyClimateAnomalies\|climate.*apply' src/app/data-loader.ts | head -10
```

**Step 2: Check what hydration key climate expects**

In `src/services/climate/index.ts` line 37:
```typescript
const hydrated = getHydratedData('climateAnomalies') as ListClimateAnomaliesResponse | undefined;
```

So the relay must broadcast data that, when stored under key `climateAnomalies`, matches `ListClimateAnomaliesResponse = { anomalies: ClimateAnomaly[] }`.

**Step 3: Add NOAA NCEI climate fetcher to relay**

NOAA Climate Data Online is free and doesn't require a key for public data. Use NOAA's temperature anomaly data:

```javascript
async function fetchClimateAnomalies() {
  // NOAA Global Surface Temperature Anomaly (monthly)
  const resp = await fetch('https://www.ncei.noaa.gov/access/monitoring/climate-at-a-glance/global/time-series/globe/land_ocean/ann/1/2000-2025.json', {
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`NOAA HTTP ${resp.status}`);
  const json = await resp.json();
  // Transform NOAA format into { anomalies: ClimateAnomaly[] } shape
  // NOAA returns { data: { 'YYYYMM': value } }
  const anomalies = [];
  for (const [period, rawValue] of Object.entries(json.data ?? {})) {
    const value = parseFloat(rawValue);
    if (isNaN(value) || period.length < 6) continue;
    const severity = Math.abs(value) > 1.0 ? 'ANOMALY_SEVERITY_EXTREME' : Math.abs(value) > 0.5 ? 'ANOMALY_SEVERITY_MODERATE' : 'ANOMALY_SEVERITY_UNSPECIFIED';
    if (severity === 'ANOMALY_SEVERITY_UNSPECIFIED') continue;
    anomalies.push({
      zone: 'Global', location: { latitude: 0, longitude: 0 },
      tempDelta: value, precipDelta: 0, severity, type: value > 0 ? 'ANOMALY_TYPE_WARM' : 'ANOMALY_TYPE_COLD', period,
    });
  }
  return { anomalies };
}
```

Note: This is a simplified starting point. The proto shape (`ClimateAnomaly` with `zone`, `location.latitude/longitude`, `tempDelta`, `precipDelta`, `severity`, `type`, `period`) must be matched.

**Step 4: Add cron**

```javascript
// Every 6 hours — climate anomalies (NOAA)
cron.schedule('0 */6 * * *', async () => {
  try { await directFetchAndBroadcast('climate', 'relay:climate:v1', 21600, fetchClimateAnomalies); }
  catch (err) { console.error('[relay] climate cron error:', err?.message ?? err); }
});
```

**Step 5: Add to PHASE4_CHANNEL_KEYS**

```javascript
climate: 'relay:climate:v1',
```

Add `climateAnomalies` to `CHANNEL_TO_HYDRATION_KEY`:
```javascript
climate: 'climateAnomalies',
```

**Step 6: Wire subscription in App.ts**

```bash
grep -n 'subscribeRelayPush.*climate\|applyClimate' src/App.ts
```

If missing, add in `App.ts`:
```typescript
subscribeRelayPush('climate', (p) => { void dl.applyClimate(p); });
```

And in `data-loader.ts`, add `applyClimate`:
```typescript
applyClimate(payload: unknown): void {
  if (!payload || typeof payload !== 'object') return;
  const resp = payload as ListClimateAnomaliesResponse;
  if (!Array.isArray(resp.anomalies)) return;
  const anomalies = resp.anomalies.map(toDisplayAnomaly).filter(a => a.severity !== 'normal');
  (this.ctx.panels['climate'] as ClimateAnomalyPanel)?.setAnomalies(anomalies);
  if (this.ctx.mapLayers.climate) this.ctx.map?.setClimateAnomalies(anomalies);
}
```

**Step 7: Commit**
```bash
git add scripts/ais-relay.cjs src/App.ts src/app/data-loader.ts
git commit -m "feat: add climate anomalies relay channel via NOAA data"
```

---

## Task 6: Fix Population Exposure (depends on Task 4 conflict data)

**Goal:** Population exposure is computed from conflict + UCDP events in `data-loader.ts`. Once Task 4 lands (conflict channel), this should work automatically. Verify the computation path.

**Files:**
- `src/app/data-loader.ts` — lines ~1147-1161 (exposure computation)

**Step 1: Read the exposure logic**

```bash
sed -n '1140,1165p' src/app/data-loader.ts
```

**Step 2: Confirm it uses `this.ctx.intelligenceCache.protests` and `ucdpEvts`**

If the `applyConflictEvents` method from Task 4 correctly populates `this.ctx.intelligenceCache.protests` (or equivalent field), then exposure will be computed on the next exposure refresh cycle.

**Step 3: Trigger exposure refresh after conflict data arrives**

In `applyConflictEvents`, after updating the cache, call the exposure refresh if needed:
```typescript
// After updating conflict cache, trigger exposure computation
void this.refreshPopulationExposure?.();
```

Check if `refreshPopulationExposure` exists or if exposure is computed in a periodic loop.

**Step 4: No separate commit needed** — this is validated as part of Task 4 verification.

---

## Task 7: Fix Israel Sirens (OREF — env var only)

**Goal:** `OREF_PROXY_AUTH` must be set on the server for OREF polling to work. This is a server configuration task, not a code change.

**Files:**
- `scripts/update-relay.sh` — add informative warning

**Step 1: Add env check to update-relay.sh**

In `scripts/update-relay.sh`, in the channel status section, add:

```bash
if [[ -z "${OREF_PROXY_AUTH:-}" ]]; then
  warn "OREF_PROXY_AUTH not set — Israel Sirens panel will show no live data"
  warn "  Requires Israeli residential proxy in format: user:pass@host:port"
fi
```

**Step 2: Commit**
```bash
git add scripts/update-relay.sh
git commit -m "docs: add OREF_PROXY_AUTH warning to deployment script"
```

---

## Task 8: Fix Trade Policy (WTO timeout)

**Goal:** WTO API calls time out. Increase timeout and add retry.

**Files:**
- `scripts/ais-relay.cjs` — `wtoFetch` function (~line 4170)

**Step 1: Find current timeout**

```bash
grep -n -A10 'async function wtoFetch' scripts/ais-relay.cjs | head -20
```

**Step 2: Increase to 30 seconds**

Find the `AbortSignal.timeout(...)` call in `wtoFetch` and increase from 10s to 30s:

```javascript
signal: AbortSignal.timeout(30_000),
```

**Step 3: Check if WTO_API_KEY is being used correctly**

```bash
grep -n 'WTO_API_KEY\|Ocp-Apim\|wto.*key\|apikey.*wto' scripts/ais-relay.cjs | head -10
```

**Step 4: Add WTO_API_KEY notice to update-relay.sh**

```bash
if [[ -z "${WTO_API_KEY:-}" ]]; then
  warn "WTO_API_KEY not set — Trade Policy panel will use anonymous WTO API (lower rate limits)"
fi
```

**Step 5: Commit**
```bash
git add scripts/ais-relay.cjs scripts/update-relay.sh
git commit -m "fix: increase WTO API timeout to 30s and add deployment notice"
```

---

## Task 9: Fix Fires / NASA FIRMS (env var + relay notice)

**Goal:** `NASA_FIRMS_API_KEY` must be set for the `natural` channel. Add deployment notice. If key unavailable, ensure panel shows graceful state not spinner.

**Files:**
- `scripts/update-relay.sh`
- `src/app/data-loader.ts` — verify fires panel shows "data unavailable" when channel has no data

**Step 1: Add notice to update-relay.sh**

```bash
if [[ -z "${NASA_FIRMS_API_KEY:-}" ]]; then
  warn "NASA_FIRMS_API_KEY not set — Satellite Fires panel disabled"
  warn "  Get free key at: https://firms.modaps.eosdis.nasa.gov/api/data_availability/"
fi
```

**Step 2: Check fires panel empty state**

```bash
grep -n 'satellite-fires\|SatelliteFiresPanel\|setLoading\|setError' src/app/data-loader.ts | head -15
```

Ensure when `natural` channel returns null/empty, the panel renders an "unavailable" state not an infinite spinner.

**Step 3: Commit**
```bash
git add scripts/update-relay.sh
git commit -m "docs: add NASA_FIRMS_API_KEY notice to deployment script"
```

---

## Task 10: Add channel status summary to update-relay.sh

**Goal:** Single function that prints which channels are enabled/disabled based on env var presence, so operators know what to expect after deploy.

**Files:**
- `scripts/update-relay.sh`

**Step 1: Add `print_channel_summary` function**

At end of the env validation block, before `configure_redis`, add:

```bash
print_channel_summary() {
  echo ""
  echo "=== Channel Enable Status ==="
  _chk() {
    local name="$1" key="$2"
    if [[ -n "${!key:-}" ]]; then
      echo "  [ON]  $name"
    else
      echo "  [OFF] $name (set $key to enable)"
    fi
  }
  _chk "Satellite Fires"     NASA_FIRMS_API_KEY
  _chk "Armed Conflicts"     ACLED_ACCESS_TOKEN
  _chk "Economic FRED"       FRED_API_KEY
  _chk "Energy EIA"          EIA_API_KEY
  _chk "Israel Sirens (OREF)" OREF_PROXY_AUTH
  _chk "Trade Policy (WTO)"  WTO_API_KEY
  _chk "Aviation Stack"      AVIATIONSTACK_API_KEY
  _chk "Finnhub Markets"     FINNHUB_API_KEY
  _chk "Strategic Risk"      ACLED_ACCESS_TOKEN
  echo "============================="
  echo ""
}
print_channel_summary
```

**Step 2: Commit**
```bash
git add scripts/update-relay.sh
git commit -m "feat: add channel enable/disable summary to update-relay.sh"
```

---

## Task 11: Verify & Integration Check

**Goal:** After all code changes are deployed, confirm each panel loads.

**Step 1: Build check**
```bash
npx tsc --noEmit && npm run build
```
Expected: No TypeScript errors, build succeeds.

**Step 2: Deploy relay**
```bash
cd /opt/worldmonitor && git pull && ./scripts/update-relay.sh
```
Check output for channel status summary.

**Step 3: Watch logs**
```bash
journalctl -u worldmonitor-relay -f | grep -E 'cron|fetch|channel|error|warn' | head -50
```

**Step 4: Inspect Redis keys**
```bash
redis-cli KEYS "relay:*" | sort
redis-cli TTL relay:climate:v1
redis-cli TTL relay:conflict:v1
redis-cli TTL conflict:ucdp-events:v1
```

**Step 5: Browser verification**

Open browser dev tools on site. Verify:
- No `GET /bootstrap 401` errors
- `[relay-push] connected` appears only 1-2 times (not every second)
- Panels load within 30 seconds of page load
- Check Network tab for failed `/api/...` calls (should be none for data routes)
