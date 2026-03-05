# Relay-Driven Push Architecture Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace all client-side polling with server-push via the relay WebSocket — the relay fetches all dashboard data on schedule, warms Redis, and broadcasts to connected browser clients so the `RefreshScheduler` is no longer needed.

**Architecture:**
- `scripts/ais-relay.cjs` gains: typed channel subscription protocol, cron jobs that call Vercel API endpoints to warm Redis, and a broadcaster that reads Upstash Redis and sends fresh payloads to subscribed clients.
- New `src/services/relay-push.ts`: a singleton WebSocket client that connects to the relay, manages typed channel subscriptions, and dispatches payloads to registered handlers.
- `src/App.ts` wires channel handlers to `dataLoader` state updates and removes `RefreshScheduler` registrations for every channel that the relay now pushes.
- The relay already has Upstash Redis REST credentials — it reads results from Redis after calling Vercel to warm them, so no external API secrets need to be added to the relay host.

**Tech Stack:** `node-cron` (CommonJS), `ws` (already in relay), Upstash Redis REST (already in relay), TypeScript (client side), existing `src/app/data-loader.ts` / `src/App.ts`.

> **IMPORTANT — API path format:** All Vercel API routes use REST-style paths: `/api/{domain}/v1/{kebab-method-name}`. Do NOT use gRPC-style paths.
>
> **IMPORTANT — Redis keys:** Many server handlers use **parameterized** Redis keys (e.g. `cyber:threats:v2:${start}:${type}:${source}:${minSeverity}`). For these, the relay must warm with specific query params so the handler writes to a predictable key, OR the relay reads the response body from the warm call directly instead of reading from Redis.

---

## Context: Current polling inventory

| Name | Current interval | Relay push channel |
|------|----------------|--------------------|
| news / feeds | 15 min | `news:{variant}` |
| markets | 8 min | `markets` |
| predictions | 10 min | `predictions` |
| pizzint | 10 min | `pizzint` |
| fred | 30 min | `fred` |
| oil / energy | 30 min | `oil` |
| bis | 60 min | `bis` |
| tradePolicy | 10 min | `trade` |
| supplyChain | 10 min | `supply-chain` |
| intelligence | 15 min | `intelligence` |
| stablecoins panel | 3 min | `stablecoins` |
| etf-flows panel | 3 min | `etf-flows` |
| macro-signals panel | 3 min | `macro-signals` |
| strategic-posture | 15 min | `strategic-posture` |
| strategic-risk | 5 min | `strategic-risk` |
| service-status | 1 min | `service-status` |
| telegram-intel | 60 s | `telegram` |
| natural / firms | 30-60 min | `natural` |
| cables / cableHealth | 30 min / 2 hr | `cables` / `cable-health` |
| flights | 2 hr | `flights` |
| cyberThreats | 10 min | `cyber` |

All channels are pushed via relay. The browser makes **zero** API calls after initial page load — all data arrives via WebSocket push. The relay also sends current data on connect so the browser has data immediately.

> **Note on parameterized handlers:** Several handlers (cyber, fred, energy, predictions, stablecoins, trade, pizzint) use query-parameter-dependent Redis keys. For these, the relay should use the warm response body directly rather than reading from Redis, since the Redis key is unpredictable. See the `warmAndBroadcast` implementation in Task 2.

---

## Task 1: Add typed channel broadcast to relay (relay-side WS infrastructure)

**Files:**
- Modify: `scripts/ais-relay.cjs`
- Create: `tests/relay-channel-broadcast.test.mjs`

### Step 1: Write failing test

```javascript
// tests/relay-channel-broadcast.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('relay channel broadcast contract', () => {
  it('relay code defines broadcastToChannel function', () => {
    const src = readFileSync('scripts/ais-relay.cjs', 'utf8');
    assert.ok(src.includes('broadcastToChannel'), 'relay must have broadcastToChannel function');
  });

  it('relay raises MAX_WS_CLIENTS to at least 200', () => {
    const src = readFileSync('scripts/ais-relay.cjs', 'utf8');
    const match = src.match(/MAX_WS_CLIENTS\s*=\s*(\d+)/);
    assert.ok(match, 'MAX_WS_CLIENTS must exist');
    assert.ok(Number(match[1]) >= 200, `MAX_WS_CLIENTS must be >= 200, got ${match[1]}`);
  });

  it('relay handles subscribe message type', () => {
    const src = readFileSync('scripts/ais-relay.cjs', 'utf8');
    assert.ok(src.includes("'wm-subscribe'") || src.includes('"wm-subscribe"'),
      'relay must handle wm-subscribe message type');
  });

  it('relay sends wm-push typed messages', () => {
    const src = readFileSync('scripts/ais-relay.cjs', 'utf8');
    assert.ok(src.includes("'wm-push'") || src.includes('"wm-push"'),
      'relay must send wm-push typed messages');
  });
});
```

### Step 2: Run test to verify it fails

```bash
npm run test:data -- --test-name-pattern "relay channel broadcast"
```

Expected: FAIL

### Step 3: Implement in relay

Find the `MAX_WS_CLIENTS` constant near the top of `scripts/ais-relay.cjs` (currently `= 10`) and change it to `200`.

Then find the `clients` Set (tracks connected WebSocket clients) and add a **subscription map** immediately after:

```javascript
// ── Channel subscription registry ─────────────────────────────────────────────
const channelSubscribers = new Map(); // channel → Set<WebSocket>

const ALLOWED_CHANNELS = new Set([
  'markets', 'stablecoins', 'etf-flows', 'macro-signals', 'strategic-risk',
  'predictions', 'news:full', 'news:tech', 'news:finance', 'news:happy',
  'intelligence', 'trade', 'supply-chain', 'strategic-posture', 'pizzint',
  'cyber', 'service-status', 'cables', 'cable-health', 'fred', 'oil',
  'natural', 'bis', 'flights', 'ais', 'weather', 'spending', 'giving',
  'telegram', 'gulf-quotes', 'tech-events', 'oref', 'iran-events',
  'gps-interference', 'eonet', 'gdacs', 'config:news-sources',
  'config:feature-flags',
]);
const CHANNEL_PATTERN = /^[a-z0-9:_-]{1,63}$/;
const MAX_CHANNELS_PER_CLIENT = 50;
const MAX_WS_MESSAGE_BYTES = 64 * 1024;

// Per-client rate limiting for subscribe messages
const SUB_RATE_LIMIT_WINDOW_MS = 5_000;
const SUB_RATE_LIMIT_MAX = 20;
const wsSubRateLimit = new Map(); // ws → { count, resetAt }

function checkSubscribeRateLimit(ws) {
  const now = Date.now();
  let bucket = wsSubRateLimit.get(ws);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + SUB_RATE_LIMIT_WINDOW_MS };
    wsSubRateLimit.set(ws, bucket);
  }
  bucket.count++;
  return bucket.count <= SUB_RATE_LIMIT_MAX;
}

const clientChannelCount = new Map(); // ws → number

function subscribeClient(ws, channel) {
  if (!ALLOWED_CHANNELS.has(channel)) return;
  if (!CHANNEL_PATTERN.test(channel)) return;
  const count = clientChannelCount.get(ws) || 0;
  if (count >= MAX_CHANNELS_PER_CLIENT) return;
  if (!channelSubscribers.has(channel)) {
    channelSubscribers.set(channel, new Set());
  }
  channelSubscribers.get(channel).add(ws);
  clientChannelCount.set(ws, count + 1);
}

function unsubscribeClient(ws) {
  for (const subs of channelSubscribers.values()) {
    subs.delete(ws);
  }
  clientChannelCount.delete(ws);
  wsSubRateLimit.delete(ws);
}

// Cache the latest payload per channel so new subscribers get data immediately
const latestPayloads = new Map(); // channel → { msg: string, ts: number }

/**
 * Broadcast a typed payload to all clients subscribed to a channel.
 * Also caches the payload so new subscribers get it on connect.
 * @param {string} channel
 * @param {object} payload
 */
function broadcastToChannel(channel, payload) {
  const msg = JSON.stringify({ type: 'wm-push', channel, payload, ts: Date.now() });
  const msgBytes = Buffer.byteLength(msg);
  if (msgBytes > 512 * 1024) {
    console.warn(`[relay] payload too large for ${channel} (${msgBytes} bytes), skipping`);
    return;
  }
  latestPayloads.set(channel, msg);
  const subs = channelSubscribers.get(channel);
  if (!subs || subs.size === 0) return;
  for (const ws of subs) {
    if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 1024 * 1024) {
      ws.send(msg);
    }
  }
}

/**
 * Send cached payloads for all requested channels to a newly subscribed client.
 * Called after subscribe so the client gets data immediately without waiting for next cron.
 */
function sendCachedPayloads(ws, channels) {
  for (const ch of channels) {
    const cached = latestPayloads.get(ch);
    if (cached && ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 1024 * 1024) {
      ws.send(cached);
    }
  }
}
```

