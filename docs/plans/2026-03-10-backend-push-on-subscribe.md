# Backend: Push-on-Subscribe & Data Pipeline Fix

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the gateway push current Redis data to clients on WebSocket subscribe, fix gRPC size limits, add worker payload safety, fix AI Redis key mismatches, and add incremental AI processing.

**Architecture:** Gateway reads Redis on `wm-subscribe` → sends `wm-push` per channel. Workers use `safeBroadcast()` with size limits. AI generators read previous output and diff inputs.

**Tech Stack:** Node.js CommonJS (gateway, workers, AI engine), Redis (ioredis), gRPC (`@grpc/grpc-js`)

**Companion plan:** `docs/plans/2026-03-10-frontend-push-on-subscribe.md` — frontend changes that consume these backend changes. Both plans use identical channel names, Redis keys, and message formats.

---

## Shared Contract: Channel → Redis Key → Message Format

This table is the single source of truth. Both frontend and backend plans reference it.

| Channel key | Redis key | Unwrapped payload shape (what frontend receives) |
|---|---|---|
| `markets` | `market:dashboard:v1` | `{ stocks: [], commodities: [], sectors: [], crypto: [], rateLimited: bool, finnhubSkipped: bool }` |
| `predictions` | `relay:predictions:v1` | `{ markets: [{ title, yesPrice, volume, url, closesAt }] }` |
| `fred` | `relay:fred:v1` | `{ series: [{ id, title, ... }] }` |
| `oil` | `relay:oil:v1` | `{ prices: [{ date, value, ... }] }` |
| `bis` | `relay:bis:v1` | `{ rates: [{ country, rate, date }] }` |
| `conflict` | `relay:conflict:v1` | `{ events: [{ id, country, region, lat, lon, ... }], count: N }` |
| `ucdp-events` | `conflict:ucdp-events:v1` | `{ events: [], count: N, success: true }` |
| `telegram` | `relay:telegram:v1` | `{ items: [{ id, channel, text, ts, ... }], count: N, enabled: true, updatedAt: ISO }` |
| `gdelt` | `relay:gdelt:v1` | `{ data: { [topicId]: { articles: [], query, fetchedAt } } }` |
| `intelligence` | `ai:digest:global:v1` | `{ digest: string, highlights: [], regions: [], generatedAt: ISO }` |
| `cables` | `relay:cables:v1` | `{ cables: [], generatedAt: ISO }` |
| `cyber` | `relay:cyber:v1` | `{ threats: [] }` |
| `climate` | `relay:climate:v1` | `{ anomalies: [] }` |
| `natural` | `relay:natural:v1` | `{ fireDetections: [] }` |
| `flights` | `relay:flights:v1` | `{ alerts: [] }` |
| `ais` | `relay:ais-snapshot:v1` | `{ vessels: [], count: N, timestamp: ISO }` |
| `oref` | `relay:oref:v1` | `{ configured: bool, alerts: [], historyCount24h: N, timestamp: ISO }` |
| `trade` | `relay:trade:v1` | `{ restrictions: {}, tariffs: {}, flows: {}, barriers: {} }` |
| `supply-chain` | `supply_chain:chokepoints:v1` | `{ shipping: {}, chokepoints: {}, minerals: {} }` |
| `giving` | `giving:summary:v1` | `{ platforms: [], ... }` |
| `spending` | `relay:spending:v1` | `{ awards: [] }` |
| `gulf-quotes` | `relay:gulf-quotes:v1` | `{ quotes: [] }` |
| `strategic-posture` | `theater-posture:sebuf:v1` | `{ theaters: [], ... }` |
| `strategic-risk` | `risk:scores:sebuf:v1` | `{ scores: [], ... }` |
| `stablecoins` | `relay:stablecoins:v1` | (panel uses `applyPush`) |
| `etf-flows` | `relay:etf-flows:v1` | (panel uses `applyPush`) |
| `macro-signals` | `economic:macro-signals:v1` | (panel uses `applyPush`) |
| `service-status` | `relay:service-status:v1` | (panel uses `applyPush`) |
| `tech-events` | `relay:tech-events:v1` | `{ events: [] }` |
| `gps-interference` | `relay:gps-interference:v1` | (map layer) |
| `weather` | `relay:weather:v1` | (map layer) |
| `eonet` | `relay:eonet:v1` | (map layer) |
| `gdacs` | `relay:gdacs:v1` | (map layer) |
| `iran-events` | `conflict:iran-events:v1` | `{ events: [] }` |
| `pizzint` | `intel:pizzint:v1` | `{ pizzint: {}, tensionPairs: [] }` |
| `news:full` | `news:digest:v1:full:en` | `{ categories: { [cat]: { items: [] } }, generatedAt: ISO }` |
| `news:tech` | `news:digest:v1:tech:en` | (same shape as news:full) |
| `news:finance` | `news:digest:v1:finance:en` | (same shape as news:full) |
| `news:happy` | `news:digest:v1:happy:en` | (same shape as news:full) |
| `ai:intel-digest` | `ai:digest:global:v1` | (same Redis key as `intelligence`) |
| `ai:panel-summary` | `ai:panel-summary:v1` | `{ summary, keyEvents, riskLevel }` |
| `ai:article-summaries` | `ai:article-summaries:v1` | `{ [hash]: { summary } }` |
| `ai:classifications` | `ai:classifications:v1` | `{ [hash]: { classification } }` |
| `ai:country-briefs` | `ai:country-briefs:v1` | `{ briefs: { [countryCode]: { brief } } }` |
| `ai:posture-analysis` | `ai:posture-analysis:v1` | `{ analyses: [] }` |
| `ai:instability-analysis` | `ai:instability-analysis:v1` | `{ analyses: [] }` |
| `ai:risk-overview` | `ai:risk-overview:v1` | `{ overview, topRisks, interconnections }` |
| `config:news-sources` | `relay:config:news-sources` | `[{ name, url, ... }]` |
| `config:feature-flags` | `relay:config:feature-flags` | `{ [flag]: value }` |

