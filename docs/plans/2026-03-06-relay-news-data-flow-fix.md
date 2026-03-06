# Relay News Data Flow Fix

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ensure the relay server fetches all RSS feeds, caches digests in Redis, serves them via `/bootstrap` on first client connect, and pushes updates via WebSocket — with no Vercel or browser-side RSS calls.

**Architecture:** The relay (`scripts/ais-relay.cjs`) is the single source of truth for news data. It fetches feed URLs from Supabase (`get_public_news_sources`), fetches each RSS feed server-side, builds a digest, caches it in local Redis, and both serves it via the `/bootstrap` HTTP endpoint and pushes it via WebSocket. The frontend never fetches RSS directly.

**Tech Stack:** Node.js (CommonJS), Redis (ioredis), Supabase JS client, `node-cron`

---

## Current Architecture (what exists)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          RELAY SERVER (ais-relay.cjs)                   │
│                                                                         │
│  1. Supabase RPC: get_public_news_sources → feed URLs per variant       │
│  2. fetchNewsDigest(variant, lang):                                     │
│     a. fetchNewsSourcesForVariant(variant, lang) → grouped feed URLs    │
│     b. fetch each RSS URL server-side (15 concurrent, 8s timeout)       │
│     c. parseRssItems → classify by keyword → build categories           │
│     d. Return { categories, feedStatuses, generatedAt }                 │
│  3. directFetchAndBroadcast(channel, redisKey, ttl, fetcher):           │
│     a. Check Redis for cached data                                      │
│     b. If cached → broadcast to WS clients (skip fetch)                 │
│     c. If not cached → call fetcher → store in Redis → broadcast        │
│  4. Crons: news:full (*/5), news:tech (1-59/5), etc.                   │
│  5. /bootstrap endpoint: reads ALL PHASE4_CHANNEL_KEYS from Redis,      │
│     remaps via CHANNEL_TO_HYDRATION_KEY, returns JSON                   │
│  6. WS push: broadcasts { channel, data } to subscribed clients         │
└─────────────────────────────────────────────────────────────────────────┘
           │                          │
           │ /bootstrap (HTTP)        │ wss:// push
           ▼                          ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          FRONTEND (browser)                             │