In the WebSocket `connection` handler, add a `message` listener for browser clients (currently browser clients only receive, never send). Add handling for `wm-subscribe`:

```javascript
ws.on('message', (data) => {
  if (data.length > MAX_WS_MESSAGE_BYTES) {
    ws.close(1009, 'Message too large');
    return;
  }
  try {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'wm-subscribe' && Array.isArray(msg.channels)) {
      if (!checkSubscribeRateLimit(ws)) {
        ws.close(1008, 'Subscribe rate limit exceeded');
        return;
      }
      const accepted = [];
      for (const ch of msg.channels) {
        if (typeof ch === 'string' && ALLOWED_CHANNELS.has(ch)) {
          subscribeClient(ws, ch);
          accepted.push(ch);
        }
      }
      ws.send(JSON.stringify({ type: 'wm-subscribed', channels: accepted }));
      sendCachedPayloads(ws, accepted);
      return;
    }
    if (msg.type === 'wm-unsubscribe' && Array.isArray(msg.channels)) {
      for (const ch of msg.channels) {
        const subs = channelSubscribers.get(ch);
        if (subs) subs.delete(ws);
      }
      return;
    }
  } catch {
    console.warn('[relay] received non-JSON message from client');
  }
});

ws.on('close', () => {
  clients.delete(ws);
  unsubscribeClient(ws);
});
```

Also add `verifyClient` to the WebSocketServer options to reject unauthorized clients at upgrade time (before the TCP connection handler):

```javascript
const wss = new WebSocketServer({
  server,
  verifyClient: (info, callback) => {
    const origin = info.req.headers.origin || '';
    if (origin && !getCorsOrigin(info.req)) {
      return callback(false, 403, 'Origin not allowed');
    }
    callback(true);
  },
});
```

### Step 4: Run test

```bash
npm run test:data -- --test-name-pattern "relay channel broadcast"
```

Expected: PASS

### Step 5: Commit

```bash
git add scripts/ais-relay.cjs tests/relay-channel-broadcast.test.mjs
git commit -m "feat(relay): add typed channel subscription and broadcastToChannel — enables push model replacing client polling"
```

---

## Task 2: Add relay cron jobs (warm Redis + broadcast)

The relay calls Vercel API endpoints on a schedule. Vercel handles external API calls and writes to Redis. The relay then reads that Redis key and broadcasts the result to subscribed WS clients. No external API secrets needed on the relay host.

**Files:**
- Modify: `scripts/ais-relay.cjs`
- Create: `tests/relay-cron-contracts.test.mjs`

### Step 1: Write failing test

```javascript
// tests/relay-cron-contracts.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('relay cron contracts', () => {
  it('relay requires node-cron', () => {
    const src = readFileSync('scripts/ais-relay.cjs', 'utf8');
    assert.ok(src.includes("require('node-cron')") || src.includes('require("node-cron")'),
      'relay must require node-cron');
  });

  it('relay defines scheduleWarmAndBroadcast function', () => {
    const src = readFileSync('scripts/ais-relay.cjs', 'utf8');
    assert.ok(src.includes('scheduleWarmAndBroadcast'),
      'relay must define scheduleWarmAndBroadcast');
  });

  it('relay schedules market cron every 5 minutes', () => {
    const src = readFileSync('scripts/ais-relay.cjs', 'utf8');
    assert.ok(src.includes("'*/5 * * * *'") || src.includes('"*/5 * * * *"'),
      'relay must schedule a cron every 5 minutes');
  });

  it('relay schedules news cron', () => {
    const src = readFileSync('scripts/ais-relay.cjs', 'utf8');
    assert.ok(src.includes('news') && src.includes('cron.schedule'),
      'relay must schedule a news cron');
  });
});
```

### Step 2: Run test to verify it fails

```bash
npm run test:data -- --test-name-pattern "relay cron contracts"
```

Expected: FAIL

### Step 3: Install node-cron on relay host

The relay runs as a Node.js CommonJS process. Add `node-cron` to the relay host:

```bash
# On relay.5ls.us (or in the repo root so pm2 can resolve it):
npm install node-cron
```

**Also add to `package.json` dependencies** so it survives `npm ci`:
```json
"node-cron": "^3.0.3"
```

### Step 4: Add cron infrastructure to relay

At the top of `scripts/ais-relay.cjs`, after the existing `require` block, add:

```javascript
const cron = require('node-cron');
```

Then add this block after `broadcastToChannel` is defined (near the end of the init section, before the HTTP server starts):

```javascript
// ── Relay warm-and-broadcast helpers ─────────────────────────────────────────

const VERCEL_APP_URL = process.env.VERCEL_APP_URL || 'https://worldmonitor.app';
const RELAY_WARMER_API_KEY = process.env.RELAY_WARMER_API_KEY || process.env.RELAY_SHARED_SECRET || '';

const ALLOWED_WARM_HOSTS = ['worldmonitor.app'];

function isAllowedWarmHost(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && ALLOWED_WARM_HOSTS.some(h => u.hostname === h || u.hostname.endsWith('.' + h));
  } catch { return false; }
}

if (UPSTASH_ENABLED && !RELAY_WARMER_API_KEY) {
  console.error('[relay] RELAY_WARMER_API_KEY or RELAY_SHARED_SECRET required for warm-and-broadcast');
}

/**
 * Warm a Vercel API endpoint then broadcast the response to subscribed clients.
 *
 * For handlers with parameterized Redis keys, we use the warm response body
 * directly rather than reading from Redis, since the Redis key is unpredictable.
 *
 * @param {string} channel  - WS channel to broadcast on
 * @param {string} path     - Vercel API path, e.g. '/api/news/v1/list-feed-digest?variant=full&lang=en'
 * @param {string} [redisKey] - Optional Upstash Redis key. If provided, reads from Redis after warming.
 *                               If omitted, uses the warm response body directly.
 */
async function warmAndBroadcast(channel, path, redisKey) {
  if (!UPSTASH_ENABLED) return;
  if (!RELAY_WARMER_API_KEY) return;
  try {
    const warmUrl = `${VERCEL_APP_URL}${path}`;
    if (!isAllowedWarmHost(warmUrl)) {
      console.error(`[relay-cron] VERCEL_APP_URL points to disallowed host: ${VERCEL_APP_URL}`);
      return;
    }

    const warmRes = await fetch(warmUrl, {
      headers: {
        'X-WorldMonitor-Key': RELAY_WARMER_API_KEY,
        'User-Agent': 'worldmonitor-relay-warmer/1.0',
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!warmRes.ok) {
      console.warn(`[relay-cron] warm failed ${channel}: ${warmRes.status}`);
      return;
    }

    let payload;

    if (redisKey) {
      const getRes = await fetch(
        `${UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(redisKey)}`,
        { headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` }, signal: AbortSignal.timeout(5_000) }
      );
      if (!getRes.ok) return;
      const { result } = await getRes.json();
      if (!result) return;
      try { payload = JSON.parse(result); } catch {
        console.warn(`[relay-cron] unparseable Redis value for ${channel}`);
        return;
      }
    } else {
      try { payload = await warmRes.json(); } catch {
        console.warn(`[relay-cron] unparseable response body for ${channel}`);
        return;
      }
    }

    broadcastToChannel(channel, payload);
    console.log(`[relay-cron] broadcast channel=${channel} subs=${channelSubscribers.get(channel)?.size ?? 0}`);
  } catch (err) {
    console.warn(`[relay-cron] warmAndBroadcast error (${channel}):`, err?.message ?? err);
  }
}

/**
 * Schedule a recurring warm-and-broadcast job.
 * @param {string} cronExpr  - node-cron expression, e.g. '*/5 * * * *'
 * @param {string} channel
 * @param {string} path
 * @param {string} [redisKey] - If omitted, uses warm response body directly
 */