---

## Task 1: Gateway — Push current data on `wm-subscribe`

**Files:**
- Modify: `services/gateway/index.cjs` lines 208–225 (the `subscribe` function) and lines 417–434 (the `wss.on('connection')` handler)

**Step 1: Add async `pushCurrentData` function after the `subscribe` function (after line 225)**

```javascript
async function pushCurrentData(ws, channels) {
  if (!Array.isArray(channels) || channels.length === 0) return;
  const validChannels = channels.filter(ch => typeof ch === 'string' && PHASE4_CHANNEL_KEYS[ch]);
  if (validChannels.length === 0) return;

  const settled = await Promise.allSettled(
    validChannels.map(ch => get(PHASE4_CHANNEL_KEYS[ch]))
  );

  for (let i = 0; i < validChannels.length; i++) {
    const ch = validChannels[i];
    const result = settled[i];
    if (result.status !== 'fulfilled' || result.value === null || result.value === undefined) continue;

    const unwrapped = unwrapEnvelope(result.value);
    if (unwrapped === null || unwrapped === undefined) continue;

    const ts = Math.floor(Date.now() / 1000);
    try {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'wm-push', channel: ch, data: unwrapped, ts }));
      }
    } catch (err) {
      log.debug('pushCurrentData send error', { channel: ch, error: err.message });
    }
  }
}
```

**Step 2: Call `pushCurrentData` from the `wm-subscribe` handler (line 426–427)**

Current code:
```javascript
if (msg.type === 'wm-subscribe' && Array.isArray(msg.channels)) {
  subscribe(ws, msg.channels);
}
```

New code:
```javascript
if (msg.type === 'wm-subscribe' && Array.isArray(msg.channels)) {
  subscribe(ws, msg.channels);
  pushCurrentData(ws, msg.channels).catch(err => {
    log.warn('pushCurrentData failed', { error: err.message });
  });
}
```

**Step 3: Run test to verify**