│                                                                         │
│  1. fetchBootstrapData() → GET /bootstrap → hydrationCache              │
│  2. loadNewsSources() → reads hydrationCache['newsSources']             │
│  3. fetchNewsDigest() → reads hydrationCache['news:{variant}']          │
│  4. loadNews() → tryFetchDigest() → processDigestData()                │
│  5. subscribeRelayPush('news:{variant}') → applyNewsDigest()           │
│  6. subscribeRelayPush('config:news-sources') → applyNewsSources()     │
└─────────────────────────────────────────────────────────────────────────┘
```

## Identified Bugs

### Bug 1: Duplicate startup fetches (relay)

**File:** `scripts/ais-relay.cjs`, lines ~6570-6586

The previous editing session left **duplicate** startup fetch calls. Lines 6574-6580 (IIFE that awaits `config:news-sources` first, then fires news digests) and lines 6583-6586 (standalone `void` calls that fire immediately without waiting for sources). The standalone calls race ahead before `config:news-sources` is in Redis, so `fetchNewsSourcesForVariant` finds no sources and returns `{}`, producing an empty digest.

**Fix:** Remove the standalone duplicate calls (lines 6582-6586). Keep only the IIFE (lines 6572-6580) which correctly sequences: prime sources cache → then fetch digests.

### Bug 2: `directFetchAndBroadcast` never re-fetches stale data

**File:** `scripts/ais-relay.cjs`, lines 228-254

When `directFetchAndBroadcast` finds data in Redis (`cached` is truthy), it broadcasts the cached copy and returns immediately — it never re-fetches. This is correct for cron intervals (cron fires every 5 min, TTL is 900s = 15 min, so data is refreshed well within TTL). But on **startup**, if Redis has stale data from a previous run (Redis persistence is enabled), the startup call will broadcast stale data and skip re-fetch. The cron will eventually refresh it.

**Assessment:** This is working as designed. Stale-while-revalidate at the cron layer. No fix needed.

### Bug 3: `fetchNewsSourcesForVariant` filters by variant but `fetchNewsSourcesConfig` only fetches `p_variant: 'full'`

**File:** `scripts/ais-relay.cjs`

`fetchNewsSourcesConfig()` (line 6602) calls `supabase.rpc('get_public_news_sources', { p_variant: 'full' })` — only fetching `full` variant sources. The result is cached at `relay:config:news-sources`.

`fetchNewsSourcesForVariant(variant, lang)` (line 6296) reads from that same Redis key and then filters: `if (variant !== 'full' && row.variant && row.variant !== variant) continue;`. This means tech/finance/happy variants only get sources where `row.variant` matches or is absent.

**Question:** Does the Supabase `get_public_news_sources` RPC return sources for ALL variants when called with `p_variant: 'full'`, or only `full` sources? If it only returns `full`, then `news:tech`, `news:finance`, `news:happy` will always have empty feeds.

**Fix:** Change `fetchNewsSourcesConfig` to not pass a variant filter (or pass `'all'`), OR call it once per variant and merge. Need to check the Supabase function definition.

### Bug 4: No logging when `fetchNewsSourcesForVariant` returns empty

**File:** `scripts/ais-relay.cjs`, line 6296

When `fetchNewsSourcesForVariant` returns `{}`, `fetchNewsDigest` silently produces `{ categories: {}, feedStatuses: {}, generatedAt: ... }`. `directFetchAndBroadcast` sees this as truthy data (it's a non-null object) and caches it in Redis. Subsequent `/bootstrap` calls serve this empty digest. The frontend's `fetchNewsDigest()` checks `Object.keys(data.categories ?? {}).length === 0` and returns `null`, causing a blank news panel.

**Fix:** Add a guard in `fetchNewsDigest`: if `allFeeds.length === 0`, log a warning and return `null` so `directFetchAndBroadcast` skips caching (line 248: `if (!data)` → skip).

---

## Tasks

### Task 1: Remove duplicate startup news fetches

**Files:**
- Modify: `scripts/ais-relay.cjs` (lines ~6582-6586)

**Step 1: Remove the standalone duplicate calls**

Find and delete these lines (they race ahead of the IIFE and produce empty digests):

```javascript
// DELETE THESE LINES:
// Kick off news digest fetches at startup so bootstrap has data immediately
void directFetchAndBroadcast('news:full',    'news:digest:v1:full:en',    900, () => fetchNewsDigest('full',    'en')).catch(() => {});
void directFetchAndBroadcast('news:tech',    'news:digest:v1:tech:en',    900, () => fetchNewsDigest('tech',    'en')).catch(() => {});
void directFetchAndBroadcast('news:finance', 'news:digest:v1:finance:en', 900, () => fetchNewsDigest('finance', 'en')).catch(() => {});
void directFetchAndBroadcast('news:happy',   'news:digest:v1:happy:en',   900, () => fetchNewsDigest('happy',   'en')).catch(() => {});
```

The IIFE block (lines 6572-6580) should remain — it correctly awaits `config:news-sources` first.

**Step 2: Verify the IIFE is correct**

The remaining startup block should look like:

```javascript
void directFetchAndBroadcast('giving', 'giving:summary:v1', 86400, fetchGivingSummary).catch(() => {});