function scheduleWarmAndBroadcast(cronExpr, channel, path, redisKey) {
  cron.schedule(cronExpr, () => {
    void warmAndBroadcast(channel, path, redisKey).catch(err =>
      console.error(`[relay-cron] unhandled error (${channel}):`, err)
    );
  });
  console.log(`[relay-cron] scheduled channel=${channel} (${cronExpr})`);
}
```

### Step 5: Register all cron jobs

Add this block immediately after `scheduleWarmAndBroadcast` is defined:

```javascript
// ── Register all warm-and-broadcast crons ───────────────────────────────────
// Stagger crons to avoid thundering herd when many fire at once.
//
// Key: when redisKey is provided, relay reads from Redis after warming.
//      When omitted (null), relay uses the warm response body directly —
//      needed for handlers with parameterized Redis keys.

// Every 5 min — market data (staggered: :00, :01, :02, :03)
scheduleWarmAndBroadcast('*/5 * * * *',     'markets',        '/api/market/v1/get-market-dashboard',       'market:dashboard:v1');
scheduleWarmAndBroadcast('1-59/5 * * * *',  'stablecoins',    '/api/market/v1/list-stablecoin-markets');  // parameterized key — use response body
scheduleWarmAndBroadcast('2-59/5 * * * *',  'etf-flows',      '/api/market/v1/list-etf-flows',            'market:etf-flows:v1');
scheduleWarmAndBroadcast('3-59/5 * * * *',  'macro-signals',  '/api/economic/v1/get-macro-signals',       'economic:macro-signals:v1');
scheduleWarmAndBroadcast('*/5 * * * *',     'strategic-risk', '/api/intelligence/v1/get-risk-scores');    // key: risk:scores:sebuf:v1 — use response body for reliability
scheduleWarmAndBroadcast('1-59/5 * * * *',  'predictions',    '/api/prediction/v1/list-prediction-markets'); // parameterized key

// Every 5 min — news digest (all variants)
scheduleWarmAndBroadcast('*/5 * * * *',     'news:full',    '/api/news/v1/list-feed-digest?variant=full&lang=en',    'news:digest:v1:full:en');
scheduleWarmAndBroadcast('1-59/5 * * * *',  'news:tech',    '/api/news/v1/list-feed-digest?variant=tech&lang=en',    'news:digest:v1:tech:en');
scheduleWarmAndBroadcast('2-59/5 * * * *',  'news:finance', '/api/news/v1/list-feed-digest?variant=finance&lang=en', 'news:digest:v1:finance:en');
scheduleWarmAndBroadcast('3-59/5 * * * *',  'news:happy',   '/api/news/v1/list-feed-digest?variant=happy&lang=en',   'news:digest:v1:happy:en');

// Every 10 min — intelligence / conflict / trade (staggered: :00, :01, :02, ...)
scheduleWarmAndBroadcast('*/10 * * * *',    'intelligence',      '/api/intelligence/v1/get-global-intel-digest', 'digest:global:v1');
scheduleWarmAndBroadcast('1-59/10 * * * *', 'trade',             '/api/trade/v1/get-trade-barriers');            // parameterized key
scheduleWarmAndBroadcast('2-59/10 * * * *', 'supply-chain',      '/api/supply-chain/v1/get-chokepoint-status',   'supply_chain:chokepoints:v1');
scheduleWarmAndBroadcast('3-59/10 * * * *', 'strategic-posture', '/api/military/v1/get-theater-posture');         // key: theater-posture:sebuf:v1 — use response body
scheduleWarmAndBroadcast('4-59/10 * * * *', 'pizzint',           '/api/intelligence/v1/get-pizzint-status');      // parameterized key
scheduleWarmAndBroadcast('5-59/10 * * * *', 'cyber',             '/api/cyber/v1/list-cyber-threats');             // parameterized key (v2)

// Every 5 min — service status (was 1 min polling, 5 min cron is acceptable)
scheduleWarmAndBroadcast('*/5 * * * *', 'service-status', '/api/infrastructure/v1/list-service-statuses', 'infra:service-statuses:v1');

// Every 15 min — cables
scheduleWarmAndBroadcast('*/15 * * * *', 'cables', '/api/infrastructure/v1/get-cable-health', 'cable-health-v1');

// Every 30 min — slower economic/energy data
scheduleWarmAndBroadcast('*/30 * * * *',    'fred',    '/api/economic/v1/get-fred-series');    // parameterized key
scheduleWarmAndBroadcast('1-59/30 * * * *', 'oil',     '/api/economic/v1/get-energy-prices');  // parameterized key
scheduleWarmAndBroadcast('2-59/30 * * * *', 'natural', '/api/wildfire/v1/list-fire-detections', 'wildfire:fires:v1');

// Every 60 min — BIS, flights, giving
scheduleWarmAndBroadcast('0 * * * *',  'bis',     '/api/economic/v1/get-bis-policy-rates', 'economic:bis:policy:v1');
scheduleWarmAndBroadcast('5 * * * *',  'flights', '/api/aviation/v1/list-airport-delays');  // multi-key handler — use response body
scheduleWarmAndBroadcast('10 * * * *', 'giving',  '/api/giving/v1/get-giving-summary',     'giving:summary:v1');

// Every 1 min — telegram intel (high-frequency, relay already has this data locally)
scheduleWarmAndBroadcast('* * * * *', 'telegram', '/api/telegram-feed?limit=50');

// Every 10 min — weather (relay fetches NWS on behalf of browser)
scheduleWarmAndBroadcast('*/10 * * * *', 'weather', '/api/weather/v1/get-alerts');  // needs server handler if none exists

// Every 30 min — spending (relay fetches USASpending on behalf of browser)
scheduleWarmAndBroadcast('*/30 * * * *', 'spending', '/api/spending/v1/get-spending-summary'); // needs server handler if none exists

// Every 5 min — AIS (relay already has AIS data, push snapshot directly)
// NOTE: AIS data is already on the relay. Instead of warming via Vercel,
// the relay should broadcast its own AIS snapshot directly. See broadcastAisSnapshot() below.
```

After the cron registrations, add AIS-specific broadcasting (the relay already has AIS data from its upstream connection):

```javascript
// ── AIS direct broadcast (relay already has this data) ──────────────────────
// The relay is the source of AIS data — no need to warm via Vercel.
// Broadcast current AIS snapshot to subscribers every 5 minutes.
cron.schedule('*/5 * * * *', () => {
  const snapshot = getAisSnapshot(); // use existing relay function that returns current vessel data
  if (snapshot) broadcastToChannel('ais', snapshot);
});

// Telegram: relay already has telegram data. If available locally, broadcast directly
// instead of calling the Vercel proxy endpoint. Remove the telegram cron above if so.
```

> **Redis key strategy:** Handlers with fixed Redis keys use the `redisKey` parameter to read from Redis after warming (more efficient — avoids double-parsing the response). Handlers with parameterized keys omit `redisKey`, causing `warmAndBroadcast` to use the warm response body directly. Check each handler's `cacheKey` const if adding new channels.
>
> **Note on weather and spending:** These currently call external APIs directly from the browser (`api.weather.gov`, `api.usaspending.gov`). To eliminate browser API calls, create server-side handlers (or use existing ones) so the relay can warm them. If server handlers don't exist yet, they need to be created as part of this work.

### Step 6: Run test

```bash
npm run test:data -- --test-name-pattern "relay cron contracts"
```

Expected: PASS

### Step 7: Commit

```bash
git add scripts/ais-relay.cjs tests/relay-cron-contracts.test.mjs package.json
git commit -m "feat(relay): add node-cron warm-and-broadcast jobs for all dashboard data channels"
```

---

## Task 3: Client relay-push service

New singleton that connects to the relay WebSocket, subscribes to channels, and dispatches typed payloads to registered handler functions.

**Files:**
- Create: `src/services/relay-push.ts`
- Create: `tests/relay-push-service.test.mjs`

### Step 1: Write failing test

```javascript
// tests/relay-push-service.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('relay-push service contract', () => {
  it('relay-push.ts exports subscribe and connect functions', () => {
    const src = readFileSync('src/services/relay-push.ts', 'utf8');
    assert.ok(src.includes('export function subscribe'), 'must export subscribe');
    assert.ok(src.includes('export function connect') || src.includes('export function initRelayPush'),
      'must export connect/init function');
  });

  it('relay-push.ts handles wm-push messages', () => {
    const src = readFileSync('src/services/relay-push.ts', 'utf8');
    assert.ok(src.includes("'wm-push'") || src.includes('"wm-push"'),
      'must handle wm-push message type');
  });

  it('relay-push.ts sends wm-subscribe on connect', () => {
    const src = readFileSync('src/services/relay-push.ts', 'utf8');
    assert.ok(src.includes("'wm-subscribe'") || src.includes('"wm-subscribe"'),
      'must send wm-subscribe on connect');
  });

  it('relay-push.ts implements reconnection with backoff', () => {
    const src = readFileSync('src/services/relay-push.ts', 'utf8');
    assert.ok(src.includes('reconnect') || src.includes('Reconnect'),
      'must implement reconnection');
  });
});
```

### Step 2: Run test to verify it fails

```bash
npm run test:data -- --test-name-pattern "relay-push service"
```

Expected: FAIL

### Step 3: Create `src/services/relay-push.ts`

```typescript
/**
 * Singleton WebSocket client that connects to the relay, subscribes to
 * typed data channels, and dispatches payloads to registered handler functions.
 */