```bash
cd services && node -e "
const { unwrapEnvelope } = require('./gateway/index.cjs');
const e = { timestamp: '2026-01-01', source: 'test', status: 'success', data: { items: [1] } };
console.log('unwrap simple:', JSON.stringify(unwrapEnvelope(e)));
const rich = { timestamp: '2026-01-01', source: 'test', status: 'success', stocks: [1], commodities: [2] };
console.log('unwrap rich:', JSON.stringify(unwrapEnvelope(rich)));
console.log('unwrap null:', unwrapEnvelope(null));
"
```
Expected: simple returns `{ items: [1] }`, rich returns `{ stocks: [1], commodities: [2] }`, null returns null.

**Step 4: Commit**

```bash
git add services/gateway/index.cjs
git commit -m "feat(gateway): push current Redis data to client on wm-subscribe"
```

---

## Task 2: Gateway — Increase gRPC max message size

**Files:**
- Modify: `services/gateway/index.cjs` line 441 (gRPC server creation)
- Modify: `services/shared/grpc-client.cjs` lines 16–19 (gateway client creation)

**Step 1: Gateway server — add max message size options (line 441)**

Current code:
```javascript
const grpcServer = new grpc.Server();
```

New code:
```javascript
const grpcServer = new grpc.Server({
  'grpc.max_receive_message_length': 16 * 1024 * 1024,
  'grpc.max_send_message_length': 16 * 1024 * 1024,
});
```

**Step 2: Gateway client — add max message size options (line 18)**

Current code:
```javascript
function createGatewayClient(host, port) {
  const addr = `${host}:${port}`;
  return new GatewayService(addr, grpc.credentials.createInsecure());
}
```

New code:
```javascript
function createGatewayClient(host, port) {
  const addr = `${host}:${port}`;
  return new GatewayService(addr, grpc.credentials.createInsecure(), {
    'grpc.max_receive_message_length': 16 * 1024 * 1024,
    'grpc.max_send_message_length': 16 * 1024 * 1024,
  });
}
```

**Step 3: Commit**

```bash
git add services/gateway/index.cjs services/shared/grpc-client.cjs
git commit -m "fix(grpc): increase max message size to 16MB to prevent RESOURCE_EXHAUSTED"
```

---

## Task 3: Workers — Add `safeBroadcast` wrapper

**Files:**
- Modify: `services/shared/grpc-client.cjs` — add `safeBroadcast` function and export it

**Step 1: Add `safeBroadcast` after the existing `broadcast` function (after line 39)**

```javascript
const MAX_BROADCAST_BYTES = 3 * 1024 * 1024;

function safeBroadcast(client, { channel, payload, timestampMs, triggerId, maxBytes }) {
  const limit = typeof maxBytes === 'number' && maxBytes > 0 ? maxBytes : MAX_BROADCAST_BYTES;
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));

  if (buf.length > limit) {
    const msg = `Payload exceeds max broadcast size (${buf.length} > ${limit})`;
    // Return a resolved promise with skip info instead of throwing
    return Promise.resolve({ clients_notified: 0, skipped: true, reason: msg, bytes: buf.length });
  }

  return broadcast(client, { channel, payload: buf, timestampMs, triggerId });
}
```

**Step 2: Update exports (line 58)**

Current:
```javascript
module.exports = { createGatewayClient, createWorkerClient, broadcast, execute };
```

New:
```javascript
module.exports = { createGatewayClient, createWorkerClient, broadcast, safeBroadcast, execute };
```

**Step 3: Update worker-runner to use safeBroadcast (services/shared/worker-runner.cjs line 52–54)**

Current:
```javascript
if (typeof grpcBroadcast === 'function') {
  await grpcBroadcast(service_key, result, trigger_id);
}
```

New:
```javascript
if (typeof grpcBroadcast === 'function') {
  const broadcastResult = await grpcBroadcast(service_key, result, trigger_id);
  if (broadcastResult?.skipped) {
    log.warn('Broadcast skipped — payload too large', {
      service_key, trigger_id, bytes: broadcastResult.bytes, reason: broadcastResult.reason,
    });
  }
}
```