// Prime config:news-sources cache first, then kick off news digest fetches
// so fetchNewsSourcesForVariant finds the sources in Redis on startup.
void (async () => {
  try { await directFetchAndBroadcast('config:news-sources', 'relay:config:news-sources', 300, fetchNewsSourcesConfig); } catch { /* no Supabase — skip */ }
  void directFetchAndBroadcast('news:full',    'news:digest:v1:full:en',    900, () => fetchNewsDigest('full',    'en')).catch(() => {});
  void directFetchAndBroadcast('news:tech',    'news:digest:v1:tech:en',    900, () => fetchNewsDigest('tech',    'en')).catch(() => {});
  void directFetchAndBroadcast('news:finance', 'news:digest:v1:finance:en', 900, () => fetchNewsDigest('finance', 'en')).catch(() => {});
  void directFetchAndBroadcast('news:happy',   'news:digest:v1:happy:en',   900, () => fetchNewsDigest('happy',   'en')).catch(() => {});
})();
```

**Step 3: Commit**

```bash
git add scripts/ais-relay.cjs
git commit -m "fix: remove duplicate startup news fetches that race ahead of sources cache"
```

---

### Task 2: Guard against empty digests being cached

**Files:**
- Modify: `scripts/ais-relay.cjs` — `fetchNewsDigest` function (~line 6345)

**Step 1: Add empty-feed guard with logging**

At the top of `fetchNewsDigest`, after `fetchNewsSourcesForVariant` returns and `allFeeds` is built, add:

```javascript
async function fetchNewsDigest(variant, lang) {
  const feedsByCategory = await fetchNewsSourcesForVariant(variant, lang);
  const categories = {};
  const feedStatuses = {};
  const allFeeds = [];
  for (const [cat, feeds] of Object.entries(feedsByCategory)) {
    for (const f of feeds) allFeeds.push({ category: cat, feed: f });
  }

  // ADD THIS: prevent caching empty digest when no sources are available
  if (allFeeds.length === 0) {
    console.warn(`[relay] fetchNewsDigest(${variant}) — no feed sources available, skipping`);
    return null;
  }

  // ... rest of function unchanged
```

Returning `null` causes `directFetchAndBroadcast` to log "fetcher returned no data — skipping cache and broadcast" and skip writing an empty object to Redis.

**Step 2: Commit**

```bash
git add scripts/ais-relay.cjs
git commit -m "fix: prevent empty news digests from being cached in Redis"
```

---

### Task 3: Investigate Supabase `get_public_news_sources` variant filtering

**Files:**
- Check: Supabase function `get_public_news_sources` definition
- Potentially modify: `scripts/ais-relay.cjs` — `fetchNewsSourcesConfig` function

**Step 1: Check the Supabase function**

Look up the SQL function definition for `get_public_news_sources`. Determine:
- Does `p_variant = 'full'` return sources for ALL variants, or only variant='full'?
- Does the `variant` column exist on the `news_sources` table?
- What values does `variant` take? (`full`, `tech`, `finance`, `happy`?)

If sources have a `variant` column AND the RPC filters by it, then `fetchNewsSourcesConfig` calling with `p_variant: 'full'` means only `full` sources are cached. The `fetchNewsSourcesForVariant` Redis path would then have no tech/finance/happy sources.

**Step 2: Fix based on findings**

**Option A — If the RPC returns all sources regardless of variant:**
No change needed. The `variant` filter in `fetchNewsSourcesForVariant` handles client-side filtering.

**Option B — If the RPC filters by variant:**
Change `fetchNewsSourcesConfig` to call without a variant filter, or call once per variant:

```javascript
async function fetchNewsSourcesConfig() {
  if (!supabase) throw new Error('Supabase client not configured');
  // Fetch sources for all variants and merge into one array
  const variants = ['full', 'tech', 'finance', 'happy'];
  const all = [];
  for (const v of variants) {
    const { data, error } = await supabase.rpc('get_public_news_sources', { p_variant: v });
    if (!error && data) all.push(...data.map(row => ({ ...row, variant: v })));
  }
  if (all.length === 0) throw new Error('No news sources returned');
  return all;
}
```

**Step 3: Commit**

```bash
git add scripts/ais-relay.cjs
git commit -m "fix: fetch news sources for all variants in config cache"
```

---

### Task 4: Add startup logging for news flow diagnostics

**Files:**
- Modify: `scripts/ais-relay.cjs` — startup IIFE and `fetchNewsSourcesForVariant`

**Step 1: Add logging to the startup IIFE**

```javascript
void (async () => {
  try {
    await directFetchAndBroadcast('config:news-sources', 'relay:config:news-sources', 300, fetchNewsSourcesConfig);
    console.log('[relay-startup] config:news-sources cached successfully');
  } catch (err) {
    console.warn('[relay-startup] config:news-sources failed:', err?.message ?? err);
  }
  for (const v of ['full', 'tech', 'finance', 'happy']) {
    void directFetchAndBroadcast(`news:${v}`, `news:digest:v1:${v}:en`, 900, () => fetchNewsDigest(v, 'en'))
      .then(() => console.log(`[relay-startup] news:${v} digest ready`))
      .catch((err) => console.warn(`[relay-startup] news:${v} digest failed:`, err?.message ?? err));
  }
})();
```

**Step 2: Add logging to `fetchNewsSourcesForVariant`**

After the grouping loop, log the count:

```javascript
  // At end of fetchNewsSourcesForVariant, before return:
  const totalFeeds = Object.values(grouped).reduce((sum, arr) => sum + arr.length, 0);
  if (totalFeeds === 0) console.warn(`[relay] fetchNewsSourcesForVariant(${variant}) — 0 feeds found`);
  return grouped;
```

**Step 3: Commit**

```bash
git add scripts/ais-relay.cjs
git commit -m "feat: add startup and feed-source diagnostics logging"
```

---

### Task 5: Verify end-to-end data flow

**Step 1: Deploy relay changes**

```bash
./scripts/update-relay.sh
```

**Step 2: Check relay logs for news startup**

```bash
journalctl -u worldmonitor-relay -f --since "1 min ago"
```

Expected log lines:
- `[relay-startup] config:news-sources cached successfully`
- `[relay-startup] news:full digest ready`
- `[relay-startup] news:tech digest ready`
- `[relay-startup] news:finance digest ready`
- `[relay-startup] news:happy digest ready`

If you see `0 feeds found` or `no feed sources available`, the Supabase RPC is not returning data — investigate Task 3.

**Step 3: Test `/bootstrap` endpoint**

```bash
curl -s -H "Authorization: Bearer $RELAY_WS_TOKEN" https://relay.5ls.us/bootstrap | python3 -m json.tool | grep -c '"news:full"'
```

Expected: `1` (the key exists with non-empty data)

**Step 4: Rebuild and deploy frontend**

```bash
npm run build
# deploy dist/ to web server
```

**Step 5: Verify in browser console**

After hard-refresh:
- No calls to `/api/rss-proxy` or any Vercel news endpoints
- `[relay-push] connected, subscribing to (32) [...]` — includes `news:full`
- News panel loads with articles from the bootstrap hydration
- After 5 minutes, a WS push refreshes the digest

---

## Data Flow Diagram (target state)

```
STARTUP:
  Relay boots → Redis connects
    → fetchNewsSourcesConfig() → Supabase RPC → Redis[relay:config:news-sources]
    → fetchNewsDigest('full','en')
        → fetchNewsSourcesForVariant('full','en')
            → Redis[relay:config:news-sources] (HIT — just cached above)
            → group by category, return { politics: [...], us: [...], ... }
        → fetch each RSS URL server-side (batches of 15)
        → parseRssItems → classifyNewsTitle → build categories
        → return { categories, feedStatuses, generatedAt }
    → directFetchAndBroadcast stores in Redis[news:digest:v1:full:en]
    → broadcast to any connected WS clients

CRON (every 5 min):
  Same as startup, but directFetchAndBroadcast checks Redis first:
    - If TTL not expired → broadcast cached copy
    - If expired/missing → re-fetch from RSS, update Redis, broadcast

CLIENT CONNECT:
  Browser → GET /bootstrap → relay reads all PHASE4_CHANNEL_KEYS from Redis
    → remaps via CHANNEL_TO_HYDRATION_KEY
    → returns JSON with key 'news:full' containing the digest
  Browser → fetchBootstrapData() → hydrationCache.set('news:full', digest)
  Browser → loadNewsSources() → hydrationCache.get('newsSources')
  Browser → fetchNewsDigest(0) → hydrationCache.get('news:full') → returns digest
  Browser → processDigestData(digest) → renders news panel

LIVE UPDATE:
  Relay cron fires → fetchNewsDigest → new data → Redis + WS broadcast
  Browser → subscribeRelayPush('news:full') → applyNewsDigest(payload) → re-render
```