type ChannelHandler = (payload: unknown) => void;

const handlers = new Map<string, Set<ChannelHandler>>();
let socket: WebSocket | null = null;
let subscribedChannels: string[] = [];
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelayMs = 2_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
let destroyed = false;

export function subscribe(channel: string, handler: ChannelHandler): () => void {
  if (!handlers.has(channel)) handlers.set(channel, new Set());
  handlers.get(channel)!.add(handler);
  return () => handlers.get(channel)?.delete(handler);
}

function dispatch(channel: string, payload: unknown): void {
  const channelHandlers = handlers.get(channel);
  if (!channelHandlers) return;
  for (const h of channelHandlers) {
    try {
      h(payload);
    } catch (err) {
      console.error(`[relay-push] handler error (${channel}):`, err);
    }
  }
}

function sendSubscribe(): void {
  if (!socket || socket.readyState !== WebSocket.OPEN || subscribedChannels.length === 0) return;
  socket.send(JSON.stringify({ type: 'wm-subscribe', channels: subscribedChannels }));
}

function scheduleReconnect(relayWsUrl: string): void {
  if (destroyed || reconnectTimer) return;
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!destroyed) connect(relayWsUrl, subscribedChannels);
  }, reconnectDelayMs);
}

function connect(relayWsUrl: string, channels: string[]): void {
  if (destroyed) return;
  subscribedChannels = channels;

  try {
    socket = new WebSocket(relayWsUrl);
  } catch {
    scheduleReconnect(relayWsUrl);
    return;
  }

  socket.addEventListener('open', () => {
    reconnectDelayMs = 2_000;
    console.log('[relay-push] connected, subscribing to', subscribedChannels);
    sendSubscribe();
  });

  socket.addEventListener('message', (event) => {
    const raw = typeof event.data === 'string' ? event.data : '';
    if (!raw) return;
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'wm-push' && typeof msg.channel === 'string') {
        dispatch(msg.channel, msg.payload);
      }
    } catch {
      console.warn('[relay-push] received unparseable message');
    }
  });

  socket.addEventListener('close', () => {
    socket = null;
    if (!destroyed) scheduleReconnect(relayWsUrl);
  });

  socket.addEventListener('error', () => {
    socket?.close();
  });
}

export function initRelayPush(channels: string[]): void {
  const relayWsUrl = import.meta.env.VITE_WS_RELAY_URL as string | undefined;
  if (!relayWsUrl) {
    console.warn('[relay-push] VITE_WS_RELAY_URL not set — push disabled, polling fallback active');
    return;
  }
  if (socket) return;
  destroyed = false;
  connect(relayWsUrl, channels);
}

export function destroyRelayPush(): void {
  destroyed = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  socket?.close();
  socket = null;
  handlers.clear();
}