**Step 4: Update worker/index.cjs grpcBroadcast to use safeBroadcast**

Find where `grpcBroadcast` is defined (the function passed to `runWorker`). It currently calls `broadcast()`. Change it to call `safeBroadcast()`.

```bash
cd services && grep -n 'grpcBroadcast\|broadcast(' worker/index.cjs | head -20
```

Update the import and the function to use `safeBroadcast` instead of `broadcast`.

**Step 5: Commit**

```bash
git add services/shared/grpc-client.cjs services/shared/worker-runner.cjs services/worker/index.cjs
git commit -m "feat(workers): add safeBroadcast with 3MB payload limit and logging"
```

---

## Task 4: AIS processor — Cap vessel count

**Files:**
- Modify: `services/ais-processor/index.cjs` lines 50–56 (the `getSnapshot` function)

**Step 1: Add vessel cap constant (after line 14)**

```javascript
const MAX_VESSELS = 20000;
```

**Step 2: Replace `getSnapshot` function (lines 50–56)**

Current:
```javascript
function getSnapshot() {
  return {
    vessels: Array.from(vessels.values()),
    count: vessels.size,
    timestamp: new Date().toISOString(),
  };
}
```

New:
```javascript
function getSnapshot() {
  let vesselArray = Array.from(vessels.values());
  if (vesselArray.length > MAX_VESSELS) {
    vesselArray.sort((a, b) => {
      const ta = a.timestamp || '';
      const tb = b.timestamp || '';
      return tb.localeCompare(ta);
    });
    vesselArray = vesselArray.slice(0, MAX_VESSELS);
  }
  return {
    vessels: vesselArray,
    count: vesselArray.length,
    totalTracked: vessels.size,
    timestamp: new Date().toISOString(),
  };
}
```

**Step 3: Update writeSnapshot to use safeBroadcast (lines 67–78)**

Current:
```javascript
if (gatewayClient && snapshot.count > 0) {
  try {
    await broadcast(gatewayClient, {
```

New (update import at top to include safeBroadcast):
```javascript
const { createGatewayClient, safeBroadcast } = require('@worldmonitor/shared/grpc-client.cjs');
```

Then update the broadcast call:
```javascript
if (gatewayClient && snapshot.count > 0) {
  try {
    const result = await safeBroadcast(gatewayClient, {
      channel: 'ais',
      payload: Buffer.from(JSON.stringify(snapshot)),
      timestampMs: Date.now(),
      triggerId: 'ais-processor',
    });
    if (result?.skipped) {
      log.warn('AIS broadcast skipped — payload too large', { vessels: snapshot.count, bytes: result.bytes });
    }
  } catch (err) {
    log.warn('Failed to broadcast AIS snapshot', { error: err.message });
  }
}
```

**Step 4: Commit**

```bash
git add services/ais-processor/index.cjs
git commit -m "fix(ais-processor): cap vessels at 20k and use safeBroadcast"
```

---

## Task 5: Fix AI generator Redis key mismatch

**Files:**
- Modify: `services/ai-engine/generators/*.cjs` — every file that reads `relay:news:full:v1`

**Step 1: Find all occurrences**

```bash
cd services && grep -rn 'relay:news:full:v1' ai-engine/
```

**Step 2: Replace every occurrence**

Change `relay:news:full:v1` → `news:digest:v1:full:en`

The news digest is stored at `news:digest:v1:full:en` (see `channel-keys.json` line 47). The key `relay:news:full:v1` does not exist — nothing writes to it.

**Step 3: Update how AI reads news data**

The news digest has shape `{ categories: { politics: { items: [] }, tech: { items: [] }, ... }, generatedAt }`.

AI generators that currently expect `{ items: [] }` or `{ data: [] }` need to flatten categories:

```javascript
const newsRaw = await redis.get('news:digest:v1:full:en');
let newsItems = [];
if (newsRaw) {
  const parsed = typeof newsRaw === 'string' ? JSON.parse(newsRaw) : newsRaw;
  const unwrapped = unwrapEnvelope(parsed);
  if (unwrapped?.categories) {
    for (const cat of Object.values(unwrapped.categories)) {
      if (cat?.items) newsItems.push(...cat.items);
    }
  } else if (Array.isArray(unwrapped?.data)) {
    newsItems = unwrapped.data;
  } else if (Array.isArray(unwrapped?.items)) {
    newsItems = unwrapped.items;
  } else if (Array.isArray(unwrapped)) {
    newsItems = unwrapped;
  }
}
```

Apply this pattern to each AI generator that reads news.

**Step 4: Also fix these Redis key references if present:**
- `relay:telegram:v1` → correct (matches `channel-keys.json` line 19)
- `relay:markets:v1` → should be `market:dashboard:v1` (matches `channel-keys.json` line 3)
- `relay:strategic-risk:v1` → should be `risk:scores:sebuf:v1` (matches `channel-keys.json` line 31)
- `relay:strategic-posture:v1` → should be `theater-posture:sebuf:v1` (matches `channel-keys.json` line 30)
- `relay:conflict:v1` → correct (matches `channel-keys.json` line 16)
- `relay:cyber:v1` → correct (matches `channel-keys.json` line 15)
- `relay:natural:v1` → correct (matches `channel-keys.json` line 11)
- `relay:opensky:v1` → should be `relay:ais-snapshot:v1` (matches `channel-keys.json` line 21) — opensky is the same AIS data

**Step 5: Commit**

```bash
git add services/ai-engine/
git commit -m "fix(ai-engine): correct all Redis key references to match channel-keys.json"
```

---

## Task 6: AI generators — Read previous output and diff inputs

**Files:**
- Modify: `services/ai-engine/generators/intel-digest.cjs` (as the first generator to convert)
- Modify: `services/shared/worker-runner.cjs` — store previous snapshot before overwrite

**Step 1: worker-runner stores previous snapshot (lines 49–50)**

Current:
```javascript
const ttl = typeof ttl_seconds === 'number' && ttl_seconds > 0 ? ttl_seconds : 300;
await redis.setex(redis_key, ttl, result);
```

New:
```javascript
const ttl = typeof ttl_seconds === 'number' && ttl_seconds > 0 ? ttl_seconds : 300;

// Store previous snapshot for AI incremental processing
const previousKey = `${redis_key}:previous`;
try {
  const currentData = await redis.get(redis_key);
  if (currentData !== null && currentData !== undefined) {
    const prevTtl = Math.max(ttl * 2, 600);
    await redis.setex(previousKey, prevTtl, currentData);
  }
} catch (_) {
  // Non-critical: if previous snapshot fails, AI will do full rebuild
}

await redis.setex(redis_key, ttl, result);
```

**Step 2: Intel digest generator reads previous output and diffs**

In `services/ai-engine/generators/intel-digest.cjs`, add to the generate function:

```javascript
// Read previous AI output
const previousDigest = await redis.get('ai:digest:global:v1');
let previousSummary = null;
if (previousDigest) {
  try {
    const parsed = typeof previousDigest === 'string' ? JSON.parse(previousDigest) : previousDigest;
    previousSummary = parsed?.digest || parsed?.summary || null;
  } catch (_) {}
}

// Read previous news snapshot to detect new items
const previousNews = await redis.get('news:digest:v1:full:en:previous');
let previousTitles = new Set();
if (previousNews) {
  try {
    const parsed = typeof previousNews === 'string' ? JSON.parse(previousNews) : previousNews;
    // extract titles from previous news for dedup
    const items = flattenNewsItems(parsed);
    previousTitles = new Set(items.map(i => i.title));
  } catch (_) {}
}

// Filter to only new items
const newItems = newsItems.filter(i => !previousTitles.has(i.title));

// If nothing new and we have a previous digest, skip LLM call
if (newItems.length === 0 && previousSummary) {
  log.info('No new items since last digest, keeping previous output');
  return previousDigest;
}
```