export function isRelayConnected(): boolean {
  return socket?.readyState === WebSocket.OPEN;
}
```

### Step 4: Run test

```bash
npm run test:data -- --test-name-pattern "relay-push service"
```

Expected: PASS

### Step 5: Commit

```bash
git add src/services/relay-push.ts tests/relay-push-service.test.mjs
git commit -m "feat: add relay-push.ts WebSocket client for typed channel subscriptions"
```

---

## Task 4: Wire App.ts to relay push + remove RefreshScheduler for pushed channels

Connect on startup. For each pushed channel, subscribe a handler that calls the existing `dataLoader` update method with the pushed payload. Remove the corresponding `scheduleRefresh` / `registerAll` calls.

**Files:**
- Modify: `src/App.ts`
- Create: `tests/relay-push-wiring.test.mjs`

### Step 1: Write failing test

```javascript
// tests/relay-push-wiring.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('App.ts relay push wiring', () => {
  it('App.ts imports initRelayPush', () => {
    const src = readFileSync('src/App.ts', 'utf8');
    assert.ok(src.includes('initRelayPush'), 'App.ts must call initRelayPush');
  });

  it('App.ts imports subscribe from relay-push', () => {
    const src = readFileSync('src/App.ts', 'utf8');
    assert.ok(src.includes("from '@/services/relay-push'") || src.includes("from './services/relay-push'"),
      'App.ts must import from relay-push service');
  });

  it('App.ts does not use scheduleRefresh for any data channel', () => {
    const src = readFileSync('src/App.ts', 'utf8');
    const matches = src.match(/scheduleRefresh\(/g);
    assert.ok(
      !matches || matches.length === 0,
      `App.ts must not call scheduleRefresh — all data comes via relay push (found ${matches?.length ?? 0} calls)`
    );
  });

  it('App.ts does not call loadAllData for API fetches', () => {
    const src = readFileSync('src/App.ts', 'utf8');
    assert.ok(
      !src.includes('this.dataLoader.loadAllData()') || src.includes('// relay push handles data loading'),
      'loadAllData should be replaced by relay push'
    );
  });
});
```

### Step 2: Run test to verify it fails

```bash
npm run test:data -- --test-name-pattern "App.ts relay push wiring"
```

Expected: FAIL

### Step 3: Modify App.ts

**Add imports** at the top of `src/App.ts`:

```typescript
import { initRelayPush, subscribe as subscribeRelayPush, destroyRelayPush } from '@/services/relay-push';
```

**Add a new private method `setupRelayPush()`** in the `App` class (call it from `init()` after `setupRefreshIntervals()`):

```typescript
private setupRelayPush(): void {
  const variant = SITE_VARIANT || 'full';
  const channels = [
    `news:${variant}`,
    'markets',
    'predictions',
    'pizzint',
    'fred',
    'oil',
    'bis',
    'trade',
    'supply-chain',
    'intelligence',
    'stablecoins',
    'etf-flows',
    'macro-signals',
    'strategic-posture',
    'strategic-risk',
    'service-status',
    'cables',
    'natural',
    'cyber',
    'flights',
    'ais',
    'weather',
    'spending',
    'giving',
    'telegram',
  ];

  initRelayPush(channels);

  // Data loader channels
  subscribeRelayPush(`news:${variant}`, (payload) => { void this.dataLoader.applyNewsDigest(payload); });
  subscribeRelayPush('markets', (payload) => { void this.dataLoader.applyMarkets(payload); });
  subscribeRelayPush('predictions', (payload) => { void this.dataLoader.applyPredictions(payload); });
  subscribeRelayPush('fred', (payload) => { void this.dataLoader.applyFredData(payload); });
  subscribeRelayPush('oil', (payload) => { void this.dataLoader.applyOilData(payload); });
  subscribeRelayPush('bis', (payload) => { void this.dataLoader.applyBisData(payload); });
  subscribeRelayPush('intelligence', (payload) => { void this.dataLoader.applyIntelligence(payload); });
  subscribeRelayPush('pizzint', (payload) => { void this.dataLoader.applyPizzInt(payload); });
  subscribeRelayPush('trade', (payload) => { void this.dataLoader.applyTradePolicy(payload); });
  subscribeRelayPush('supply-chain', (payload) => { void this.dataLoader.applySupplyChain(payload); });
  subscribeRelayPush('natural', (payload) => { void this.dataLoader.applyNatural(payload); });
  subscribeRelayPush('cyber', (payload) => { void this.dataLoader.applyCyberThreats(payload); });
  subscribeRelayPush('cables', (payload) => { void this.dataLoader.applyCableHealth(payload); });
  subscribeRelayPush('flights', (payload) => { void this.dataLoader.applyFlightDelays(payload); });
  subscribeRelayPush('ais', (payload) => { void this.dataLoader.applyAisSignals(payload); });
  subscribeRelayPush('weather', (payload) => { void this.dataLoader.applyWeatherAlerts(payload); });
  subscribeRelayPush('spending', (payload) => { void this.dataLoader.applySpending(payload); });
  subscribeRelayPush('giving', (payload) => { void this.dataLoader.applyGiving(payload); });
  subscribeRelayPush('telegram', (payload) => { void this.dataLoader.applyTelegramIntel(payload); });

  // Panel-level push
  subscribeRelayPush('strategic-posture', (payload) => {
    (this.state.panels['strategic-posture'] as StrategicPosturePanel | undefined)?.applyPush(payload);
  });
  subscribeRelayPush('strategic-risk', (payload) => {
    (this.state.panels['strategic-risk'] as StrategicRiskPanel | undefined)?.applyPush(payload);
  });
  subscribeRelayPush('stablecoins', (payload) => {
    (this.state.panels['stablecoins'] as StablecoinPanel | undefined)?.applyPush(payload);
  });
  subscribeRelayPush('etf-flows', (payload) => {
    (this.state.panels['etf-flows'] as ETFFlowsPanel | undefined)?.applyPush(payload);
  });
  subscribeRelayPush('macro-signals', (payload) => {
    (this.state.panels['macro-signals'] as MacroSignalsPanel | undefined)?.applyPush(payload);
  });
  subscribeRelayPush('service-status', (payload) => {
    (this.state.panels['service-status'] as ServiceStatusPanel | undefined)?.applyPush(payload);
  });
}
```

**In `destroy()`**, add `destroyRelayPush();`

**Remove `setupRefreshIntervals()` entirely.** All data now comes from the relay push. The browser makes zero API calls — the relay handles all fetching and pushes data to connected clients.

Remove or gut `setupRefreshIntervals()` so it registers nothing:

```typescript
private setupRefreshIntervals(): void {
  // All data is now pushed by the relay. No browser-side polling.
}
```

Also update `loadAllData()` in `data-loader.ts` — it should no longer make API calls. Instead it becomes a no-op (or only handles non-API initialization like local state setup). The relay pushes cached payloads for all channels immediately on subscribe, so the browser gets data without any HTTP requests.

```typescript
public async loadAllData(): Promise<void> {
  // Data arrives via relay push on WebSocket connect.
  // No browser-side API calls needed.
}
```

### Step 4: Add `apply*` methods to DataLoaderManager

For each channel, `data-loader.ts` needs an `apply*` method that takes a raw pushed payload, validates it, and updates app state — exactly like the tail end of each existing `load*` method.

Example for markets (in `src/app/data-loader.ts`):

```typescript
/** Called by relay-push when a market payload is received via WS. */
public async applyMarkets(rawPayload: unknown): Promise<void> {
  if (!rawPayload || typeof rawPayload !== 'object') return;
  // Reuse the existing state-update logic from loadMarkets()
  // Extract it into a private applyMarketPayload(data) helper and call from both
  this.applyMarketPayload(rawPayload as GetMarketDashboardResponse);
}
```

The pattern for each: extract the "apply state from data" section of each `load*` method into a private `applyXxxPayload(data)` helper, then call that helper from both the existing `load*` method and the new public `applyXxx(rawPayload)` method.

Panel-level `applyPush` methods: each of these panels needs `applyPush(payload: unknown)` that skips the fetch and goes directly to the render step:
- `StablecoinPanel` (has `fetchData()`)
- `ETFFlowsPanel` (has `fetchData()`)
- `ServiceStatusPanel` (has `fetchStatus()`)
- `StrategicPosturePanel` (has `fetchAndRender()`)
- `StrategicRiskPanel` (has `refresh()`)
- `MacroSignalsPanel` (has `fetchData()` via `refresh()`)

### Step 5: Run TypeScript typecheck

```bash
npm run typecheck
```

Fix any type errors before committing.

### Step 6: Run tests

```bash
npm run test:data -- --test-name-pattern "App.ts relay push wiring"
```

Expected: PASS

### Step 7: Commit

```bash
git add src/App.ts src/app/data-loader.ts src/services/relay-push.ts tests/relay-push-wiring.test.mjs
git commit -m "feat: wire App.ts to relay push channels — panels now update via WS push, polling is hourly fallback only"
```

---

## Task 5: Verify Redis key names match (integration check)

The relay cron uses hardcoded Redis key names. These must match exactly what `cachedFetchJson` writes in each server handler.

**Files:**
- Create: `tests/relay-redis-key-contracts.test.mjs`

### Step 1: Write the test

This test reads each server handler file and verifies the Redis key pattern matches what the relay cron assumes.

```javascript
// tests/relay-redis-key-contracts.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Map: relay-assumed key prefix → server handler file → expected key fragment in that file
const KEY_CONTRACTS = [
  { relayKey: 'news:digest:v1:full:en',      file: 'server/worldmonitor/news/v1/list-feed-digest.ts',         fragment: 'news:digest:v1' },
  { relayKey: 'market:dashboard:v1',          file: 'server/worldmonitor/market/v1/get-market-dashboard.ts',   fragment: 'market:dashboard:v1' },
  { relayKey: 'economic:macro-signals:v1',    file: 'server/worldmonitor/economic/v1/get-macro-signals.ts',    fragment: 'economic:macro-signals:v1' },
  { relayKey: 'market:etf-flows:v1',          file: 'server/worldmonitor/market/v1/list-etf-flows.ts',        fragment: 'market:etf-flows:v1' },
  { relayKey: 'supply_chain:chokepoints:v1',  file: 'server/worldmonitor/supply-chain/v1/get-chokepoint-status.ts', fragment: 'supply_chain:chokepoints:v1' },
  { relayKey: 'digest:global:v1',             file: 'server/worldmonitor/intelligence/v1/get-global-intel-digest.ts', fragment: 'digest:global:v1' },
  { relayKey: 'infra:service-statuses:v1',    file: 'server/worldmonitor/infrastructure/v1/list-service-statuses.ts', fragment: 'infra:service-statuses:v1' },
  { relayKey: 'cable-health-v1',              file: 'server/worldmonitor/infrastructure/v1/get-cable-health.ts',     fragment: 'cable-health-v1' },
  { relayKey: 'economic:bis:policy:v1',       file: 'server/worldmonitor/economic/v1/get-bis-policy-rates.ts',      fragment: 'economic:bis:policy:v1' },
  { relayKey: 'wildfire:fires:v1',            file: 'server/worldmonitor/wildfire/v1/list-fire-detections.ts',      fragment: 'wildfire:fires:v1' },
];

describe('relay Redis key contracts', () => {
  for (const { relayKey, file, fragment } of KEY_CONTRACTS) {
    it(`handler ${file} uses key fragment matching relay assumption "${relayKey}"`, () => {
      const src = readFileSync(file, 'utf8');
      assert.ok(
        src.includes(fragment),
        `${file} must contain "${fragment}" (relay uses key "${relayKey}")`
      );
    });
  }
});
```

### Step 2: Run test and check actual Redis keys in each handler

```bash
npm run test:data -- --test-name-pattern "relay Redis key contracts"
```

For any failing key, open the server handler and find the actual `cacheKey` / `redisKey` constant. Update `scripts/ais-relay.cjs` cron registration to use the correct key, and update the test's `fragment` value.

### Step 3: Commit

```bash
git add tests/relay-redis-key-contracts.test.mjs scripts/ais-relay.cjs
git commit -m "test: add relay Redis key contract tests and correct any key mismatches"
```

---

## Task 6: Deploy relay update and smoke test

**Files:**
- Modify: `scripts/update-relay.sh` (add npm install step)

### Step 1: Add npm install to update-relay.sh

Find the `# ── 2. Pull latest code ──` section and after `git pull`, add:

```bash
log "Installing/updating dependencies..."
npm install --omit=dev || warn "npm install failed — relay may be missing node-cron"
```

### Step 1b: Add RELAY_WARMER_API_KEY to env

Ensure the relay host has `RELAY_WARMER_API_KEY` set (can be the same value as `RELAY_SHARED_SECRET`). Add to `.env.example`:

```
RELAY_WARMER_API_KEY=          # API key for relay→Vercel warm requests (X-WorldMonitor-Key header)
```

### Step 2: Deploy to relay host

```bash
bash scripts/update-relay.sh
```

Verify pm2 restarts cleanly:
```bash
pm2 logs worldmonitor-relay --lines 50
```

Expected log lines:
```
[relay-cron] scheduled channel=markets (*/5 * * * *)
[relay-cron] scheduled channel=news:full (*/5 * * * *)
...
[Relay] Heap limit: ...MB
```

### Step 3: End-to-end smoke test

Open the app in a browser, open DevTools → Network → WS tab.
- Verify a WebSocket connection to `wss://relay.5ls.us` is established.
- Verify the client sends `{type: "wm-subscribe", channels: [...]}` on connect.
- Verify cached payloads arrive immediately (no waiting for next cron tick).
- Verify the Network tab shows **zero** `/api/*` requests after the WebSocket connects (except one-time bootstrap/config calls if kept).
- Wait 5 minutes. Verify `{type: "wm-push", channel: "markets", ...}` arrives.

### Step 4: Commit

```bash
git add scripts/update-relay.sh
git commit -m "ops: add npm install step to relay deploy script for node-cron dependency"
```

---

## Task 7: Frontend wiring and cleanup (zero browser API calls)

With all data arriving via relay push, the browser no longer needs to make API calls. This task covers all the frontend changes: gutting `loadAllData`, removing `RefreshScheduler`, cleaning up panels, removing circuit breakers, and eliminating dead code.

**Files to modify:**
- `src/App.ts`
- `src/app/data-loader.ts`
- `src/app/refresh-scheduler.ts`
- `src/app/event-handlers.ts`
- `src/components/StablecoinPanel.ts`
- `src/components/ETFFlowsPanel.ts`
- `src/components/ServiceStatusPanel.ts`
- `src/components/StrategicPosturePanel.ts`
- `src/components/StrategicRiskPanel.ts`
- `src/components/MacroSignalsPanel.ts`
- `src/components/GulfEconomiesPanel.ts`
- `src/components/GlobalDigestPanel.ts`
- `src/components/TechEventsPanel.ts`
- `src/components/TelegramIntelPanel.ts`
- `src/utils/circuit-breaker.ts`

**Files to create:**
- `tests/zero-browser-api-calls.test.mjs`

### Step 1: Write failing test

```javascript
// tests/zero-browser-api-calls.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('zero browser API calls', () => {
  it('data-loader.ts does not contain fetch() calls', () => {
    const src = readFileSync('src/app/data-loader.ts', 'utf8');
    const fetchCalls = (src.match(/\bfetch\(/g) || []).length;
    assert.ok(fetchCalls === 0, `data-loader.ts still has ${fetchCalls} fetch() calls — all data should come via relay push`);
  });

  it('App.ts does not import RefreshScheduler', () => {
    const src = readFileSync('src/App.ts', 'utf8');
    assert.ok(!src.includes('RefreshScheduler'), 'App.ts must not use RefreshScheduler — relay push handles all data');
  });

  it('App.ts does not call scheduleRefresh', () => {
    const src = readFileSync('src/App.ts', 'utf8');
    assert.ok(!src.includes('scheduleRefresh'), 'No scheduleRefresh calls should exist');
  });

  it('no panel makes its own fetch call', () => {
    const panels = [
      'src/components/StablecoinPanel.ts',
      'src/components/ETFFlowsPanel.ts',
      'src/components/MacroSignalsPanel.ts',
      'src/components/ServiceStatusPanel.ts',
    ];
    for (const file of panels) {
      const src = readFileSync(file, 'utf8');
      assert.ok(!src.includes('ServiceClient'), `${file} should not use a ServiceClient — data arrives via relay push`);
    }
  });
});
```

### Step 2: Gut `loadAllData()` in data-loader.ts

The existing `loadAllData()` calls ~30 `load*` methods that make HTTP requests. Replace it with a no-op. Data now arrives via `apply*` methods called by relay push handlers.

```typescript
public async loadAllData(): Promise<void> {
  // All data arrives via relay push. No browser API calls needed.
  // The relay sends cached payloads on WebSocket connect.
}
```

Keep the `load*` methods as-is for now (they can be removed in a follow-up), but they won't be called by anything.

### Step 3: Extract `apply*` methods from each `load*` method

For every `load*` method in data-loader.ts, extract the state-update / render portion into a public `apply*` method. The pattern:

```typescript
// BEFORE (loadMarkets makes an API call and updates state):
public async loadMarkets(): Promise<void> {
  const data = await fetchMarketDashboard();
  this.ctx.latestMarkets = data;
  this.renderMarkets(data);
}

// AFTER (split into fetch + apply):
public async loadMarkets(): Promise<void> {
  const data = await fetchMarketDashboard();
  this.applyMarkets(data);
}

public applyMarkets(data: unknown): void {
  if (!data || typeof data !== 'object') return;
  this.ctx.latestMarkets = data as MarketDashboard;
  this.renderMarkets(data as MarketDashboard);
}
```

Apply this pattern to all methods. Full list of `apply*` methods needed:

| apply method | Extracts from | State it updates |
|---|---|---|
| `applyNewsDigest` | `loadNews` / `tryFetchDigest` | `lastGoodDigest`, newsByCategory, allNews, panels |
| `applyMarkets` | `loadMarkets` | `ctx.latestMarkets`, market panels |
| `applyPredictions` | `loadPredictions` | `ctx.latestPredictions`, PredictionPanel |
| `applyFredData` | `loadFredData` | EconomicPanel |
| `applyOilData` | `loadOilAnalytics` | EconomicPanel |
| `applyBisData` | `loadBisData` | EconomicPanel |
| `applyIntelligence` | `loadIntelligenceSignals` | intelligenceCache, map, panels |
| `applyPizzInt` | `loadPizzInt` | pizzintIndicator, statusPanel |
| `applyTradePolicy` | `loadTradePolicy` | TradePolicyPanel |
| `applySupplyChain` | `loadSupplyChain` | SupplyChainPanel |
| `applyNatural` | `loadFirmsData` + `loadNatural` | map, SatelliteFiresPanel |
| `applyCyberThreats` | `loadCyberThreats` | map, CIIPanel |
| `applyCableHealth` | `loadCableHealth` | map |
| `applyFlightDelays` | `loadFlightDelays` | map |
| `applyAisSignals` | `loadAisSignals` | map, CIIPanel |
| `applyWeatherAlerts` | `loadWeatherAlerts` | map, statusPanel |
| `applySpending` | `loadGovernmentSpending` | EconomicPanel |
| `applyGiving` | `loadGiving` | GivingPanel |
| `applyTelegramIntel` | `loadTelegramIntel` | TelegramIntelPanel |

### Step 4: Add `applyPush()` to panels that fetch their own data

These panels currently make their own API calls via generated ServiceClients. Each needs an `applyPush(payload: unknown)` method that skips the fetch and goes directly to render:

**StablecoinPanel** (`src/components/StablecoinPanel.ts`):
```typescript
public applyPush(payload: unknown): void {
  if (!payload || typeof payload !== 'object') return;
  // Same render logic as the tail end of fetchData(), skipping the MarketServiceClient call
  this.renderStablecoins(payload as ListStablecoinMarketsResponse);
}
```

Apply the same pattern to:
- **ETFFlowsPanel** — `applyPush` skips `MarketServiceClient.listEtfFlows`, calls render directly
- **MacroSignalsPanel** — `applyPush` skips `EconomicServiceClient.getMacroSignals`, calls render
- **ServiceStatusPanel** — `applyPush` skips `fetchServiceStatuses()`, calls render
- **StrategicPosturePanel** — `applyPush` skips `fetchCachedTheaterPosture`, calls render
- **StrategicRiskPanel** — `applyPush` skips risk score fetch, calls render

Also handle panels NOT in the original plan that make their own fetches:
- **GulfEconomiesPanel** — has its own `setInterval(60s)` calling `MarketServiceClient.listGulfQuotes`. Add to relay push channels (`gulf-quotes`), add `applyPush`, remove the `setInterval`.
- **GlobalDigestPanel** — calls `IntelligenceServiceClient.getGlobalIntelDigest`. Already pushed via `intelligence` channel — wire `applyPush` to receive from that channel.
- **TechEventsPanel** — calls `ResearchServiceClient.listTechEvents`. Add `tech-events` channel to relay, add `applyPush`.
- **TelegramIntelPanel** — calls `fetchTelegramFeed`. Already pushed via `telegram` channel — wire `applyPush`.

### Step 5: Remove RefreshScheduler from App.ts

1. Remove the `RefreshScheduler` import and instantiation from `App.ts`
2. Remove `setupRefreshIntervals()` method entirely
3. Remove `this.refreshScheduler` property
4. Remove `flushStaleRefreshes` and `setHiddenSince` callbacks from `EventHandlers`

In `EventHandlers` (or wherever visibility change is handled), replace the stale-refresh flush with a relay reconnect check:

```typescript
// On tab becoming visible — instead of flushing stale polls, ensure relay WS is connected
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (!isRelayConnected()) {
      initRelayPush(subscribedChannels);
    }
  }
});
```

### Step 6: Remove circuit breakers from browser

The `CircuitBreaker` in `src/utils/circuit-breaker.ts` wraps browser API calls with retry/backoff logic. With relay push, the browser doesn't make API calls, so circuit breakers are unnecessary.