Update the LLM prompt to include previous context:
```javascript
const prompt = previousSummary
  ? `Here is the previous intelligence digest:\n${previousSummary}\n\nHere are ${newItems.length} new developments since then. Update the digest to incorporate them:\n${JSON.stringify(newItems.slice(0, 25))}`
  : `Analyze the following intelligence data and produce a digest:\n${JSON.stringify(newsItems.slice(0, 25))}`;
```

**Step 3: Apply same pattern to other AI generators**

Repeat the incremental pattern for:
- `ai:panel-summary` — reads previous from `ai:panel-summary:v1`
- `ai:risk-overview` — reads previous from `ai:risk-overview:v1`
- `ai:country-briefs` — reads previous from `ai:country-briefs:v1`
- `ai:posture-analysis` — reads previous from `ai:posture-analysis:v1`
- `ai:instability-analysis` — reads previous from `ai:instability-analysis:v1`

Each should:
1. Read its own previous output
2. Read `{inputKey}:previous` for each input
3. Diff to find new items
4. Skip LLM if nothing changed
5. Send "update previous summary with new data" prompt if incremental

**Step 4: Commit**

```bash
git add services/shared/worker-runner.cjs services/ai-engine/
git commit -m "feat(ai-engine): incremental AI processing — diff inputs, skip when unchanged"
```

---

## Task 7: Wire up OpenSky in channel registry

**Files:**
- Modify: `src/config/channel-registry.ts` — add `opensky` entry
- Run: `npm run generate:channel-keys` to regenerate `services/gateway/channel-keys.json`

**Step 1: Add opensky to CHANNEL_REGISTRY (after the `ais` entry, around line 246)**

```typescript
opensky: {
  key: 'opensky',
  redisKey: 'relay:opensky:v1',
  panels: ['map'],
  domain: 'infrastructure',
  staleAfterMs: 5 * 60_000,
  timeoutMs: 30_000,
  required: false,
  mapLayers: ['flights'],
  applyMethod: 'applyOpenSky',
},
```

**Step 2: Regenerate channel-keys.json**

```bash
npm run generate:channel-keys
```

**Step 3: Verify the key appears in channel-keys.json**

```bash
grep 'opensky' services/gateway/channel-keys.json
```

Expected: `"opensky": "relay:opensky:v1"`

**Step 4: Commit**

```bash
git add src/config/channel-registry.ts services/gateway/channel-keys.json
git commit -m "feat(config): wire up opensky channel in registry and gateway"
```

---

## Task 8: Gateway — Add `/rss` proxy route

**Files:**
- Modify: `services/gateway/index.cjs` — add `/rss` route in the HTTP handler (after the `/gdelt` route, around line 401)

**Step 1: Add RSS proxy route**

```javascript
if (pathname === '/rss') {
  const rssUrl = url.searchParams.get('url');
  if (!rssUrl) {
    res.writeHead(400, { [CORS_HEADER]: CORS_VALUE, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'url parameter required' }));
    return;
  }
  try {
    const parsed = new URL(rssUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      res.writeHead(400, { [CORS_HEADER]: CORS_VALUE, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Only http/https URLs allowed' }));
      return;
    }
  } catch {
    res.writeHead(400, { [CORS_HEADER]: CORS_VALUE, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid URL' }));
    return;
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const rssResp = await fetch(rssUrl, {
      headers: { 'User-Agent': 'WorldMonitor/1.0', Accept: 'application/rss+xml, application/xml, text/xml' },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!rssResp.ok) {
      res.writeHead(502, { [CORS_HEADER]: CORS_VALUE, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `RSS fetch failed: ${rssResp.status}` }));
      return;
    }
    const body = await rssResp.text();
    res.writeHead(200, { [CORS_HEADER]: CORS_VALUE, 'Content-Type': 'application/xml' });
    res.end(body);
    return;
  } catch (err) {
    log.error('RSS proxy error', { url: rssUrl, error: err.message });
    res.writeHead(502, { [CORS_HEADER]: CORS_VALUE, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'RSS proxy failed' }));
    return;
  }
}
```

**Step 2: Commit**

```bash
git add services/gateway/index.cjs
git commit -m "feat(gateway): add /rss proxy route for security advisories feed"
```