- Remove `CircuitBreaker` usage from services (`weather.ts`, `gdacs.ts`, `infrastructure/index.ts`, `market/index.ts`, etc.)
- Remove `getCircuitBreakerCooldownInfo` calls from `data-loader.ts`
- Remove `digestBreaker` from `data-loader.ts`
- Keep the `circuit-breaker.ts` file for now (may be useful server-side later), but remove all browser-side imports

### Step 7: Remove direct external API calls

These files call external APIs directly from the browser. Move the fetch to server-side handlers so the relay can warm them:

| File | External API | Action |
|---|---|---|
| `src/services/weather.ts` | `api.weather.gov` | Create `/api/weather/v1/get-alerts` server handler; remove browser fetch |
| `src/services/usa-spending.ts` | `api.usaspending.gov` | Create `/api/spending/v1/get-spending-summary` server handler; remove browser fetch |
| `src/services/eonet.ts` | `eonet.gsfc.nasa.gov` | Create `/api/natural-events/v1/list-events` server handler; remove browser fetch |
| `src/services/gdacs.ts` | `gdacs.org` | Create `/api/natural-events/v1/list-disasters` server handler; remove browser fetch |

### Step 8: Handle remaining browser API calls

These `/api/*` calls from the browser also need to be eliminated:

| Call | File | Action |
|---|---|---|
| `/api/bootstrap` | `src/services/bootstrap.ts` | **Remove.** Bootstrap batches Redis reads for initial hydration — redundant now that `sendCachedPayloads` pushes all cached channel data on WS connect. Keep IndexedDB stale cache for first-ever-visit cold start. |
| `/api/config/news-sources` | `src/services/feed-client.ts` | **Move to relay push.** Add `config:news-sources` channel. Relay warms `/api/config/news-sources` every 5 min. |
| `/api/config/feature-flags` | `src/services/feature-flag-client.ts` | **Move to relay push.** Add `config:feature-flags` channel. Relay warms `/api/config/feature-flags` every 5 min. |
| `/api/rss-proxy?url=...` | `src/services/feed-client.ts`, `security-advisories.ts` | Move RSS fetching to relay cron |
| `/api/oref-alerts` | `src/services/oref-alerts.ts` | Add `oref` channel to relay push |
| `/api/conflict/v1/list-iran-events` | `src/services/conflict/index.ts` | Add `iran-events` channel to relay push |
| `/api/gpsjam` | `src/services/gps-interference.ts` | Add `gps-interference` channel to relay push |
| `/api/opensky` | `src/services/military-flights.ts` | Already handled by AIS/military relay data |

**Bootstrap removal strategy:**

The current bootstrap flow is:
1. Load stale data from IndexedDB (instant, no network)
2. Fetch `/api/bootstrap` to get fresh data (3s timeout)
3. Write fresh data to `hydrationCache` and IndexedDB

With relay push, the flow becomes:
1. Load stale data from IndexedDB (instant, no network) — **keep this for cold start**
2. WebSocket connects to relay → relay sends cached payloads for all subscribed channels → **replaces bootstrap fetch**
3. Write fresh pushed data to IndexedDB for next visit

The `hydrationCache` helpers (`getHydratedData`, `getHydratedNewsSources`, `getHydratedFeatureFlags`) remain but are populated by relay push instead of the bootstrap API call. Update `src/services/bootstrap.ts`:

```typescript
// BEFORE: fetches /api/bootstrap and populates hydrationCache
export async function fetchBootstrapData(variant: string): Promise<void> {
  // ... fetch /api/bootstrap, write to hydrationCache, persist to IndexedDB
}

// AFTER: loads stale IndexedDB data only. Fresh data arrives via relay push.
export async function loadCachedBootstrapData(): Promise<void> {
  const stale = await loadFromIndexedDB();
  if (stale) {
    for (const [key, value] of Object.entries(stale)) {
      hydrationCache.set(key, value);
    }
  }
}
```

In `App.init()`, replace `await fetchBootstrapData(variant)` with `await loadCachedBootstrapData()`. The relay push `apply*` handlers update `hydrationCache` and persist to IndexedDB as fresh data arrives.

**Config channels** — add to relay cron (Task 2) and ALLOWED_CHANNELS (Task 1):

```javascript
// Every 5 min — config (matches Redis TTL)
scheduleWarmAndBroadcast('*/5 * * * *', 'config:news-sources',  '/api/config/news-sources?variant=full');
scheduleWarmAndBroadcast('*/5 * * * *', 'config:feature-flags', '/api/config/feature-flags');
```

Client-side wiring in `setupRelayPush()`:

```typescript
subscribeRelayPush('config:news-sources', (payload) => {
  applyNewsSources(payload);
  persistToIndexedDB('newsSources', payload);
});
subscribeRelayPush('config:feature-flags', (payload) => {
  applyFeatureFlags(payload);
  persistToIndexedDB('featureFlags', payload);
});
```

**Sequencing:** `loadNewsSources()` in `feed-client.ts` currently checks `getHydratedNewsSources()` first. With relay push, sources arrive via WS. The `sourcesReady` promise (awaited in `loadNews` with 3s cap) should resolve when the relay pushes `config:news-sources`. Update `feed-client.ts` to resolve `sourcesReady` from either hydration cache (stale) or relay push (fresh), whichever comes first.

### Step 9: Clean up dead imports

After all changes, remove unused imports:

**App.ts:**
- Remove `RefreshScheduler` import
- Remove `REFRESH_INTERVALS` from `@/config` (if no other consumers)

**data-loader.ts:**
- Remove all `fetch*` imports from `@/services/*`
- Remove `ResearchServiceClient` direct import
- Remove `getCircuitBreakerCooldownInfo`
- Remove `CircuitBreaker`-related imports
- Remove unused type imports (`ListFeedDigestResponse`, etc.) that are only used in load methods

**Panel files:**
- Remove `*ServiceClient` imports from panels that now use `applyPush`
- Remove fetch/retry helper imports

### Step 10: Update loading/error state for push model

The current `ctx.inFlight` Set tracks which `load*` tasks are running. With push, this is no longer meaningful. Replace with a connection-state model:

```typescript
// Replace inFlight tracking with relay connection state
export type RelayState = 'connecting' | 'connected' | 'disconnected';

// In App state:
relayState: RelayState;
lastPushReceived: Map<string, number>; // channel → timestamp
```

Update panels to show "Connecting..." instead of per-channel loading spinners on initial load, and show the pushed data as soon as it arrives.

`dataFreshness` can be updated by `apply*` methods calling `recordUpdate()` when push data arrives.

### Step 11: Run typecheck and tests

```bash
npm run typecheck
npm run test:data
npm run build
```

Fix any type errors or test failures.

### Step 12: Commit

```bash
git add src/App.ts src/app/data-loader.ts src/app/refresh-scheduler.ts \
  src/app/event-handlers.ts src/components/*.ts src/services/*.ts \
  src/utils/circuit-breaker.ts tests/zero-browser-api-calls.test.mjs
git commit -m "feat: complete frontend cleanup — zero browser API calls, all data via relay push"
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

Run build:

```bash
npm run build
```

Expected: all pass, no type errors, no build errors.

### Success metrics

- [ ] Browser DevTools Network tab shows **zero HTTP requests** to `/api/*` after initial page load
- [ ] Browser DevTools Network tab shows **zero HTTP requests** to `api.weather.gov` or `api.usaspending.gov`
- [ ] Browser DevTools WS shows `wm-push` messages arriving for all channels
- [ ] On connect, browser immediately receives cached payloads for all subscribed channels (no waiting for next cron tick)
- [ ] Page refreshes instantly when relay pushes new data (< 100ms latency from relay cron fire to UI update)
- [ ] All 4 news variant channels push correctly
- [ ] AIS, telegram, weather, spending, giving data all arrive via WS push

---

## Review Findings (2026-03-05)

This plan was reviewed against Supabase Postgres best practices, Vercel React best practices, security best practices, and code slop guidelines. All corrections have been applied inline above. Summary of changes made:

### Status correction (repo reality check)

The summary below describes the intended end-state of this plan, not the current repository state. As of the latest review, these items are still not implemented in code yet:

- `scripts/ais-relay.cjs` still uses untyped WS fanout, has no per-channel `wm-subscribe`/`wm-push`, and keeps `MAX_WS_CLIENTS = 10`
- `src/services/relay-push.ts` does not exist yet
- `src/App.ts` still uses `RefreshScheduler`, `setupRefreshIntervals()`, and `fetchBootstrapData()` + `loadAllData()`
- `src/app/data-loader.ts` still performs direct fetch/load orchestration and retains browser-side circuit-breaker usage

Treat this section as implementation intent; use the task list below as the source of truth for what must still change.

### Critical Fixes Applied

1. **All 20 API paths corrected** — Changed from gRPC-style (`/api/worldmonitor.market.v1.MarketService/...`) to actual REST-style (`/api/market/v1/...`)
2. **All 17 Redis key mismatches corrected** — Fixed keys to match actual handler `cacheKey` constants. Added response-body fallback for parameterized handlers.
3. **Missing channels added** — `flights`, `ais`, `weather`, `spending`, `giving`, `telegram` all added to relay push
4. **Missing `MacroSignalsPanel`** — Added to panel `applyPush` list and wiring
5. **Zero browser API calls** — Removed all fallback polling and `loadAllData()`. All data arrives via relay push.
6. **Initial data on connect** — Added `latestPayloads` cache and `sendCachedPayloads()` so new subscribers get data immediately without waiting for next cron tick

### Security Hardening Applied

6. **Channel allowlist** — Added `ALLOWED_CHANNELS` Set; reject unknown channel subscriptions
7. **Channel name regex** — `/^[a-z0-9:_-]{1,63}$/` validation
8. **Per-client rate limiting** — 20 subscribe messages per 5s window
9. **Per-client subscription cap** — Max 50 channels per client
10. **Incoming message size limit** — 64KB max before `JSON.parse`
11. **Broadcast payload size cap** — 512KB max per broadcast message
12. **`verifyClient` on WS upgrade** — Reject unauthorized origins at upgrade time
13. **SSRF protection** — `isAllowedWarmHost()` validates `VERCEL_APP_URL` against allowlist
14. **API key fail-fast** — Error on startup if `RELAY_WARMER_API_KEY` missing when warm-and-broadcast is enabled
15. **Dedicated env var** — `RELAY_WARMER_API_KEY` instead of ambiguous `API_KEY`

### Code Quality (Deslop) Fixes

16. **Removed `event.data as string` cast** — Replaced with safe `typeof` check
17. **Replaced `forEach` with `for...of`** — In dispatch function for cleaner error handling
18. **Removed silent error swallowing** — Added `console.warn` for unparseable messages/Redis data
19. **Removed narrating comments** — e.g. `// NEW: clean up channel subscriptions`
20. **Staggered cron schedules** — Offset by 1-5 minutes to avoid thundering herd

### Items Not Changed (Acceptable As-Is)

- String-based contract tests (reading source files) — acceptable for contract verification, plan should add integration tests later
- Module-level mutable singletons in `relay-push.ts` — fine for browser-only singleton pattern
- No Supabase Postgres changes needed — plan doesn't involve database queries

### Remaining Items for Implementation

**Relay-side (Task 2 additions):**
- [ ] Add relay push channels: `gulf-quotes`, `tech-events`, `oref`, `iran-events`, `gps-interference`, `eonet`, `gdacs`
- [ ] Add cron entries for each new channel
- [ ] Add them to `ALLOWED_CHANNELS`
- [ ] Add `RELAY_WARMER_API_KEY` to `.env.example`
- [ ] Create server-side handlers: `/api/weather/v1/get-alerts`, `/api/spending/v1/get-spending-summary`, `/api/natural-events/v1/list-events` (EONET), `/api/natural-events/v1/list-disasters` (GDACS)
- [ ] Verify exact query params used by dashboard for parameterized handlers (cyber, fred, energy, stablecoins, predictions, trade, pizzint) so warm calls produce predictable results

**App callback contract migration (Task 7b):**
- [ ] Update `EventHandlerCallbacks` and call sites to remove polling-era contracts (`flushStaleRefreshes`, `setHiddenSince`) or replace them with relay connection/reconnect callbacks
- [ ] Replace visibility-change stale-poll flush behavior with relay reconnect/health-check behavior
- [ ] Replace playback exit path (`callbacks.loadAllData()`) with relay re-sync behavior (reconnect + cached payload replay)
- [ ] Replace layer-toggle load path (`callbacks.loadDataForLayer`) with relay subscribe/unsubscribe or re-subscribe behavior
- [ ] Remove `RefreshScheduler` from module wiring in `src/App.ts` and callback injection setup

**Frontend cleanup (Task 7):**
- [ ] Extract `apply*` methods from all ~19 `load*` methods in data-loader.ts
- [ ] Add `applyPush()` to 10 panel classes (Stablecoin, ETFFlows, ServiceStatus, StrategicPosture, StrategicRisk, MacroSignals, GulfEconomies, GlobalDigest, TechEvents, TelegramIntel)
- [ ] Remove `RefreshScheduler` from App.ts entirely
- [ ] Gut `loadAllData()` to a no-op
- [ ] Remove `setupRefreshIntervals()` method
- [ ] Remove GulfEconomiesPanel's own `setInterval(60s)`
- [ ] Remove circuit breaker usage from all browser services
- [ ] Remove direct external API calls (weather.gov, usaspending.gov, eonet, gdacs) from browser code
- [ ] Remove remaining `/api/*` browser calls (oref-alerts, gpsjam, iran-events, telegram-feed, opensky, rss-proxy)
- [ ] Remove `/api/bootstrap` fetch — replace with IndexedDB-only stale load + relay push for fresh data
- [ ] Move `/api/config/news-sources` and `/api/config/feature-flags` to relay push channels
- [ ] Update `feed-client.ts` `sourcesReady` to resolve from hydration cache or relay push
- [ ] Update `bootstrap.ts` — replace `fetchBootstrapData()` with `loadCachedBootstrapData()` (IndexedDB only)
- [ ] Wire `apply*` handlers to persist pushed data to IndexedDB for next-visit cold start
- [ ] Clean up dead imports in App.ts, data-loader.ts, and panel files
- [ ] Replace `ctx.inFlight` loading state with relay connection state model
- [ ] Update visibility-change handler to reconnect relay instead of flushing stale polls

**Push-state bootstrap + hydration integration (Task 7c):**
- [ ] Add explicit bootstrap/hydration APIs for push updates (not only initial stale read), so pushed payloads can update hydration cache consistently
- [ ] Ensure push handlers write updated channel payloads to IndexedDB for next-visit cold start, with bounded staleness TTLs
- [ ] Ensure `loadNewsSources()` and `loadFeatureFlags()` can resolve from either stale hydration cache or relay push delivery without blocking app init
- [ ] Add tests that verify hydration cache and IndexedDB are updated by push handlers

**Summarize View failure investigation + fix (Task 8):**
- [ ] Verify `/api/intelligence/v1/summarize-view` response body when UI shows `Could not generate summary. Please try again.` (distinguish HTTP error vs empty `summary`)
- [ ] Validate LLM dependencies used by `server/worldmonitor/intelligence/v1/summarize-view.ts`:
  - [ ] Active provider resolves from `get_active_llm_provider`
  - [ ] Provider secret resolves via `getSecret(api_key_secret_name)`
  - [ ] Prompt key `view_summary` resolves via `get_llm_prompt('view_summary', null, null, model)`
- [ ] Confirm migrations that seed `view_summary` prompts are applied in the active environment (not just present in repo), especially `20260304000004_update_llm_prompts_model_aware.sql`
- [ ] Add server-side structured error logging for summarize-view failures:
  - include failure stage (`provider_missing`, `prompt_missing`, `upstream_http_error`, `empty_model_output`, `timeout`)
  - include HTTP status for upstream LLM calls
  - do not log prompt contents or secrets
- [ ] Return structured error metadata from summarize-view endpoint when summary generation fails (e.g. `{ errorCode, provider, model }`) so frontend can show actionable message
- [ ] Update `setupSummarizeView()` UI error handling:
  - show specific guidance for configuration issues (provider/prompt missing)
  - show retry guidance for transient network/timeout failures
- [ ] Add browser-side console diagnostics in summarize-view UI flow:
  - log request lifecycle (`request_started`, `response_received`, `response_parse_failed`)
  - log non-OK HTTP status + correlation metadata (without logging panel snapshot contents)
  - log empty-summary responses with returned backend `errorCode`/`provider`/`model` context
- [ ] Add automated tests:
  - unit tests for `summarize-view.ts` covering each failure branch
  - UI test for modal message mapping from backend `errorCode`

**Infrastructure:**
- [ ] Consider per-IP connection limits on the relay (currently only total `MAX_WS_CLIENTS`)
- [ ] Consider restricting `/health` endpoint by IP in production