---

## Task 9: Fix stub workers

**Files:**
- Modify: `services/shared/channels/giving.cjs`
- Modify: `services/shared/channels/aviation-precache.cjs`

**Step 1: Check if giving has a real implementation elsewhere**

```bash
cd services && grep -rn 'giving' shared/channels/ --include='*.cjs' | head -20
```

If `giving.cjs` is truly a stub (`{ data: [], status: 'stub' }`), either:
- a) Implement it by fetching from the giving data source, or
- b) Mark it clearly with `status: 'not_implemented'` and return `{ platforms: [], totalDonated: 0, lastUpdated: new Date().toISOString() }` so the frontend handler doesn't discard it

For now, return a well-formed empty payload matching the contract:

```javascript
module.exports = async function giving({ config, redis, log, http }) {
  log.info('giving: returning empty summary (not yet implemented)');
  return {
    timestamp: new Date().toISOString(),
    source: 'giving',
    status: 'success',
    data: {
      platforms: [],
      totalDonated: 0,
      lastUpdated: new Date().toISOString(),
    },
  };
};
```

**Step 2: Same for aviation-precache — return well-formed empty payload**

**Step 3: Commit**

```bash
git add services/shared/channels/giving.cjs services/shared/channels/aviation-precache.cjs
git commit -m "fix(workers): replace stubs with well-formed empty payloads"
```

---

## Task 10: Fix broken diagnostic scripts

**Files:**
- Modify: `scripts/diagnose-workers.sh` — fix paths and commands
- Modify: `scripts/check-redis-data-nc.sh` — fix hardcoded paths

**Step 1: Fix diagnose-workers.sh**

Replace `~/worldmon/services` with relative path `./services` or use `$(dirname "$0")/../services`.
Replace the broken `curl -X POST http://orchestrator:3000/trigger/...` with a note that the orchestrator uses Supabase `trigger_requests` table, not HTTP.

**Step 2: Fix check-redis-data-nc.sh**

Replace `/home/ubuntu/worldmon/services` with a portable path using `$(cd "$(dirname "$0")/.." && pwd)/services`.

**Step 3: Commit**

```bash
git add scripts/diagnose-workers.sh scripts/check-redis-data-nc.sh
git commit -m "fix(scripts): update hardcoded paths and remove invalid orchestrator HTTP commands"
```

---

## Execution Order

| Task | Risk | Effort | What it fixes |
|---|---|---|---|
| **2. gRPC max size** | None | 5 min | AIS broadcast RESOURCE_EXHAUSTED crash |
| **3. safeBroadcast** | Low | 15 min | Prevents future size crashes for all workers |
| **4. AIS vessel cap** | Low | 10 min | AIS data delivery fixed |
| **1. Push-on-subscribe** | Medium | 20 min | Core fix — panels get data on connect |
| **5. AI Redis keys** | Low | 30 min | AI generators actually read news data |
| **6. Incremental AI** | Medium | 45 min | AI stops re-summarizing identical content |
| **7. OpenSky wiring** | Low | 10 min | Posture analysis gets flight data |
| **8. RSS route** | Low | 15 min | Security advisories panel works with gateway |
| **9. Stub workers** | Low | 10 min | Empty payloads don't break handlers |
| **10. Script fixes** | None | 10 min | Diagnostic scripts work correctly |

**Do Tasks 2→3→4 first** (immediate AIS fix). Then Task 1 (core feature). Then 5→6→7→8→9→10.

---

## Success Criteria

1. AIS broadcasts succeed (no RESOURCE_EXHAUSTED errors)
2. When a WebSocket client sends `wm-subscribe`, it immediately receives `wm-push` messages for every subscribed channel that has data in Redis
3. AI generators read the correct Redis keys and produce summaries using actual news data
4. AI generators skip LLM calls when input data hasn't changed
5. `services/gateway/channel-keys.json` includes `opensky`
6. Gateway responds to `/rss?url=...` requests
7. No stub workers return `{ data: [], status: 'stub' }`
