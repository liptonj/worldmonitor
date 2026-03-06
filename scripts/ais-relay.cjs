#!/usr/bin/env node
/**
 * AIS WebSocket Relay Server
 * Proxies aisstream.io data to browsers via WebSocket
 *
 * Deploy on Railway with:
 *   AISSTREAM_API_KEY=your_key
 *
 * Local: node scripts/ais-relay.cjs
 */

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const path = require('path');
const { readFileSync } = require('fs');
const crypto = require('crypto');
const v8 = require('v8');
const { WebSocketServer, WebSocket } = require('ws');
const cron = require('node-cron');
const Redis = require('ioredis');
const { createClient: createSupabaseClient } = require('@supabase/supabase-js');

// Log effective heap limit at startup (verifies NODE_OPTIONS=--max-old-space-size is active)
const _heapStats = v8.getHeapStatistics();
console.log(`[Relay] Heap limit: ${(_heapStats.heap_size_limit / 1024 / 1024).toFixed(0)}MB`);

const AISSTREAM_URL = 'wss://stream.aisstream.io/v0/stream';
const API_KEY = process.env.AISSTREAM_API_KEY || process.env.VITE_AISSTREAM_API_KEY;
const PORT = process.env.PORT || 3004;

if (!API_KEY) {
  console.error('[Relay] Error: AISSTREAM_API_KEY environment variable not set');
  console.error('[Relay] Get a free key at https://aisstream.io');
  process.exit(1);
}

const MAX_WS_CLIENTS = 200; // Cap WS clients — push model replaces polling
const UPSTREAM_QUEUE_HIGH_WATER = Math.max(500, Number(process.env.AIS_UPSTREAM_QUEUE_HIGH_WATER || 4000));
const UPSTREAM_QUEUE_LOW_WATER = Math.max(
  100,
  Math.min(UPSTREAM_QUEUE_HIGH_WATER - 1, Number(process.env.AIS_UPSTREAM_QUEUE_LOW_WATER || 1000))
);
const UPSTREAM_QUEUE_HARD_CAP = Math.max(
  UPSTREAM_QUEUE_HIGH_WATER + 1,
  Number(process.env.AIS_UPSTREAM_QUEUE_HARD_CAP || 8000)
);
const UPSTREAM_DRAIN_BATCH = Math.max(1, Number(process.env.AIS_UPSTREAM_DRAIN_BATCH || 250));
const UPSTREAM_DRAIN_BUDGET_MS = Math.max(2, Number(process.env.AIS_UPSTREAM_DRAIN_BUDGET_MS || 20));
function safeInt(envVal, fallback, min) {
  if (envVal == null || envVal === '') return fallback;
  const n = Number(envVal);
  return Number.isFinite(n) ? Math.max(min, Math.floor(n)) : fallback;
}
const MAX_VESSELS = safeInt(process.env.AIS_MAX_VESSELS, 20000, 1000);
const MAX_VESSEL_HISTORY = safeInt(process.env.AIS_MAX_VESSEL_HISTORY, 20000, 1000);
const MAX_DENSITY_CELLS = 5000;
const MEMORY_CLEANUP_THRESHOLD_GB = (() => {
  const n = Number(process.env.RELAY_MEMORY_CLEANUP_GB);
  return Number.isFinite(n) && n > 0 ? n : 2.0;
})();
const RELAY_SHARED_SECRET = process.env.RELAY_SHARED_SECRET || '';
const RELAY_AUTH_HEADER = (process.env.RELAY_AUTH_HEADER || 'x-relay-key').toLowerCase();
const RELAY_WS_TOKEN = process.env.RELAY_WS_TOKEN || '';
const ALLOW_UNAUTHENTICATED_RELAY = process.env.ALLOW_UNAUTHENTICATED_RELAY === 'true';
const IS_PRODUCTION_RELAY = process.env.NODE_ENV === 'production'
  || !!process.env.RAILWAY_ENVIRONMENT
  || !!process.env.RAILWAY_PROJECT_ID
  || !!process.env.RAILWAY_STATIC_URL;
const RELAY_RATE_LIMIT_WINDOW_MS = Math.max(1000, Number(process.env.RELAY_RATE_LIMIT_WINDOW_MS || 60000));
const RELAY_RATE_LIMIT_MAX = Number.isFinite(Number(process.env.RELAY_RATE_LIMIT_MAX))
  ? Number(process.env.RELAY_RATE_LIMIT_MAX) : 1200;
const RELAY_OPENSKY_RATE_LIMIT_MAX = Number.isFinite(Number(process.env.RELAY_OPENSKY_RATE_LIMIT_MAX))
  ? Number(process.env.RELAY_OPENSKY_RATE_LIMIT_MAX) : 600;
const RELAY_RSS_RATE_LIMIT_MAX = Number.isFinite(Number(process.env.RELAY_RSS_RATE_LIMIT_MAX))
  ? Number(process.env.RELAY_RSS_RATE_LIMIT_MAX) : 300;
const RELAY_LOG_THROTTLE_MS = Math.max(1000, Number(process.env.RELAY_LOG_THROTTLE_MS || 10000));
const ALLOW_VERCEL_PREVIEW_ORIGINS = process.env.ALLOW_VERCEL_PREVIEW_ORIGINS === 'true';

// OREF (Israel Home Front Command) siren alerts — fetched via HTTP proxy (Israel exit)
const OREF_PROXY_AUTH = process.env.OREF_PROXY_AUTH || ''; // format: user:pass@host:port
const OREF_ALERTS_URL = 'https://www.oref.org.il/WarningMessages/alert/alerts.json';
const OREF_HISTORY_URL = 'https://www.oref.org.il/WarningMessages/alert/History/AlertsHistory.json';
const OREF_POLL_INTERVAL_MS = Math.max(30_000, Number(process.env.OREF_POLL_INTERVAL_MS || 300_000));
const OREF_ENABLED = !!OREF_PROXY_AUTH;
const RELAY_OREF_RATE_LIMIT_MAX = Number.isFinite(Number(process.env.RELAY_OREF_RATE_LIMIT_MAX))
  ? Number(process.env.RELAY_OREF_RATE_LIMIT_MAX) : 600;

if (IS_PRODUCTION_RELAY && !RELAY_SHARED_SECRET && !ALLOW_UNAUTHENTICATED_RELAY) {
  console.error('[Relay] Error: RELAY_SHARED_SECRET is required in production');
  console.error('[Relay] Set RELAY_SHARED_SECRET on Railway and Vercel to secure relay endpoints');
  console.error('[Relay] To bypass temporarily (not recommended), set ALLOW_UNAUTHENTICATED_RELAY=true');
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────
// Upstash Redis REST helpers — persist OREF history across restarts
// ─────────────────────────────────────────────────────────────
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const UPSTASH_ENABLED = !!(
  UPSTASH_REDIS_REST_URL &&
  UPSTASH_REDIS_REST_TOKEN &&
  UPSTASH_REDIS_REST_URL.startsWith('https://')
);
const RELAY_ENV_PREFIX = process.env.RELAY_ENV ? `${process.env.RELAY_ENV}:` : '';
const OREF_REDIS_KEY = `${RELAY_ENV_PREFIX}relay:oref:history:v1`;

if (UPSTASH_REDIS_REST_URL && !UPSTASH_REDIS_REST_URL.startsWith('https://')) {
  console.warn('[Relay] UPSTASH_REDIS_REST_URL must start with https:// — Redis disabled');
}
if (UPSTASH_ENABLED) {
  console.log(`[Relay] Upstash Redis enabled (key: ${OREF_REDIS_KEY})`);
}

function upstashGet(key) {
  return new Promise((resolve) => {
    if (!UPSTASH_ENABLED) return resolve(null);
    const url = new URL(`/get/${encodeURIComponent(key)}`, UPSTASH_REDIS_REST_URL);
    const req = https.request(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` },
      timeout: 5000,
    }, (resp) => {
      if (resp.statusCode < 200 || resp.statusCode >= 300) {
        resp.resume();
        return resolve(null);
      }
      let data = '';
      resp.on('data', (chunk) => { data += chunk; });
      resp.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed?.result) return resolve(JSON.parse(parsed.result));
          resolve(null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function upstashSet(key, value, ttlSeconds) {
  return new Promise((resolve) => {
    if (!UPSTASH_ENABLED) return resolve(false);
    const url = new URL('/', UPSTASH_REDIS_REST_URL);
    const body = JSON.stringify(['SET', key, JSON.stringify(value), 'EX', String(ttlSeconds)]);
    const req = https.request(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      timeout: 5000,
    }, (resp) => {
      let data = '';
      resp.on('data', (chunk) => { data += chunk; });
      resp.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed?.result === 'OK');
        } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end(body);
  });
}

// ─────────────────────────────────────────────────────────────
// Direct Fetch Infrastructure — local Redis + Supabase for direct-fetch channels
// ─────────────────────────────────────────────────────────────
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
});

redis.on('error', (err) => {
  console.warn('[redis] connection error (caching disabled):', err.message);
});

redis.on('connect', () => {
  console.log('[redis] connected to local Redis');
});

// Eagerly connect so Redis is ready before the first cron fires.
redis.connect().catch(() => {/* error logged by error handler above */});

const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
  ? createSupabaseClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  : null;

async function redisGet(key) {
  if (redis.status !== 'ready') return null;
  try {
    const val = await redis.get(key);
    return val ? JSON.parse(val) : null;
  } catch (err) {
    console.warn('[redis] get error:', err.message);
    return null;
  }
}

async function redisSetex(key, ttlSec, value) {
  if (redis.status !== 'ready') return;
  try {
    await redis.setex(key, ttlSec, JSON.stringify(value));
  } catch (err) {
    console.warn('[redis] setex error:', err.message);
  }
}

async function redisDel(key) {
  if (redis.status !== 'ready') return;
  try {
    await redis.del(key);
  } catch (err) {
    console.warn('[redis] del error:', err.message);
  }
}

const MAX_TTL_SEC = 14 * 24 * 3600; // 1,209,600 seconds = 2 weeks

async function directFetchAndBroadcast(channel, redisKey, ttlSec, fetcher) {
  const effectiveTtl = Math.min(ttlSec, MAX_TTL_SEC);
  const cached = await redisGet(redisKey);
  if (cached) {
    broadcastToChannel(channel, cached);
    return;
  }
  let data;
  try {
    data = await fetcher();
  } catch (err) {
    console.warn(`[relay-fetch] ${channel} failed: ${err?.message ?? err} — retrying in 5s`);
    await new Promise(r => setTimeout(r, 5000));
    try {
      data = await fetcher();
    } catch (retryErr) {
      console.error(`[relay-fetch] ${channel} retry failed: ${retryErr?.message ?? retryErr}`);
      return;
    }
  }
  if (!data) {
    console.warn(`[relay-fetch] ${channel} fetcher returned no data — skipping cache and broadcast`);
    return;
  }
  await redisSetex(redisKey, effectiveTtl, data);
  broadcastToChannel(channel, data);
}

async function auditStaleTTLs() {
  try {
    let cursor = '0';
    let fixed = 0;
    do {
      const [next, keys] = await redis.scan(cursor, 'COUNT', 100);
      cursor = next;
      for (const key of keys) {
        const ttl = await redis.ttl(key);
        if (ttl === -1) {
          await redis.expire(key, MAX_TTL_SEC);
          fixed++;
        }
      }
    } while (cursor !== '0');
    if (fixed > 0) console.log(`[redis-audit] Set TTL on ${fixed} immortal keys`);
  } catch (err) {
    console.warn('[redis-audit] skipped — Redis unavailable:', err?.message ?? err);
  }
}

cron.schedule('0 * * * *', async () => {
  try {
    await auditStaleTTLs();
  } catch (err) {
    console.error('[redis-audit] error:', err?.message ?? err);
  }
});

// ─────────────────────────────────────────────────────────────

let upstreamSocket = null;
let upstreamPaused = false;
let upstreamQueue = [];
let upstreamQueueReadIndex = 0;
let upstreamDrainScheduled = false;
let clients = new Set();

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
  'config:feature-flags', 'climate', 'conflict', 'ucdp-events',
]);
const CHANNEL_PATTERN = /^[a-z0-9:_-]{1,63}$/;
const MAX_CHANNELS_PER_CLIENT = 50;
const MAX_WS_MESSAGE_BYTES = 64 * 1024;
const MAX_PUSH_PAYLOAD_BYTES = 512 * 1024;
const WS_BUFFERED_AMOUNT_THRESHOLD = 1024 * 1024;

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
  if (!ALLOWED_CHANNELS.has(channel)) return false;
  if (!CHANNEL_PATTERN.test(channel)) return false;
  const count = clientChannelCount.get(ws) || 0;
  if (count >= MAX_CHANNELS_PER_CLIENT) return false;
  if (!channelSubscribers.has(channel)) {
    channelSubscribers.set(channel, new Set());
  }
  const subs = channelSubscribers.get(channel);
  if (subs.has(ws)) return false;
  subs.add(ws);
  clientChannelCount.set(ws, count + 1);
  return true;
}

function unsubscribeClient(ws) {
  for (const subs of channelSubscribers.values()) {
    subs.delete(ws);
  }
  clientChannelCount.delete(ws);
  wsSubRateLimit.delete(ws);
}

// Cache the latest payload per channel so new subscribers get data immediately
const latestPayloads = new Map(); // channel → serialized JSON string (wm-push message)

/**
 * Broadcast a typed payload to all clients subscribed to a channel.
 * Also caches the payload so late-joining subscribers receive it immediately.
 */
function broadcastToChannel(channel, payload) {
  const msg = JSON.stringify({ type: 'wm-push', channel, payload, ts: Date.now() });
  const msgBytes = Buffer.byteLength(msg);
  if (msgBytes > MAX_PUSH_PAYLOAD_BYTES) {
    console.warn(`[relay] payload too large for ${channel} (${msgBytes} bytes), skipping`);
    return;
  }
  latestPayloads.set(channel, msg);
  const subs = channelSubscribers.get(channel);
  if (!subs || subs.size === 0) return;
  for (const ws of subs) {
    if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < WS_BUFFERED_AMOUNT_THRESHOLD) {
      ws.send(msg);
    }
  }
}

/**
 * Send cached payloads for all requested channels to a newly subscribed client.
 * Tries in-memory cache first, falls back to Redis for channels with a known key.
 */
async function sendCachedPayloads(ws, channels) {
  for (const ch of channels) {
    if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount >= WS_BUFFERED_AMOUNT_THRESHOLD) return;
    const mem = latestPayloads.get(ch);
    if (mem) { ws.send(mem); continue; }
    const redisKey = PHASE4_CHANNEL_KEYS[ch];
    if (!redisKey) continue;
    try {
      const data = await redisGet(redisKey);
      if (data && ws.readyState === WebSocket.OPEN) {
        const msg = JSON.stringify({ type: 'wm-push', channel: ch, payload: data, ts: Date.now() });
        if (Buffer.byteLength(msg) <= MAX_PUSH_PAYLOAD_BYTES) {
          latestPayloads.set(ch, msg);
          ws.send(msg);
        }
      }
    } catch { /* Redis unavailable — skip */ }
  }
}

// ── Intelligence channel warm (LLM route on Vercel) ──────────────────────────
const VERCEL_APP_URL = process.env.VERCEL_APP_URL || 'https://worldmonitor.app';
const RELAY_ALLOWED_WARM_HOSTS = process.env.RELAY_ALLOWED_WARM_HOSTS || 'worldmonitor.app,info.5ls.us';
const ALLOWED_WARM_HOSTS = RELAY_ALLOWED_WARM_HOSTS
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

function isAllowedWarmHost(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && ALLOWED_WARM_HOSTS.some(h => u.hostname === h || u.hostname.endsWith('.' + h));
  } catch { return false; }
}

async function warmIntelligenceAndBroadcast() {
  if (!UPSTASH_ENABLED || !RELAY_SHARED_SECRET) return;
  const channel = 'intelligence';
  const path = '/api/intelligence/v1/get-global-intel-digest';
  const redisKey = 'digest:global:v1';
  try {
    const warmUrl = `${VERCEL_APP_URL}${path}`;
    if (!isAllowedWarmHost(warmUrl)) {
      console.error(`[relay-cron] VERCEL_APP_URL points to disallowed host: ${VERCEL_APP_URL}`);
      return;
    }
    const warmRes = await fetch(warmUrl, {
      headers: {
        'X-WorldMonitor-Key': RELAY_SHARED_SECRET,
        'User-Agent': 'worldmonitor-relay-warmer/1.0',
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!warmRes.ok) {
      console.warn(`[relay-cron] intelligence warm failed: ${warmRes.status}`);
      return;
    }
    const getRes = await fetch(
      `${UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(redisKey)}`,
      { headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` }, signal: AbortSignal.timeout(5_000) }
    );
    if (!getRes.ok) return;
    const { result } = await getRes.json();
    if (!result) return;
    let payload;
    try { payload = JSON.parse(result); } catch {
      console.warn('[relay-cron] unparseable Redis value for intelligence');
      return;
    }
    await redisSetex('digest:global:v1', 600, payload);
    broadcastToChannel(channel, payload);
    console.log(`[relay-cron] broadcast channel=${channel} subs=${channelSubscribers.get(channel)?.size ?? 0}`);
  } catch (err) {
    console.warn('[relay-cron] intelligence warm error:', err?.message ?? err);
  }
}

let messageCount = 0;
let droppedMessages = 0;
const requestRateBuckets = new Map(); // key: route:ip -> { count, resetAt }
const logThrottleState = new Map(); // key: event key -> timestamp

// Safe response: guard against "headers already sent" crashes
function safeEnd(res, statusCode, headers, body) {
  if (res.headersSent || res.writableEnded) return false;
  try {
    res.writeHead(statusCode, headers);
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

// gzip compress & send a response (reduces egress ~80% for JSON)
function sendCompressed(req, res, statusCode, headers, body) {
  if (res.headersSent || res.writableEnded) return;
  const acceptEncoding = req.headers['accept-encoding'] || '';
  if (acceptEncoding.includes('gzip')) {
    zlib.gzip(typeof body === 'string' ? Buffer.from(body) : body, (err, compressed) => {
      if (err || res.headersSent || res.writableEnded) {
        safeEnd(res, statusCode, headers, body);
        return;
      }
      const existingVary = String(res.getHeader('vary') || '');
      const vary = existingVary.toLowerCase().includes('accept-encoding')
        ? existingVary
        : (existingVary ? `${existingVary}, Accept-Encoding` : 'Accept-Encoding');
      safeEnd(res, statusCode, { ...headers, 'Content-Encoding': 'gzip', 'Vary': vary }, compressed);
    });
  } else {
    safeEnd(res, statusCode, headers, body);
  }
}

// Pre-gzipped response: serve a cached gzip buffer directly (zero CPU per request)
function sendPreGzipped(req, res, statusCode, headers, rawBody, gzippedBody) {
  if (res.headersSent || res.writableEnded) return;
  const acceptEncoding = req.headers['accept-encoding'] || '';
  if (acceptEncoding.includes('gzip') && gzippedBody) {
    const existingVary = String(res.getHeader('vary') || '');
    const vary = existingVary.toLowerCase().includes('accept-encoding')
      ? existingVary
      : (existingVary ? `${existingVary}, Accept-Encoding` : 'Accept-Encoding');
    safeEnd(res, statusCode, { ...headers, 'Content-Encoding': 'gzip', 'Vary': vary }, gzippedBody);
  } else {
    safeEnd(res, statusCode, headers, rawBody);
  }
}

// ─────────────────────────────────────────────────────────────
// Telegram OSINT ingestion (public channels) → Early Signals
// Web-first: runs on this Railway relay process, serves /telegram/feed
// Requires env:
// - TELEGRAM_API_ID
// - TELEGRAM_API_HASH
// - TELEGRAM_SESSION (StringSession)
// ─────────────────────────────────────────────────────────────
const TELEGRAM_ENABLED = Boolean(process.env.TELEGRAM_API_ID && process.env.TELEGRAM_API_HASH && process.env.TELEGRAM_SESSION);
const TELEGRAM_POLL_INTERVAL_MS = Math.max(15_000, Number(process.env.TELEGRAM_POLL_INTERVAL_MS || 60_000));
const TELEGRAM_MAX_FEED_ITEMS = Math.max(50, Number(process.env.TELEGRAM_MAX_FEED_ITEMS || 200));
const TELEGRAM_MAX_TEXT_CHARS = Math.max(200, Number(process.env.TELEGRAM_MAX_TEXT_CHARS || 800));

const telegramState = {
  client: null,
  channels: [],
  cursorByHandle: Object.create(null),
  items: [],
  lastPollAt: 0,
  lastError: null,
  startedAt: Date.now(),
};

const orefState = {
  lastAlerts: [],
  lastAlertsJson: '[]',
  lastPollAt: 0,
  lastError: null,
  historyCount24h: 0,
  totalHistoryCount: 0,
  history: [],
  bootstrapSource: null,
  _persistVersion: 0,
  _lastPersistedVersion: 0,
  _persistInFlight: false,
};

function loadTelegramChannels() {
  // Product-managed curated list lives in repo root under data/ (shared by web + desktop).
  // Relay is executed from scripts/, so resolve ../data.
  const p = path.join(__dirname, '..', 'data', 'telegram-channels.json');
  const set = String(process.env.TELEGRAM_CHANNEL_SET || 'full').toLowerCase();
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    const bucket = raw?.channels?.[set];
    const channels = Array.isArray(bucket) ? bucket : [];

    telegramState.channels = channels
      .filter(c => c && typeof c.handle === 'string' && c.handle.length > 1)
      .map(c => ({
        handle: String(c.handle).replace(/^@/, ''),
        label: c.label ? String(c.label) : undefined,
        topic: c.topic ? String(c.topic) : undefined,
        region: c.region ? String(c.region) : undefined,
        tier: c.tier != null ? Number(c.tier) : undefined,
        enabled: c.enabled !== false,
        maxMessages: c.maxMessages != null ? Number(c.maxMessages) : undefined,
      }))
      .filter(c => c.enabled);

    if (!telegramState.channels.length) {
      console.warn(`[Relay] Telegram channel set "${set}" is empty — no channels to poll`);
    }

    return telegramState.channels;
  } catch (e) {
    telegramState.channels = [];
    telegramState.lastError = `failed to load telegram-channels.json: ${e?.message || String(e)}`;
    return [];
  }
}

function normalizeTelegramMessage(msg, channel) {
  const textRaw = String(msg?.message || '');
  const text = textRaw.slice(0, TELEGRAM_MAX_TEXT_CHARS);
  const ts = msg?.date ? new Date(msg.date * 1000).toISOString() : new Date().toISOString();
  return {
    id: `${channel.handle}:${msg.id}`,
    source: 'telegram',
    channel: channel.handle,
    channelTitle: channel.label || channel.handle,
    url: `https://t.me/${channel.handle}/${msg.id}`,
    ts,
    text,
    topic: channel.topic || 'other',
    tags: [channel.region].filter(Boolean),
    earlySignal: true,
  };
}

let telegramPermanentlyDisabled = false;

async function initTelegramClientIfNeeded() {
  if (!TELEGRAM_ENABLED) return false;
  if (telegramState.client) return true;
  if (telegramPermanentlyDisabled) return false;

  const apiId = parseInt(String(process.env.TELEGRAM_API_ID || ''), 10);
  const apiHash = String(process.env.TELEGRAM_API_HASH || '');
  const sessionStr = String(process.env.TELEGRAM_SESSION || '');

  if (!apiId || !apiHash || !sessionStr) return false;

  try {
    const { TelegramClient } = await import('telegram');
    const { StringSession } = await import('telegram/sessions/index.js');

    const client = new TelegramClient(new StringSession(sessionStr), apiId, apiHash, {
      connectionRetries: 3,
    });

    await client.connect();
    telegramState.client = client;
    telegramState.lastError = null;
    console.log('[Relay] Telegram client connected');
    return true;
  } catch (e) {
    const em = e?.message || String(e);
    if (e?.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find package|Directory import/.test(em)) {
      telegramPermanentlyDisabled = true;
      telegramState.lastError = 'telegram package not installed';
      console.warn('[Relay] Telegram package not installed — disabling permanently for this session');
      return false;
    }
    if (/AUTH_KEY_DUPLICATED/.test(em)) {
      telegramPermanentlyDisabled = true;
      telegramState.lastError = 'session invalidated (AUTH_KEY_DUPLICATED) — generate a new TELEGRAM_SESSION';
      console.error('[Relay] Telegram session permanently invalidated (AUTH_KEY_DUPLICATED). Generate a new session with: node scripts/telegram/session-auth.mjs');
      return false;
    }
    telegramState.lastError = `telegram init failed: ${em}`;
    console.warn('[Relay] Telegram init failed:', telegramState.lastError);
    return false;
  }
}

const TELEGRAM_CHANNEL_TIMEOUT_MS = 15_000; // 15s timeout per channel (getEntity + getMessages)
const TELEGRAM_POLL_CYCLE_TIMEOUT_MS = 180_000; // 3min max for entire poll cycle

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`TIMEOUT after ${ms}ms: ${label}`)), ms);
    promise.then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); }
    );
  });
}

async function ingestTelegramHeadlines(messages) {
  const secret = RELAY_SHARED_SECRET;
  // VERCEL_APP_URL: Vercel deployment URL (relay → Vercel direction, opposite of WS_RELAY_URL)
  const baseUrl = process.env.VERCEL_APP_URL;
  if (!secret || !baseUrl || !messages || messages.length === 0) return;

  try {
    const headlines = messages
      .filter(m => m.text && m.text.trim())
      .map(m => ({
        title: m.text.trim().slice(0, 500),
        pubDate: m.ts ? Math.floor(new Date(m.ts).getTime() / 1000) : Math.floor(Date.now() / 1000),
        scopes: [...new Set([m.topic || 'global', 'global', 'telegram'])],
      }));

    if (headlines.length === 0) return;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    fetch(`${baseUrl}/api/cron/ingest-headlines`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [RELAY_AUTH_HEADER]: secret,
      },
      body: JSON.stringify({ headlines }),
      signal: controller.signal,
    }).then(() => clearTimeout(timeout))
      .catch(err => console.error('[Relay] Failed to ingest headlines:', err.message));
  } catch (err) {
    console.error('[Relay] ingestTelegramHeadlines error:', err.message);
  }
}

async function pollTelegramOnce() {
  const ok = await initTelegramClientIfNeeded();
  if (!ok) return;

  const channels = telegramState.channels.length ? telegramState.channels : loadTelegramChannels();
  if (!channels.length) return;

  const client = telegramState.client;
  const newItems = [];
  const pollStart = Date.now();
  let channelsPolled = 0;
  let channelsFailed = 0;
  let mediaSkipped = 0;

  for (const channel of channels) {
    if (Date.now() - pollStart > TELEGRAM_POLL_CYCLE_TIMEOUT_MS) {
      console.warn(`[Relay] Telegram poll cycle timeout (${Math.round(TELEGRAM_POLL_CYCLE_TIMEOUT_MS / 1000)}s), polled ${channelsPolled}/${channels.length} channels`);
      break;
    }

    const handle = channel.handle;
    const minId = telegramState.cursorByHandle[handle] || 0;

    try {
      const entity = await withTimeout(client.getEntity(handle), TELEGRAM_CHANNEL_TIMEOUT_MS, `getEntity(${handle})`);
      const msgs = await withTimeout(
        client.getMessages(entity, {
          limit: Math.max(1, Math.min(50, channel.maxMessages || 25)),
          minId,
        }),
        TELEGRAM_CHANNEL_TIMEOUT_MS,
        `getMessages(${handle})`
      );

      for (const msg of msgs) {
        if (!msg || !msg.id) continue;
        if (!msg.message) { mediaSkipped++; continue; }
        const item = normalizeTelegramMessage(msg, channel);
        newItems.push(item);
        if (!telegramState.cursorByHandle[handle] || msg.id > telegramState.cursorByHandle[handle]) {
          telegramState.cursorByHandle[handle] = msg.id;
        }
      }

      channelsPolled++;
      await new Promise(r => setTimeout(r, Math.max(300, Number(process.env.TELEGRAM_RATE_LIMIT_MS || 800))));
    } catch (e) {
      const em = e?.message || String(e);
      channelsFailed++;
      telegramState.lastError = `poll ${handle} failed: ${em}`;
      console.warn('[Relay] Telegram poll error:', telegramState.lastError);
      if (/AUTH_KEY_DUPLICATED/.test(em)) {
        telegramPermanentlyDisabled = true;
        telegramState.lastError = 'session invalidated (AUTH_KEY_DUPLICATED) — generate a new TELEGRAM_SESSION';
        console.error('[Relay] Telegram session permanently invalidated (AUTH_KEY_DUPLICATED). Generate a new session with: node scripts/telegram/session-auth.mjs');
        try { telegramState.client?.disconnect(); } catch {}
        telegramState.client = null;
        break;
      }
      if (/FLOOD_WAIT/.test(em)) {
        const wait = parseInt(em.match(/(\d+)/)?.[1] || '60', 10);
        console.warn(`[Relay] Telegram FLOOD_WAIT ${wait}s — stopping poll cycle early`);
        break;
      }
    }
  }

  if (newItems.length) {
    const seen = new Set();
    telegramState.items = [...newItems, ...telegramState.items]
      .filter(item => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      })
      .sort((a, b) => (b.ts || '').localeCompare(a.ts || ''))
      .slice(0, TELEGRAM_MAX_FEED_ITEMS);

    ingestTelegramHeadlines(newItems);
  }

  telegramState.lastPollAt = Date.now();
  const elapsed = ((Date.now() - pollStart) / 1000).toFixed(1);
  console.log(`[Relay] Telegram poll: ${channelsPolled}/${channels.length} channels, ${newItems.length} new msgs, ${telegramState.items.length} total, ${channelsFailed} errors, ${mediaSkipped} media-only skipped (${elapsed}s)`);
}

let telegramPollInFlight = false;
let telegramPollStartedAt = 0;

function guardedTelegramPoll() {
  if (telegramPollInFlight) {
    const stuck = Date.now() - telegramPollStartedAt;
    if (stuck > TELEGRAM_POLL_CYCLE_TIMEOUT_MS + 30_000) {
      console.warn(`[Relay] Telegram poll stuck for ${Math.round(stuck / 1000)}s — force-clearing in-flight flag`);
      telegramPollInFlight = false;
    } else {
      return;
    }
  }
  telegramPollInFlight = true;
  telegramPollStartedAt = Date.now();
  pollTelegramOnce()
    .catch(e => console.warn('[Relay] Telegram poll error:', e?.message || e))
    .finally(() => { telegramPollInFlight = false; });
}

const TELEGRAM_STARTUP_DELAY_MS = Math.max(0, Number(process.env.TELEGRAM_STARTUP_DELAY_MS || 60_000));

function startTelegramPollLoop() {
  if (!TELEGRAM_ENABLED) return;
  loadTelegramChannels();
  if (TELEGRAM_STARTUP_DELAY_MS > 0) {
    console.log(`[Relay] Telegram connect delayed ${TELEGRAM_STARTUP_DELAY_MS}ms (waiting for old container to disconnect)`);
    setTimeout(() => {
      guardedTelegramPoll();
      setInterval(guardedTelegramPoll, TELEGRAM_POLL_INTERVAL_MS).unref?.();
      console.log('[Relay] Telegram poll loop started');
    }, TELEGRAM_STARTUP_DELAY_MS);
  } else {
    guardedTelegramPoll();
    setInterval(guardedTelegramPoll, TELEGRAM_POLL_INTERVAL_MS).unref?.();
    console.log('[Relay] Telegram poll loop started');
  }
}

// ─────────────────────────────────────────────────────────────
// OREF Siren Alerts (Israel Home Front Command)
// Polls oref.org.il via HTTP CONNECT tunnel through residential proxy (Israel exit)
// ─────────────────────────────────────────────────────────────

function stripBom(text) {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

function redactOrefError(msg) {
  return String(msg || '').replace(/\/\/[^@]+@/g, '//<redacted>@');
}

function orefDateToUTC(dateStr) {
  if (!dateStr || !dateStr.includes(' ')) return new Date().toISOString();
  const [datePart, timePart] = dateStr.split(' ');
  const [y, m, d] = datePart.split('-').map(Number);
  const [hh, mm, ss] = timePart.split(':').map(Number);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  function partsAt(ms) {
    const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
  }
  const base2 = Date.UTC(y, m - 1, d, hh - 2, mm, ss);
  const base3 = Date.UTC(y, m - 1, d, hh - 3, mm, ss);
  const candidates = [];
  if (partsAt(base2) === dateStr) candidates.push(base2);
  if (partsAt(base3) === dateStr) candidates.push(base3);
  const ms = candidates.length ? Math.min(...candidates) : base2;
  return new Date(ms).toISOString();
}

function orefCurlFetch(proxyAuth, url, { toFile } = {}) {
  // Use curl via child_process — Node.js TLS fingerprint (JA3) gets blocked by Akamai,
  // but curl's fingerprint passes. curl is available on Railway (Linux) and macOS.
  // execFileSync avoids shell interpolation — safe with special chars in proxy credentials.
  const { execFileSync } = require('child_process');
  const proxyUrl = `http://${proxyAuth}`;
  const args = [
    '-sS', '-x', proxyUrl, '--max-time', '15',
    '-H', 'Accept: application/json',
    '-H', 'Referer: https://www.oref.org.il/',
    '-H', 'X-Requested-With: XMLHttpRequest',
  ];
  if (toFile) {
    // Write directly to disk — avoids stdout buffer overflow (ENOBUFS) for large responses
    args.push('-o', toFile);
    args.push(url);
    execFileSync('curl', args, { timeout: 20000, stdio: ['pipe', 'pipe', 'pipe'] });
    return require('fs').readFileSync(toFile, 'utf8');
  }
  args.push(url);
  const result = execFileSync('curl', args, { encoding: 'utf8', timeout: 20000, stdio: ['pipe', 'pipe', 'pipe'] });
  return result;
}

async function orefFetchAlerts() {
  if (!OREF_ENABLED) return;
  try {
    const raw = orefCurlFetch(OREF_PROXY_AUTH, OREF_ALERTS_URL);
    const cleaned = stripBom(raw).trim();

    let alerts = [];
    if (cleaned && cleaned !== '[]' && cleaned !== 'null') {
      try {
        const parsed = JSON.parse(cleaned);
        alerts = Array.isArray(parsed) ? parsed : [parsed];
      } catch { alerts = []; }
    }

    const newJson = JSON.stringify(alerts);
    const changed = newJson !== orefState.lastAlertsJson;

    orefState.lastAlerts = alerts;
    orefState.lastAlertsJson = newJson;
    orefState.lastPollAt = Date.now();
    orefState.lastError = null;

    if (changed && alerts.length > 0) {
      orefState.history.push({
        alerts,
        timestamp: new Date().toISOString(),
      });
      orefState._persistVersion++;
    }

    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    orefState.historyCount24h = orefState.history
      .filter(h => new Date(h.timestamp).getTime() > cutoff)
      .reduce((sum, h) => sum + h.alerts.reduce((s, a) => s + (Array.isArray(a.data) ? a.data.length : 1), 0), 0);
    const purgeCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const beforeLen = orefState.history.length;
    orefState.history = orefState.history.filter(
      h => new Date(h.timestamp).getTime() > purgeCutoff
    );
    if (orefState.history.length !== beforeLen) orefState._persistVersion++;
    orefState.totalHistoryCount = orefState.history.reduce((sum, h) => {
      return sum + h.alerts.reduce((s, a) => s + (Array.isArray(a.data) ? a.data.length : 1), 0);
    }, 0);

    orefPersistHistory().catch(() => {});
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString().trim() : '';
    orefState.lastError = redactOrefError(stderr || err.message);
    console.warn('[Relay] OREF poll error:', orefState.lastError);
  }
}

async function orefBootstrapHistoryFromUpstream() {
  const tmpFile = require('path').join(require('os').tmpdir(), `oref-history-${Date.now()}.json`);
  let raw;
  try {
    raw = orefCurlFetch(OREF_PROXY_AUTH, OREF_HISTORY_URL, { toFile: tmpFile });
  } finally {
    try { require('fs').unlinkSync(tmpFile); } catch {}
  }
  const cleaned = stripBom(raw).trim();
  if (!cleaned || cleaned === '[]') return;

  const allRecords = JSON.parse(cleaned);
  const records = allRecords.slice(0, 500);
  const waves = new Map();
  for (const r of records) {
    const key = r.alertDate;
    if (!waves.has(key)) waves.set(key, []);
    waves.get(key).push(r);
  }
  const history = [];
  let totalAlertRecords = 0;
  for (const [dateStr, recs] of waves) {
    const iso = orefDateToUTC(dateStr);
    const byType = new Map();
    let typeIdx = 0;
    for (const r of recs) {
      const k = `${r.category}|${r.title}`;
      if (!byType.has(k)) {
        byType.set(k, {
          id: `${r.category}-${typeIdx++}-${dateStr.replace(/[^0-9]/g, '')}`,
          cat: String(r.category),
          title: r.title,
          data: [],
          desc: '',
          alertDate: dateStr,
        });
      }
      byType.get(k).data.push(r.data);
      totalAlertRecords++;
    }
    history.push({ alerts: [...byType.values()], timestamp: new Date(iso).toISOString() });
  }
  history.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  orefState.history = history;
  orefState.totalHistoryCount = totalAlertRecords;
  const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;
  orefState.historyCount24h = history
    .filter(h => new Date(h.timestamp).getTime() > cutoff24h)
    .reduce((sum, h) => sum + h.alerts.reduce((s, a) => s + (Array.isArray(a.data) ? a.data.length : 1), 0), 0);
  orefState.bootstrapSource = 'upstream';
  if (history.length > 0) orefState._persistVersion++;
  console.log(`[Relay] OREF history bootstrap: ${totalAlertRecords} records across ${history.length} waves`);
}

const OREF_PERSIST_MAX_WAVES = 200;
const OREF_PERSIST_TTL_SECONDS = 7 * 24 * 60 * 60;

async function orefPersistHistory() {
  if (!UPSTASH_ENABLED) return;
  if (orefState._persistVersion === orefState._lastPersistedVersion) return;
  if (orefState._persistInFlight) return;
  orefState._persistInFlight = true;
  const versionAtStart = orefState._persistVersion;
  try {
    let waves = orefState.history;
    if (waves.length > OREF_PERSIST_MAX_WAVES) {
      console.warn(`[Relay] OREF persist: truncating ${waves.length} waves to ${OREF_PERSIST_MAX_WAVES}`);
      waves = waves.slice(-OREF_PERSIST_MAX_WAVES);
    }
    const payload = {
      history: waves,
      historyCount24h: orefState.historyCount24h,
      totalHistoryCount: orefState.totalHistoryCount,
      persistedAt: new Date().toISOString(),
    };
    const ok = await upstashSet(OREF_REDIS_KEY, payload, OREF_PERSIST_TTL_SECONDS);
    if (ok) {
      orefState._lastPersistedVersion = versionAtStart;
    }
  } finally {
    orefState._persistInFlight = false;
  }
}

async function orefBootstrapHistoryWithRetry() {
  // Phase 1: try Redis first
  try {
    const cached = await upstashGet(OREF_REDIS_KEY);
    if (cached && Array.isArray(cached.history) && cached.history.length > 0) {
      const valid = cached.history.every(
        h => Array.isArray(h.alerts) && typeof h.timestamp === 'string'
      );
      if (valid) {
        const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;
        const purgeCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const filtered = cached.history.filter(
          h => new Date(h.timestamp).getTime() > purgeCutoff
        );
        if (filtered.length > 0) {
          orefState.history = filtered;
          orefState.totalHistoryCount = filtered.reduce((sum, h) => {
            return sum + h.alerts.reduce((s, a) => s + (Array.isArray(a.data) ? a.data.length : 1), 0);
          }, 0);
          orefState.historyCount24h = filtered
            .filter(h => new Date(h.timestamp).getTime() > cutoff24h)
            .reduce((sum, h) => sum + h.alerts.reduce((s, a) => s + (Array.isArray(a.data) ? a.data.length : 1), 0), 0);
          const newest = filtered[filtered.length - 1];
          orefState.lastAlertsJson = JSON.stringify(newest.alerts);
          orefState.bootstrapSource = 'redis';
          console.log(`[Relay] OREF history loaded from Redis: ${orefState.totalHistoryCount} records across ${filtered.length} waves (persisted ${cached.persistedAt || 'unknown'})`);
          return;
        }
        console.log('[Relay] OREF Redis data all stale (>7d) — falling through to upstream');
      }
    }
  } catch (err) {
    console.warn('[Relay] OREF Redis bootstrap failed:', err?.message || err);
  }

  // Phase 2: upstream with retry + exponential backoff
  const MAX_ATTEMPTS = 3;
  const BASE_DELAY_MS = 3000;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await orefBootstrapHistoryFromUpstream();
      if (UPSTASH_ENABLED) {
        await orefPersistHistory().catch(() => {});
      }
      console.log(`[Relay] OREF upstream bootstrap succeeded on attempt ${attempt}`);
      return;
    } catch (err) {
      const msg = redactOrefError(err?.message || String(err));
      console.warn(`[Relay] OREF upstream bootstrap attempt ${attempt}/${MAX_ATTEMPTS} failed: ${msg}`);
      if (attempt < MAX_ATTEMPTS) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1) + Math.random() * 1000;
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  orefState.bootstrapSource = null;
  console.warn('[Relay] OREF bootstrap exhausted all attempts — starting with empty history');
}

async function startOrefPollLoop() {
  if (!OREF_ENABLED) {
    console.log('[Relay] OREF disabled (no OREF_PROXY_AUTH)');
    return;
  }
  await orefBootstrapHistoryWithRetry();
  console.log(`[Relay] OREF bootstrap complete (source: ${orefState.bootstrapSource || 'none'}, redis: ${UPSTASH_ENABLED})`);
  orefFetchAlerts().catch(e => console.warn('[Relay] OREF initial poll error:', e?.message || e));
  setInterval(() => {
    orefFetchAlerts().catch(e => console.warn('[Relay] OREF poll error:', e?.message || e));
  }, OREF_POLL_INTERVAL_MS).unref?.();
  console.log(`[Relay] OREF poll loop started (interval ${OREF_POLL_INTERVAL_MS}ms)`);
}

// ─────────────────────────────────────────────────────────────
// UCDP GED Events — fetch paginated conflict data, write to Redis
// ─────────────────────────────────────────────────────────────
const UCDP_ACCESS_TOKEN = (process.env.UCDP_ACCESS_TOKEN || process.env.UC_DP_KEY || '').trim();
const UCDP_REDIS_KEY = 'conflict:ucdp-events:v1';
const UCDP_PAGE_SIZE = 1000;
const UCDP_MAX_PAGES = 6;
const UCDP_MAX_EVENTS = 2000; // TODO: review cap after observing real map density & panel usage
const UCDP_TRAILING_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;
const UCDP_POLL_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const UCDP_TTL_SECONDS = 86400; // 24h safety net
const UCDP_VIOLENCE_TYPE_MAP = { 1: 'UCDP_VIOLENCE_TYPE_STATE_BASED', 2: 'UCDP_VIOLENCE_TYPE_NON_STATE', 3: 'UCDP_VIOLENCE_TYPE_ONE_SIDED' };

function ucdpFetchPage(version, page) {
  return new Promise((resolve, reject) => {
    const pageUrl = new URL(`https://ucdpapi.pcr.uu.se/api/gedevents/${version}?pagesize=${UCDP_PAGE_SIZE}&page=${page}`);
    const headers = { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };
    if (UCDP_ACCESS_TOKEN) headers['x-ucdp-access-token'] = UCDP_ACCESS_TOKEN;
    const req = https.request(pageUrl, { method: 'GET', headers, timeout: 30000 }, (resp) => {
      if (resp.statusCode < 200 || resp.statusCode >= 300) {
        resp.resume();
        return reject(new Error(`UCDP ${version} page ${page}: HTTP ${resp.statusCode}`));
      }
      let data = '';
      resp.on('data', (chunk) => { data += chunk; });
      resp.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('UCDP timeout')); });
    req.end();
  });
}

async function ucdpDiscoverVersion() {
  const year = new Date().getFullYear() - 2000;
  const candidates = [...new Set([`${year}.1`, `${year - 1}.1`, '25.1', '24.1'])];
  const results = await Promise.allSettled(
    candidates.map(async (v) => {
      const p0 = await ucdpFetchPage(v, 0);
      if (!Array.isArray(p0?.Result)) throw new Error('No results');
      return { version: v, page0: p0 };
    }),
  );
  for (const r of results) {
    if (r.status === 'fulfilled') return r.value;
  }
  throw new Error('No valid UCDP GED version found');
}

async function seedUcdpEvents() {
  try {
    const { version, page0 } = await ucdpDiscoverVersion();
    const totalPages = Math.max(1, Number(page0?.TotalPages) || 1);
    const newestPage = totalPages - 1;
    console.log(`[UCDP] Version ${version}, ${totalPages} total pages`);

    const FAILED = Symbol('failed');
    const fetches = [];
    for (let offset = 0; offset < UCDP_MAX_PAGES && (newestPage - offset) >= 0; offset++) {
      const pg = newestPage - offset;
      fetches.push(pg === 0 ? Promise.resolve(page0) : ucdpFetchPage(version, pg).catch(() => FAILED));
    }
    const pageResults = await Promise.all(fetches);

    const allEvents = [];
    let latestMs = NaN;
    let failedPages = 0;
    for (const raw of pageResults) {
      if (raw === FAILED) { failedPages++; continue; }
      const events = Array.isArray(raw?.Result) ? raw.Result : [];
      allEvents.push(...events);
      for (const e of events) {
        const ms = e?.date_start ? Date.parse(String(e.date_start)) : NaN;
        if (Number.isFinite(ms) && (!Number.isFinite(latestMs) || ms > latestMs)) latestMs = ms;
      }
    }

    const filtered = allEvents.filter((e) => {
      if (!Number.isFinite(latestMs)) return true;
      const ms = e?.date_start ? Date.parse(String(e.date_start)) : NaN;
      return Number.isFinite(ms) && ms >= (latestMs - UCDP_TRAILING_WINDOW_MS);
    });

    const mapped = filtered.map((e) => ({
      id: String(e.id || ''),
      dateStart: Date.parse(e.date_start) || 0,
      dateEnd: Date.parse(e.date_end) || 0,
      location: { latitude: Number(e.latitude) || 0, longitude: Number(e.longitude) || 0 },
      country: e.country || '',
      sideA: (e.side_a || '').substring(0, 200),
      sideB: (e.side_b || '').substring(0, 200),
      deathsBest: Number(e.best) || 0,
      deathsLow: Number(e.low) || 0,
      deathsHigh: Number(e.high) || 0,
      violenceType: UCDP_VIOLENCE_TYPE_MAP[e.type_of_violence] || 'UCDP_VIOLENCE_TYPE_UNSPECIFIED',
      sourceOriginal: (e.source_original || '').substring(0, 300),
    })).sort((a, b) => b.dateStart - a.dateStart).slice(0, UCDP_MAX_EVENTS);

    const payload = { events: mapped, fetchedAt: Date.now(), version, totalRaw: allEvents.length, filteredCount: mapped.length };
    const ok = await upstashSet(UCDP_REDIS_KEY, payload, UCDP_TTL_SECONDS);
    console.log(`[UCDP] Seeded ${mapped.length} events (raw: ${allEvents.length}, failed pages: ${failedPages}, redis: ${ok ? 'OK' : 'FAIL'})`);
  } catch (e) {
    console.warn('[UCDP] Seed error:', e?.message || e);
  }
}

async function startUcdpSeedLoop() {
  if (!UPSTASH_ENABLED) {
    console.log('[UCDP] Disabled (no Upstash Redis)');
    return;
  }
  console.log(`[UCDP] Seed loop starting (interval ${UCDP_POLL_INTERVAL_MS / 1000 / 60}min, token: ${UCDP_ACCESS_TOKEN ? 'yes' : 'no'})`);
  seedUcdpEvents().catch(e => console.warn('[UCDP] Initial seed error:', e?.message || e));
  setInterval(() => {
    seedUcdpEvents().catch(e => console.warn('[UCDP] Seed error:', e?.message || e));
  }, UCDP_POLL_INTERVAL_MS).unref?.();
}

function gzipSyncBuffer(body) {
  try {
    return zlib.gzipSync(typeof body === 'string' ? Buffer.from(body) : body);
  } catch {
    return null;
  }
}

function getClientIp(req) {
  const xRealIp = req.headers['x-real-ip'];
  if (typeof xRealIp === 'string' && xRealIp.trim()) {
    return xRealIp.trim();
  }
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff) {
    const parts = xff.split(',').map((part) => part.trim()).filter(Boolean);
    // Proxy chain order is client,proxy1,proxy2...; use first hop as client IP.
    if (parts.length > 0) return parts[0];
  }
  return req.socket?.remoteAddress || 'unknown';
}

function safeTokenEquals(provided, expected) {
  const a = Buffer.from(provided || '');
  const b = Buffer.from(expected || '');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function getRelaySecretFromRequest(req) {
  const direct = req.headers[RELAY_AUTH_HEADER];
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    const token = auth.slice(7).trim();
    if (token) return token;
  }
  return '';
}

function isAuthorizedRequest(req) {
  if (!RELAY_SHARED_SECRET) return true;
  const provided = getRelaySecretFromRequest(req);
  if (!provided) return false;
  // Accept either the shared secret (server-to-server) or the WS token (browser HTTP requests).
  if (RELAY_WS_TOKEN && safeTokenEquals(provided, RELAY_WS_TOKEN)) return true;
  return safeTokenEquals(provided, RELAY_SHARED_SECRET);
}

/**
 * Auth check for browser WebSocket connections.
 * Browser WebSocket API cannot set custom headers, so clients pass a token
 * via ?token= query parameter. Checks against RELAY_WS_TOKEN first, then
 * falls back to RELAY_SHARED_SECRET. Skips auth when neither is configured.
 */
function isAuthorizedWsRequest(req) {
  const secret = RELAY_WS_TOKEN || RELAY_SHARED_SECRET;
  if (!secret) return true;
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const provided = url.searchParams.get('token') || '';
  if (!provided) return false;
  return safeTokenEquals(provided, secret);
}

function getRouteGroup(pathname) {
  if (pathname.startsWith('/opensky')) return 'opensky';
  if (pathname.startsWith('/rss')) return 'rss';
  if (pathname.startsWith('/ais/snapshot')) return 'snapshot';
  if (pathname.startsWith('/worldbank')) return 'worldbank';
  if (pathname.startsWith('/polymarket')) return 'polymarket';
  if (pathname.startsWith('/ucdp-events')) return 'ucdp-events';
  if (pathname.startsWith('/oref')) return 'oref';
  if (pathname === '/notam') return 'notam';
  if (pathname === '/bootstrap') return 'bootstrap';
  if (pathname.startsWith('/panel/')) return 'panel';
  if (pathname.startsWith('/map/')) return 'map';
  return 'other';
}

function getRateLimitForPath(pathname) {
  if (pathname.startsWith('/opensky')) return RELAY_OPENSKY_RATE_LIMIT_MAX;
  if (pathname.startsWith('/rss')) return RELAY_RSS_RATE_LIMIT_MAX;
  if (pathname.startsWith('/oref')) return RELAY_OREF_RATE_LIMIT_MAX;
  return RELAY_RATE_LIMIT_MAX;
}

function consumeRateLimit(req, pathname) {
  const maxRequests = getRateLimitForPath(pathname);
  if (!Number.isFinite(maxRequests) || maxRequests <= 0) return { limited: false, limit: 0, remaining: 0, resetInMs: 0 };

  const now = Date.now();
  const ip = getClientIp(req);
  const key = `${getRouteGroup(pathname)}:${ip}`;
  const existing = requestRateBuckets.get(key);
  if (!existing || now >= existing.resetAt) {
    const next = { count: 1, resetAt: now + RELAY_RATE_LIMIT_WINDOW_MS };
    requestRateBuckets.set(key, next);
    return { limited: false, limit: maxRequests, remaining: Math.max(0, maxRequests - 1), resetInMs: next.resetAt - now };
  }

  existing.count += 1;
  const limited = existing.count > maxRequests;
  return {
    limited,
    limit: maxRequests,
    remaining: Math.max(0, maxRequests - existing.count),
    resetInMs: Math.max(0, existing.resetAt - now),
  };
}

function logThrottled(level, key, ...args) {
  const now = Date.now();
  const last = logThrottleState.get(key) || 0;
  if (now - last < RELAY_LOG_THROTTLE_MS) return;
  logThrottleState.set(key, now);
  console[level](...args);
}

const METRICS_WINDOW_SECONDS = Math.max(10, Number(process.env.RELAY_METRICS_WINDOW_SECONDS || 60));
const relayMetricsBuckets = new Map(); // key: unix second -> rolling metrics bucket
const relayMetricsLifetime = {
  openskyRequests: 0,
  openskyCacheHit: 0,
  openskyNegativeHit: 0,
  openskyDedup: 0,
  openskyDedupNeg: 0,
  openskyDedupEmpty: 0,
  openskyMiss: 0,
  openskyUpstreamFetches: 0,
  drops: 0,
};
let relayMetricsQueueMaxLifetime = 0;
let relayMetricsCurrentSec = 0;
let relayMetricsCurrentBucket = null;
let relayMetricsLastPruneSec = 0;

function createRelayMetricsBucket() {
  return {
    openskyRequests: 0,
    openskyCacheHit: 0,
    openskyNegativeHit: 0,
    openskyDedup: 0,
    openskyDedupNeg: 0,
    openskyDedupEmpty: 0,
    openskyMiss: 0,
    openskyUpstreamFetches: 0,
    drops: 0,
    queueMax: 0,
  };
}

function getMetricsNowSec() {
  return Math.floor(Date.now() / 1000);
}

function pruneRelayMetricsBuckets(nowSec = getMetricsNowSec()) {
  const minSec = nowSec - METRICS_WINDOW_SECONDS + 1;
  for (const sec of relayMetricsBuckets.keys()) {
    if (sec < minSec) relayMetricsBuckets.delete(sec);
  }
  if (relayMetricsCurrentSec < minSec) {
    relayMetricsCurrentSec = 0;
    relayMetricsCurrentBucket = null;
  }
}

function getRelayMetricsBucket(nowSec = getMetricsNowSec()) {
  if (nowSec !== relayMetricsLastPruneSec) {
    pruneRelayMetricsBuckets(nowSec);
    relayMetricsLastPruneSec = nowSec;
  }

  if (relayMetricsCurrentBucket && relayMetricsCurrentSec === nowSec) {
    return relayMetricsCurrentBucket;
  }

  let bucket = relayMetricsBuckets.get(nowSec);
  if (!bucket) {
    bucket = createRelayMetricsBucket();
    relayMetricsBuckets.set(nowSec, bucket);
  }
  relayMetricsCurrentSec = nowSec;
  relayMetricsCurrentBucket = bucket;
  return bucket;
}

function incrementRelayMetric(field, amount = 1) {
  const bucket = getRelayMetricsBucket();
  bucket[field] = (bucket[field] || 0) + amount;
  if (Object.prototype.hasOwnProperty.call(relayMetricsLifetime, field)) {
    relayMetricsLifetime[field] += amount;
  }
}

function sampleRelayQueueSize(queueSize) {
  const bucket = getRelayMetricsBucket();
  if (queueSize > bucket.queueMax) bucket.queueMax = queueSize;
  if (queueSize > relayMetricsQueueMaxLifetime) relayMetricsQueueMaxLifetime = queueSize;
}

function safeRatio(numerator, denominator) {
  if (!denominator) return 0;
  return Number((numerator / denominator).toFixed(4));
}

function getRelayRollingMetrics() {
  const nowSec = getMetricsNowSec();
  const minSec = nowSec - METRICS_WINDOW_SECONDS + 1;
  pruneRelayMetricsBuckets(nowSec);

  const rollup = createRelayMetricsBucket();
  for (const [sec, bucket] of relayMetricsBuckets) {
    if (sec < minSec) continue;
    rollup.openskyRequests += bucket.openskyRequests;
    rollup.openskyCacheHit += bucket.openskyCacheHit;
    rollup.openskyNegativeHit += bucket.openskyNegativeHit;
    rollup.openskyDedup += bucket.openskyDedup;
    rollup.openskyDedupNeg += bucket.openskyDedupNeg;
    rollup.openskyDedupEmpty += bucket.openskyDedupEmpty;
    rollup.openskyMiss += bucket.openskyMiss;
    rollup.openskyUpstreamFetches += bucket.openskyUpstreamFetches;
    rollup.drops += bucket.drops;
    if (bucket.queueMax > rollup.queueMax) rollup.queueMax = bucket.queueMax;
  }

  const dedupCount = rollup.openskyDedup + rollup.openskyDedupNeg + rollup.openskyDedupEmpty;
  const cacheServedCount = rollup.openskyCacheHit + rollup.openskyNegativeHit + dedupCount;

  return {
    windowSeconds: METRICS_WINDOW_SECONDS,
    generatedAt: new Date().toISOString(),
    opensky: {
      requests: rollup.openskyRequests,
      hitRatio: safeRatio(cacheServedCount, rollup.openskyRequests),
      dedupRatio: safeRatio(dedupCount, rollup.openskyRequests),
      cacheHits: rollup.openskyCacheHit,
      negativeHits: rollup.openskyNegativeHit,
      dedupHits: dedupCount,
      misses: rollup.openskyMiss,
      upstreamFetches: rollup.openskyUpstreamFetches,
      global429CooldownRemainingMs: Math.max(0, openskyGlobal429Until - Date.now()),
      requestSpacingMs: OPENSKY_REQUEST_SPACING_MS,
    },
    ais: {
      queueMax: rollup.queueMax,
      currentQueue: getUpstreamQueueSize(),
      drops: rollup.drops,
      dropsPerSec: Number((rollup.drops / METRICS_WINDOW_SECONDS).toFixed(4)),
      upstreamPaused,
    },
    lifetime: {
      openskyRequests: relayMetricsLifetime.openskyRequests,
      openskyCacheHit: relayMetricsLifetime.openskyCacheHit,
      openskyNegativeHit: relayMetricsLifetime.openskyNegativeHit,
      openskyDedup: relayMetricsLifetime.openskyDedup + relayMetricsLifetime.openskyDedupNeg + relayMetricsLifetime.openskyDedupEmpty,
      openskyMiss: relayMetricsLifetime.openskyMiss,
      openskyUpstreamFetches: relayMetricsLifetime.openskyUpstreamFetches,
      drops: relayMetricsLifetime.drops,
      queueMax: relayMetricsQueueMaxLifetime,
    },
  };
}

// AIS aggregate state for snapshot API (server-side fanout)
const GRID_SIZE = 2;
const DENSITY_WINDOW = 30 * 60 * 1000; // 30 minutes
const GAP_THRESHOLD = 60 * 60 * 1000; // 1 hour
const SNAPSHOT_INTERVAL_MS = Math.max(2000, Number(process.env.AIS_SNAPSHOT_INTERVAL_MS || 5000));
const CANDIDATE_RETENTION_MS = 2 * 60 * 60 * 1000; // 2 hours
const MAX_DENSITY_ZONES = 200;
const MAX_CANDIDATE_REPORTS = 1500;

const vessels = new Map();
const vesselHistory = new Map();
const densityGrid = new Map();
const candidateReports = new Map();

let snapshotSequence = 0;
let lastSnapshot = null;
let lastSnapshotAt = 0;
// Pre-serialized cache: avoids JSON.stringify + gzip per request
let lastSnapshotJson = null;       // cached JSON string (no candidates)
let lastSnapshotGzip = null;       // cached gzip buffer (no candidates)
let lastSnapshotWithCandJson = null;
let lastSnapshotWithCandGzip = null;

// Chokepoint spatial index: bucket vessels into grid cells at ingest time
// instead of O(chokepoints * vessels) on every snapshot
const chokepointBuckets = new Map(); // key: gridKey -> Set of MMSI
const vesselChokepoints = new Map(); // key: MMSI -> Set of chokepoint names

const CHOKEPOINTS = [
  { name: 'Strait of Hormuz', lat: 26.5, lon: 56.5, radius: 2 },
  { name: 'Suez Canal', lat: 30.0, lon: 32.5, radius: 1 },
  { name: 'Strait of Malacca', lat: 2.5, lon: 101.5, radius: 2 },
  { name: 'Bab el-Mandeb', lat: 12.5, lon: 43.5, radius: 1.5 },
  { name: 'Panama Canal', lat: 9.0, lon: -79.5, radius: 1 },
  { name: 'Taiwan Strait', lat: 24.5, lon: 119.5, radius: 2 },
  { name: 'South China Sea', lat: 15.0, lon: 115.0, radius: 5 },
  { name: 'Black Sea', lat: 43.5, lon: 34.0, radius: 3 },
];

const NAVAL_PREFIX_RE = /^(USS|USNS|HMS|HMAS|HMCS|INS|JS|ROKS|TCG|FS|BNS|RFS|PLAN|PLA|CGC|PNS|KRI|ITS|SNS|MMSI)/i;

function getGridKey(lat, lon) {
  const gridLat = Math.floor(lat / GRID_SIZE) * GRID_SIZE;
  const gridLon = Math.floor(lon / GRID_SIZE) * GRID_SIZE;
  return `${gridLat},${gridLon}`;
}

function isLikelyMilitaryCandidate(meta) {
  const mmsi = String(meta?.MMSI || '');
  const shipType = Number(meta?.ShipType);
  const name = (meta?.ShipName || '').trim().toUpperCase();

  if (Number.isFinite(shipType) && (shipType === 35 || shipType === 55 || (shipType >= 50 && shipType <= 59))) {
    return true;
  }

  if (name && NAVAL_PREFIX_RE.test(name)) return true;

  if (mmsi.length >= 9) {
    const suffix = mmsi.substring(3);
    if (suffix.startsWith('00') || suffix.startsWith('99')) return true;
  }

  return false;
}

function getUpstreamQueueSize() {
  return upstreamQueue.length - upstreamQueueReadIndex;
}

function enqueueUpstreamMessage(raw) {
  upstreamQueue.push(raw);
  sampleRelayQueueSize(getUpstreamQueueSize());
}

function dequeueUpstreamMessage() {
  if (upstreamQueueReadIndex >= upstreamQueue.length) return null;
  const raw = upstreamQueue[upstreamQueueReadIndex++];
  // Compact queue periodically to avoid unbounded sparse arrays.
  if (upstreamQueueReadIndex >= 1024 && upstreamQueueReadIndex * 2 >= upstreamQueue.length) {
    upstreamQueue = upstreamQueue.slice(upstreamQueueReadIndex);
    upstreamQueueReadIndex = 0;
  }
  return raw;
}

function clearUpstreamQueue() {
  upstreamQueue = [];
  upstreamQueueReadIndex = 0;
  upstreamDrainScheduled = false;
  sampleRelayQueueSize(0);
}

function evictMapByTimestamp(map, maxSize, getTimestamp) {
  if (map.size <= maxSize) return;
  const sorted = [...map.entries()].sort((a, b) => {
    const tsA = Number(getTimestamp(a[1])) || 0;
    const tsB = Number(getTimestamp(b[1])) || 0;
    return tsA - tsB;
  });
  const removeCount = map.size - maxSize;
  for (let i = 0; i < removeCount; i++) {
    map.delete(sorted[i][0]);
  }
}

function removeVesselFromChokepoints(mmsi) {
  const previous = vesselChokepoints.get(mmsi);
  if (!previous) return;

  for (const cpName of previous) {
    const bucket = chokepointBuckets.get(cpName);
    if (!bucket) continue;
    bucket.delete(mmsi);
    if (bucket.size === 0) chokepointBuckets.delete(cpName);
  }

  vesselChokepoints.delete(mmsi);
}

function updateVesselChokepoints(mmsi, lat, lon) {
  const next = new Set();
  for (const cp of CHOKEPOINTS) {
    const dlat = lat - cp.lat;
    const dlon = lon - cp.lon;
    if (dlat * dlat + dlon * dlon <= cp.radius * cp.radius) {
      next.add(cp.name);
    }
  }

  const previous = vesselChokepoints.get(mmsi) || new Set();
  for (const cpName of previous) {
    if (next.has(cpName)) continue;
    const bucket = chokepointBuckets.get(cpName);
    if (!bucket) continue;
    bucket.delete(mmsi);
    if (bucket.size === 0) chokepointBuckets.delete(cpName);
  }

  for (const cpName of next) {
    let bucket = chokepointBuckets.get(cpName);
    if (!bucket) {
      bucket = new Set();
      chokepointBuckets.set(cpName, bucket);
    }
    bucket.add(mmsi);
  }

  if (next.size === 0) vesselChokepoints.delete(mmsi);
  else vesselChokepoints.set(mmsi, next);
}

function processRawUpstreamMessage(raw) {
  messageCount++;
  if (messageCount % 5000 === 0) {
    const mem = process.memoryUsage();
    console.log(`[Relay] ${messageCount} msgs, ${clients.size} ws-clients, ${vessels.size} vessels, queue=${getUpstreamQueueSize()}, dropped=${droppedMessages}, rss=${(mem.rss / 1024 / 1024).toFixed(0)}MB heap=${(mem.heapUsed / 1024 / 1024).toFixed(0)}MB, cache: opensky=${openskyResponseCache.size} opensky_neg=${openskyNegativeCache.size} rss_feed=${rssResponseCache.size}`);
  }

  try {
    const parsed = JSON.parse(raw);
    if (parsed?.MessageType === 'PositionReport') {
      processPositionReportForSnapshot(parsed);
    }
  } catch {
    // Ignore malformed upstream payloads
  }

  // Heavily throttled WS fanout: every 50th message only
  // The app primarily uses HTTP snapshot polling, WS is for rare external consumers
  if (clients.size > 0 && messageCount % 50 === 0) {
    const message = raw.toString();
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        // Per-client backpressure: skip if client buffer is backed up
        if (client.bufferedAmount < 1024 * 1024) {
          client.send(message);
        }
      }
    }
  }
}

function processPositionReportForSnapshot(data) {
  const meta = data?.MetaData;
  const pos = data?.Message?.PositionReport;
  if (!meta || !pos) return;

  const mmsi = String(meta.MMSI || '');
  if (!mmsi) return;

  const lat = Number.isFinite(pos.Latitude) ? pos.Latitude : meta.latitude;
  const lon = Number.isFinite(pos.Longitude) ? pos.Longitude : meta.longitude;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

  const now = Date.now();

  vessels.set(mmsi, {
    mmsi,
    name: meta.ShipName || '',
    lat,
    lon,
    timestamp: now,
    shipType: meta.ShipType,
    heading: pos.TrueHeading,
    speed: pos.Sog,
    course: pos.Cog,
  });

  const history = vesselHistory.get(mmsi) || [];
  history.push(now);
  if (history.length > 10) history.shift();
  vesselHistory.set(mmsi, history);

  const gridKey = getGridKey(lat, lon);
  let cell = densityGrid.get(gridKey);
  if (!cell) {
    cell = {
      lat: Math.floor(lat / GRID_SIZE) * GRID_SIZE + GRID_SIZE / 2,
      lon: Math.floor(lon / GRID_SIZE) * GRID_SIZE + GRID_SIZE / 2,
      vessels: new Set(),
      lastUpdate: now,
      previousCount: 0,
    };
    densityGrid.set(gridKey, cell);
  }
  cell.vessels.add(mmsi);
  cell.lastUpdate = now;

  // Maintain exact chokepoint membership so moving vessels don't get "stuck" in old buckets.
  updateVesselChokepoints(mmsi, lat, lon);

  if (isLikelyMilitaryCandidate(meta)) {
    candidateReports.set(mmsi, {
      mmsi,
      name: meta.ShipName || '',
      lat,
      lon,
      shipType: meta.ShipType,
      heading: pos.TrueHeading,
      speed: pos.Sog,
      course: pos.Cog,
      timestamp: now,
    });
  }
}

function cleanupAggregates() {
  const now = Date.now();
  const cutoff = now - DENSITY_WINDOW;

  for (const [mmsi, vessel] of vessels) {
    if (vessel.timestamp < cutoff) {
      vessels.delete(mmsi);
      removeVesselFromChokepoints(mmsi);
    }
  }
  // Hard cap: if still over limit, evict oldest
  if (vessels.size > MAX_VESSELS) {
    const sorted = [...vessels.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
    const toRemove = sorted.slice(0, vessels.size - MAX_VESSELS);
    for (const [mmsi] of toRemove) {
      vessels.delete(mmsi);
      removeVesselFromChokepoints(mmsi);
    }
  }

  for (const [mmsi, history] of vesselHistory) {
    const filtered = history.filter((ts) => ts >= cutoff);
    if (filtered.length === 0) {
      vesselHistory.delete(mmsi);
    } else {
      vesselHistory.set(mmsi, filtered);
    }
  }
  // Hard cap: keep the most recent vessel histories.
  evictMapByTimestamp(vesselHistory, MAX_VESSEL_HISTORY, (history) => history[history.length - 1] || 0);

  for (const [key, cell] of densityGrid) {
    cell.previousCount = cell.vessels.size;

    for (const mmsi of cell.vessels) {
      const vessel = vessels.get(mmsi);
      if (!vessel || vessel.timestamp < cutoff) {
        cell.vessels.delete(mmsi);
      }
    }

    if (cell.vessels.size === 0 && now - cell.lastUpdate > DENSITY_WINDOW * 2) {
      densityGrid.delete(key);
    }
  }
  // Hard cap: keep the most recently updated cells.
  evictMapByTimestamp(densityGrid, MAX_DENSITY_CELLS, (cell) => cell.lastUpdate || 0);

  for (const [mmsi, report] of candidateReports) {
    if (report.timestamp < now - CANDIDATE_RETENTION_MS) {
      candidateReports.delete(mmsi);
    }
  }
  // Hard cap: keep freshest candidate reports.
  evictMapByTimestamp(candidateReports, MAX_CANDIDATE_REPORTS, (report) => report.timestamp || 0);

  // Clean chokepoint buckets: remove stale vessels
  for (const [cpName, bucket] of chokepointBuckets) {
    for (const mmsi of bucket) {
      if (vessels.has(mmsi)) continue;
      bucket.delete(mmsi);
      const memberships = vesselChokepoints.get(mmsi);
      if (memberships) {
        memberships.delete(cpName);
        if (memberships.size === 0) vesselChokepoints.delete(mmsi);
      }
    }
    if (bucket.size === 0) chokepointBuckets.delete(cpName);
  }
}

function detectDisruptions() {
  const disruptions = [];
  const now = Date.now();

  // O(chokepoints) using pre-built spatial buckets instead of O(chokepoints × vessels)
  for (const chokepoint of CHOKEPOINTS) {
    const bucket = chokepointBuckets.get(chokepoint.name);
    const vesselCount = bucket ? bucket.size : 0;

    if (vesselCount >= 5) {
      const normalTraffic = chokepoint.radius * 10;
      const severity = vesselCount > normalTraffic * 1.5
        ? 'high'
        : vesselCount > normalTraffic
          ? 'elevated'
          : 'low';

      disruptions.push({
        id: `chokepoint-${chokepoint.name.toLowerCase().replace(/\s+/g, '-')}`,
        name: chokepoint.name,
        type: 'chokepoint_congestion',
        lat: chokepoint.lat,
        lon: chokepoint.lon,
        severity,
        changePct: normalTraffic > 0 ? Math.round((vesselCount / normalTraffic - 1) * 100) : 0,
        windowHours: 1,
        vesselCount,
        region: chokepoint.name,
        description: `${vesselCount} vessels in ${chokepoint.name}`,
      });
    }
  }

  let darkShipCount = 0;
  for (const history of vesselHistory.values()) {
    if (history.length >= 2) {
      const lastSeen = history[history.length - 1];
      const secondLast = history[history.length - 2];
      if (lastSeen - secondLast > GAP_THRESHOLD && now - lastSeen < 10 * 60 * 1000) {
        darkShipCount++;
      }
    }
  }

  if (darkShipCount >= 1) {
    disruptions.push({
      id: 'global-gap-spike',
      name: 'AIS Gap Spike Detected',
      type: 'gap_spike',
      lat: 0,
      lon: 0,
      severity: darkShipCount > 20 ? 'high' : darkShipCount > 10 ? 'elevated' : 'low',
      changePct: darkShipCount * 10,
      windowHours: 1,
      darkShips: darkShipCount,
      description: `${darkShipCount} vessels returned after extended AIS silence`,
    });
  }

  return disruptions;
}

function calculateDensityZones() {
  const zones = [];
  const allCells = Array.from(densityGrid.values()).filter((c) => c.vessels.size >= 2);
  if (allCells.length === 0) return zones;

  const vesselCounts = allCells.map((c) => c.vessels.size);
  const maxVessels = Math.max(...vesselCounts);
  const minVessels = Math.min(...vesselCounts);

  for (const [key, cell] of densityGrid) {
    if (cell.vessels.size < 2) continue;

    const logMax = Math.log(maxVessels + 1);
    const logMin = Math.log(minVessels + 1);
    const logCurrent = Math.log(cell.vessels.size + 1);

    const intensity = logMax > logMin
      ? 0.2 + (0.8 * (logCurrent - logMin) / (logMax - logMin))
      : 0.5;

    const deltaPct = cell.previousCount > 0
      ? Math.round(((cell.vessels.size - cell.previousCount) / cell.previousCount) * 100)
      : 0;

    zones.push({
      id: `density-${key}`,
      name: `Zone ${key}`,
      lat: cell.lat,
      lon: cell.lon,
      intensity,
      deltaPct,
      shipsPerDay: cell.vessels.size * 48,
      note: cell.vessels.size >= 10 ? 'High traffic area' : undefined,
    });
  }

  return zones
    .sort((a, b) => b.intensity - a.intensity)
    .slice(0, MAX_DENSITY_ZONES);
}

function getCandidateReportsSnapshot() {
  return Array.from(candidateReports.values())
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, MAX_CANDIDATE_REPORTS);
}

function buildSnapshot() {
  const now = Date.now();
  if (lastSnapshot && now - lastSnapshotAt < Math.floor(SNAPSHOT_INTERVAL_MS / 2)) {
    return lastSnapshot;
  }

  cleanupAggregates();
  snapshotSequence++;

  lastSnapshot = {
    sequence: snapshotSequence,
    timestamp: new Date(now).toISOString(),
    status: {
      connected: upstreamSocket?.readyState === WebSocket.OPEN,
      vessels: vessels.size,
      messages: messageCount,
      clients: clients.size,
      droppedMessages,
    },
    disruptions: detectDisruptions(),
    density: calculateDensityZones(),
  };
  lastSnapshotAt = now;

  // Pre-serialize JSON once (avoid per-request JSON.stringify)
  const basePayload = { ...lastSnapshot, candidateReports: [] };
  lastSnapshotJson = JSON.stringify(basePayload);

  const withCandPayload = { ...lastSnapshot, candidateReports: getCandidateReportsSnapshot() };
  lastSnapshotWithCandJson = JSON.stringify(withCandPayload);

  // Pre-gzip both variants asynchronously (zero CPU on request path)
  zlib.gzip(Buffer.from(lastSnapshotJson), (err, buf) => {
    if (!err) lastSnapshotGzip = buf;
  });
  zlib.gzip(Buffer.from(lastSnapshotWithCandJson), (err, buf) => {
    if (!err) lastSnapshotWithCandGzip = buf;
  });

  return lastSnapshot;
}

setInterval(() => {
  if (upstreamSocket?.readyState === WebSocket.OPEN || vessels.size > 0) {
    buildSnapshot();
  }
}, SNAPSHOT_INTERVAL_MS);

// UCDP GED Events cache (persistent in-memory — Railway advantage)
const UCDP_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const UCDP_RELAY_MAX_PAGES = 12;
const UCDP_FETCH_TIMEOUT = 30000; // 30s per page (no Railway limit)

let ucdpCache = { data: null, timestamp: 0 };
let ucdpFetchInProgress = false;

const UCDP_RELAY_VIOLENCE_TYPE_MAP = {
  1: 'state-based',
  2: 'non-state',
  3: 'one-sided',
};

function ucdpParseDateMs(value) {
  if (!value) return NaN;
  return Date.parse(String(value));
}

function ucdpGetMaxDateMs(events) {
  let maxMs = NaN;
  for (const event of events) {
    const ms = ucdpParseDateMs(event?.date_start);
    if (!Number.isFinite(ms)) continue;
    if (!Number.isFinite(maxMs) || ms > maxMs) maxMs = ms;
  }
  return maxMs;
}

function ucdpBuildVersionCandidates() {
  const year = new Date().getFullYear() - 2000;
  return Array.from(new Set([`${year}.1`, `${year - 1}.1`, '25.1', '24.1']));
}

async function ucdpRelayFetchPage(version, page) {
  const url = `https://ucdpapi.pcr.uu.se/api/gedevents/${version}?pagesize=${UCDP_PAGE_SIZE}&page=${page}`;

  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { Accept: 'application/json' }, timeout: UCDP_FETCH_TIMEOUT }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`UCDP API ${res.statusCode} (v${version} p${page})`));
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('UCDP JSON parse error')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('UCDP timeout')); });
  });
}

async function ucdpRelayDiscoverVersion() {
  const candidates = ucdpBuildVersionCandidates();
  for (const version of candidates) {
    try {
      const page0 = await ucdpRelayFetchPage(version, 0);
      if (Array.isArray(page0?.Result)) return { version, page0 };
    } catch { /* next candidate */ }
  }
  throw new Error('No valid UCDP GED version found');
}

async function ucdpFetchAllEvents() {
  const { version, page0 } = await ucdpRelayDiscoverVersion();
  const totalPages = Math.max(1, Number(page0?.TotalPages) || 1);
  const newestPage = totalPages - 1;

  let allEvents = [];
  let latestDatasetMs = NaN;

  for (let offset = 0; offset < UCDP_RELAY_MAX_PAGES && (newestPage - offset) >= 0; offset++) {
    const page = newestPage - offset;
    const rawData = page === 0 ? page0 : await ucdpRelayFetchPage(version, page);
    const events = Array.isArray(rawData?.Result) ? rawData.Result : [];
    allEvents = allEvents.concat(events);

    const pageMaxMs = ucdpGetMaxDateMs(events);
    if (!Number.isFinite(latestDatasetMs) && Number.isFinite(pageMaxMs)) {
      latestDatasetMs = pageMaxMs;
    }
    if (Number.isFinite(latestDatasetMs) && Number.isFinite(pageMaxMs)) {
      if (pageMaxMs < latestDatasetMs - UCDP_TRAILING_WINDOW_MS) break;
    }
    console.log(`[UCDP] Fetched v${version} page ${page} (${events.length} events)`);
  }

  const sanitized = allEvents
    .filter(e => {
      if (!Number.isFinite(latestDatasetMs)) return true;
      const ms = ucdpParseDateMs(e?.date_start);
      return Number.isFinite(ms) && ms >= (latestDatasetMs - UCDP_TRAILING_WINDOW_MS);
    })
    .map(e => ({
      id: String(e.id || ''),
      date_start: e.date_start || '',
      date_end: e.date_end || '',
      latitude: Number(e.latitude) || 0,
      longitude: Number(e.longitude) || 0,
      country: e.country || '',
      side_a: (e.side_a || '').substring(0, 200),
      side_b: (e.side_b || '').substring(0, 200),
      deaths_best: Number(e.best) || 0,
      deaths_low: Number(e.low) || 0,
      deaths_high: Number(e.high) || 0,
      type_of_violence: UCDP_RELAY_VIOLENCE_TYPE_MAP[e.type_of_violence] || 'state-based',
      source_original: (e.source_original || '').substring(0, 300),
    }))
    .sort((a, b) => {
      const bMs = ucdpParseDateMs(b.date_start);
      const aMs = ucdpParseDateMs(a.date_start);
      return (Number.isFinite(bMs) ? bMs : 0) - (Number.isFinite(aMs) ? aMs : 0);
    });

  return {
    success: true,
    count: sanitized.length,
    data: sanitized,
    version,
    cached_at: new Date().toISOString(),
  };
}

async function handleUcdpEventsRequest(req, res) {
  const now = Date.now();

  if (ucdpCache.data && now - ucdpCache.timestamp < UCDP_CACHE_TTL_MS) {
    return sendCompressed(req, res, 200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600',
      'CDN-Cache-Control': 'public, max-age=3600',
      'X-Cache': 'HIT',
    }, JSON.stringify(ucdpCache.data));
  }

  if (ucdpCache.data && !ucdpFetchInProgress) {
    ucdpFetchInProgress = true;
    ucdpFetchAllEvents()
      .then(result => {
        ucdpCache = { data: result, timestamp: Date.now() };
        console.log(`[UCDP] Background refresh: ${result.count} events (v${result.version})`);
      })
      .catch(err => console.error('[UCDP] Background refresh error:', err.message))
      .finally(() => { ucdpFetchInProgress = false; });

    return sendCompressed(req, res, 200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=600',
      'CDN-Cache-Control': 'public, max-age=600',
      'X-Cache': 'STALE',
    }, JSON.stringify(ucdpCache.data));
  }

  if (ucdpFetchInProgress) {
    res.writeHead(202, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, count: 0, data: [], cached_at: '', message: 'Fetch in progress' }));
  }

  try {
    ucdpFetchInProgress = true;
    console.log('[UCDP] Cold fetch starting...');
    const result = await ucdpFetchAllEvents();
    ucdpCache = { data: result, timestamp: Date.now() };
    ucdpFetchInProgress = false;
    console.log(`[UCDP] Cold fetch complete: ${result.count} events (v${result.version})`);

    sendCompressed(req, res, 200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600',
      'CDN-Cache-Control': 'public, max-age=3600',
      'X-Cache': 'MISS',
    }, JSON.stringify(result));
  } catch (err) {
    ucdpFetchInProgress = false;
    console.error('[UCDP] Fetch error:', err.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: err.message, count: 0, data: [] }));
  }
}

// ── Response caches (eliminates ~1.2TB/day OpenSky + ~30GB/day RSS egress) ──
const openskyResponseCache = new Map(); // key: sorted query params → { data, gzip, timestamp }
const openskyNegativeCache = new Map(); // key: cacheKey → { status, timestamp, body, gzip } — prevents retry storms on 429/5xx
const openskyInFlight = new Map(); // key: cacheKey → Promise (dedup concurrent requests)
const OPENSKY_CACHE_TTL_MS = Number(process.env.OPENSKY_CACHE_TTL_MS) || 60 * 1000; // 60s default — env-configurable
const OPENSKY_NEGATIVE_CACHE_TTL_MS = Number(process.env.OPENSKY_NEGATIVE_CACHE_TTL_MS) || 30 * 1000; // 30s — env-configurable
const OPENSKY_CACHE_MAX_ENTRIES = Math.max(10, Number(process.env.OPENSKY_CACHE_MAX_ENTRIES || 128));
const OPENSKY_NEGATIVE_CACHE_MAX_ENTRIES = Math.max(10, Number(process.env.OPENSKY_NEGATIVE_CACHE_MAX_ENTRIES || 256));
const OPENSKY_BBOX_QUANT_STEP = Number.isFinite(Number(process.env.OPENSKY_BBOX_QUANT_STEP))
  ? Math.max(0, Number(process.env.OPENSKY_BBOX_QUANT_STEP)) : 0.01;
const OPENSKY_BBOX_DECIMALS = OPENSKY_BBOX_QUANT_STEP > 0
  ? Math.min(6, ((String(OPENSKY_BBOX_QUANT_STEP).split('.')[1] || '').length || 0))
  : 6;
const OPENSKY_DEDUP_EMPTY_RESPONSE_JSON = JSON.stringify({ states: [], time: 0 });
const OPENSKY_DEDUP_EMPTY_RESPONSE_GZIP = gzipSyncBuffer(OPENSKY_DEDUP_EMPTY_RESPONSE_JSON);
const rssResponseCache = new Map(); // key: feed URL → { data, contentType, timestamp, statusCode }
const rssInFlight = new Map(); // key: feed URL → Promise (dedup concurrent requests)
const RSS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min — RSS feeds rarely update faster
const RSS_NEGATIVE_CACHE_TTL_MS = 60 * 1000; // 1 min — cache failures to prevent thundering herd
const RSS_CACHE_MAX_ENTRIES = 200; // hard cap — ~20 allowed domains × ~5 paths max, with headroom

function setBoundedCacheEntry(cache, key, value, maxEntries) {
  if (!cache.has(key) && cache.size >= maxEntries) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

function touchCacheEntry(cache, key, entry) {
  cache.delete(key);
  cache.set(key, entry);
}

function cacheOpenSkyPositive(cacheKey, data) {
  setBoundedCacheEntry(openskyResponseCache, cacheKey, {
    data,
    gzip: gzipSyncBuffer(data),
    timestamp: Date.now(),
  }, OPENSKY_CACHE_MAX_ENTRIES);
}

function cacheOpenSkyNegative(cacheKey, status) {
  const now = Date.now();
  const body = JSON.stringify({ states: [], time: now });
  setBoundedCacheEntry(openskyNegativeCache, cacheKey, {
    status,
    timestamp: now,
    body,
    gzip: gzipSyncBuffer(body),
  }, OPENSKY_NEGATIVE_CACHE_MAX_ENTRIES);
}

function quantizeCoordinate(value) {
  if (!OPENSKY_BBOX_QUANT_STEP) return value;
  return Math.round(value / OPENSKY_BBOX_QUANT_STEP) * OPENSKY_BBOX_QUANT_STEP;
}

function formatCoordinate(value) {
  return Number(value.toFixed(OPENSKY_BBOX_DECIMALS)).toString();
}

function normalizeOpenSkyBbox(params) {
  const keys = ['lamin', 'lomin', 'lamax', 'lomax'];
  const hasAny = keys.some(k => params.has(k));
  if (!hasAny) {
    return { cacheKey: ',,,', queryParams: [] };
  }
  if (!keys.every(k => params.has(k))) {
    return { error: 'Provide all bbox params: lamin,lomin,lamax,lomax' };
  }

  const values = {};
  for (const key of keys) {
    const raw = params.get(key);
    if (raw === null || raw.trim() === '') return { error: `Invalid ${key} value` };
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return { error: `Invalid ${key} value` };
    values[key] = parsed;
  }

  if (values.lamin < -90 || values.lamax > 90 || values.lomin < -180 || values.lomax > 180) {
    return { error: 'Bbox out of range' };
  }
  if (values.lamin > values.lamax || values.lomin > values.lomax) {
    return { error: 'Invalid bbox ordering' };
  }

  const normalized = {};
  for (const key of keys) normalized[key] = formatCoordinate(quantizeCoordinate(values[key]));
  return {
    cacheKey: keys.map(k => normalized[k]).join(','),
    queryParams: keys.map(k => `${k}=${encodeURIComponent(normalized[k])}`),
  };
}

// OpenSky OAuth2 token cache + mutex to prevent thundering herd
let openskyToken = null;
let openskyTokenExpiry = 0;
let openskyTokenPromise = null; // mutex: single in-flight token request
let openskyAuthCooldownUntil = 0; // backoff after repeated failures
const OPENSKY_AUTH_COOLDOWN_MS = 60000; // 1 min cooldown after auth failure

// Global OpenSky rate limiter — serializes upstream requests and enforces 429 cooldown
let openskyGlobal429Until = 0; // timestamp: block ALL upstream requests until this time
const OPENSKY_429_COOLDOWN_MS = Number(process.env.OPENSKY_429_COOLDOWN_MS) || 90 * 1000; // 90s cooldown after any 429
const OPENSKY_REQUEST_SPACING_MS = Number(process.env.OPENSKY_REQUEST_SPACING_MS) || 2000; // 2s minimum between consecutive upstream requests
let openskyLastUpstreamTime = 0;
let openskyUpstreamQueue = Promise.resolve(); // serial chain — only 1 upstream request at a time

async function getOpenSkyToken() {
  const clientId = process.env.OPENSKY_CLIENT_ID;
  const clientSecret = process.env.OPENSKY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return null;
  }

  // Return cached token if still valid (with 60s buffer)
  if (openskyToken && Date.now() < openskyTokenExpiry - 60000) {
    return openskyToken;
  }

  // Cooldown: don't retry auth if it recently failed (prevents stampede)
  if (Date.now() < openskyAuthCooldownUntil) {
    return null;
  }

  // Mutex: if a token fetch is already in flight, wait for it
  if (openskyTokenPromise) {
    return openskyTokenPromise;
  }

  openskyTokenPromise = _fetchOpenSkyToken(clientId, clientSecret);
  try {
    return await openskyTokenPromise;
  } finally {
    openskyTokenPromise = null;
  }
}

function _attemptOpenSkyTokenFetch(clientId, clientSecret) {
  return new Promise((resolve) => {
    const postData = `grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}`;

    const req = https.request({
      hostname: 'auth.opensky-network.org',
      port: 443,
      family: 4,
      path: '/auth/realms/opensky-network/protocol/openid-connect/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': 'WorldMonitor/1.0',
      },
      timeout: 10000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.access_token) {
            resolve({ token: json.access_token, expiresIn: json.expires_in || 1800 });
          } else {
            resolve({ error: json.error || 'no_access_token', status: res.statusCode });
          }
        } catch (e) {
          resolve({ error: `parse: ${e.message}`, status: res.statusCode });
        }
      });
    });

    req.on('error', (err) => {
      resolve({ error: `${err.code || 'UNKNOWN'}: ${err.message}` });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ error: 'TIMEOUT' });
    });

    req.write(postData);
    req.end();
  });
}

const OPENSKY_AUTH_MAX_RETRIES = 3;
const OPENSKY_AUTH_RETRY_DELAYS = [0, 2000, 5000];

async function _fetchOpenSkyToken(clientId, clientSecret) {
  try {
    for (let attempt = 0; attempt < OPENSKY_AUTH_MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = OPENSKY_AUTH_RETRY_DELAYS[attempt] || 5000;
        console.log(`[Relay] OpenSky auth retry ${attempt + 1}/${OPENSKY_AUTH_MAX_RETRIES} in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        console.log('[Relay] Fetching new OpenSky OAuth2 token...');
      }

      const result = await _attemptOpenSkyTokenFetch(clientId, clientSecret);
      if (result.token) {
        openskyToken = result.token;
        openskyTokenExpiry = Date.now() + result.expiresIn * 1000;
        console.log('[Relay] OpenSky token acquired, expires in', result.expiresIn, 'seconds');
        return openskyToken;
      }
      console.error(`[Relay] OpenSky auth attempt ${attempt + 1} failed:`, result.error, result.status ? `(HTTP ${result.status})` : '');
    }

    openskyAuthCooldownUntil = Date.now() + OPENSKY_AUTH_COOLDOWN_MS;
    console.warn(`[Relay] OpenSky auth failed after ${OPENSKY_AUTH_MAX_RETRIES} attempts, cooling down for ${OPENSKY_AUTH_COOLDOWN_MS / 1000}s`);
    return null;
  } catch (err) {
    console.error('[Relay] OpenSky token error:', err.message);
    openskyAuthCooldownUntil = Date.now() + OPENSKY_AUTH_COOLDOWN_MS;
    return null;
  }
}

// Promisified upstream OpenSky fetch (single request)
function _openskyRawFetch(url, token) {
  return new Promise((resolve) => {
    const request = https.get(url, {
      family: 4,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'WorldMonitor/1.0',
        'Authorization': `Bearer ${token}`,
      },
      timeout: 15000,
    }, (response) => {
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => resolve({ status: response.statusCode || 502, data }));
    });
    request.on('error', (err) => resolve({ status: 0, data: null, error: err }));
    request.on('timeout', () => { request.destroy(); resolve({ status: 504, data: null, error: new Error('timeout') }); });
  });
}

// Serialized queue — ensures only 1 upstream request at a time with minimum spacing.
// Prevents 5 concurrent bbox queries from all getting 429'd.
function openskyQueuedFetch(url, token) {
  const job = openskyUpstreamQueue.then(async () => {
    if (Date.now() < openskyGlobal429Until) {
      return { status: 429, data: JSON.stringify({ states: [], time: Date.now() }), rateLimited: true };
    }
    const wait = OPENSKY_REQUEST_SPACING_MS - (Date.now() - openskyLastUpstreamTime);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    if (Date.now() < openskyGlobal429Until) {
      return { status: 429, data: JSON.stringify({ states: [], time: Date.now() }), rateLimited: true };
    }
    openskyLastUpstreamTime = Date.now();
    return _openskyRawFetch(url, token);
  });
  openskyUpstreamQueue = job.catch(() => {});
  return job;
}

async function handleOpenSkyRequest(req, res, PORT) {
  let cacheKey = '';
  let settleFlight = null;
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const params = url.searchParams;
    const normalizedBbox = normalizeOpenSkyBbox(params);
    if (normalizedBbox.error) {
      return safeEnd(res, 400, { 'Content-Type': 'application/json' }, JSON.stringify({
        error: normalizedBbox.error,
        time: Date.now(),
        states: [],
      }));
    }

    cacheKey = normalizedBbox.cacheKey;
    incrementRelayMetric('openskyRequests');

    // 1. Check positive cache (30s TTL)
    const cached = openskyResponseCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < OPENSKY_CACHE_TTL_MS) {
      incrementRelayMetric('openskyCacheHit');
      touchCacheEntry(openskyResponseCache, cacheKey, cached); // LRU
      return sendPreGzipped(req, res, 200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=30',
        'CDN-Cache-Control': 'public, max-age=15',
        'X-Cache': 'HIT',
      }, cached.data, cached.gzip);
    }

    // 2. Check negative cache — prevents retry storms when upstream returns 429/5xx
    const negCached = openskyNegativeCache.get(cacheKey);
    if (negCached && Date.now() - negCached.timestamp < OPENSKY_NEGATIVE_CACHE_TTL_MS) {
      incrementRelayMetric('openskyNegativeHit');
      touchCacheEntry(openskyNegativeCache, cacheKey, negCached); // LRU
      return sendPreGzipped(req, res, 200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'CDN-Cache-Control': 'no-store',
        'X-Cache': 'NEG',
      }, negCached.body, negCached.gzip);
    }

    // 2b. Global 429 cooldown — blocks ALL bbox queries when OpenSky is rate-limiting.
    //     Without this, 5 unique bbox keys all fire simultaneously when neg cache expires,
    //     ALL get 429'd, and the cycle repeats forever with zero data flowing.
    if (Date.now() < openskyGlobal429Until) {
      incrementRelayMetric('openskyNegativeHit');
      cacheOpenSkyNegative(cacheKey, 429);
      return sendCompressed(req, res, 200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'CDN-Cache-Control': 'no-store',
        'X-Cache': 'RATE-LIMITED',
      }, JSON.stringify({ states: [], time: Date.now() }));
    }

    // 3. Dedup concurrent requests — await in-flight and return result OR empty (never fall through)
    const existing = openskyInFlight.get(cacheKey);
    if (existing) {
      try {
        await existing;
      } catch { /* in-flight failed */ }
      const deduped = openskyResponseCache.get(cacheKey);
      if (deduped && Date.now() - deduped.timestamp < OPENSKY_CACHE_TTL_MS) {
        incrementRelayMetric('openskyDedup');
        touchCacheEntry(openskyResponseCache, cacheKey, deduped); // LRU
        return sendPreGzipped(req, res, 200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=30',
          'CDN-Cache-Control': 'public, max-age=15',
          'X-Cache': 'DEDUP',
        }, deduped.data, deduped.gzip);
      }
      const dedupNeg = openskyNegativeCache.get(cacheKey);
      if (dedupNeg && Date.now() - dedupNeg.timestamp < OPENSKY_NEGATIVE_CACHE_TTL_MS) {
        incrementRelayMetric('openskyDedupNeg');
        touchCacheEntry(openskyNegativeCache, cacheKey, dedupNeg); // LRU
        return sendPreGzipped(req, res, 200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
          'CDN-Cache-Control': 'no-store',
          'X-Cache': 'DEDUP-NEG',
        }, dedupNeg.body, dedupNeg.gzip);
      }
      // In-flight completed but no cache entry (upstream failed) — return empty instead of thundering herd
      incrementRelayMetric('openskyDedupEmpty');
      return sendPreGzipped(req, res, 200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'CDN-Cache-Control': 'no-store',
        'X-Cache': 'DEDUP-EMPTY',
      }, OPENSKY_DEDUP_EMPTY_RESPONSE_JSON, OPENSKY_DEDUP_EMPTY_RESPONSE_GZIP);
    }

    incrementRelayMetric('openskyMiss');

    // 4. Set in-flight BEFORE async token fetch to prevent race window
    let resolveFlight;
    let flightSettled = false;
    const flightPromise = new Promise((resolve) => { resolveFlight = resolve; });
    settleFlight = () => {
      if (flightSettled) return;
      flightSettled = true;
      resolveFlight();
    };
    openskyInFlight.set(cacheKey, flightPromise);

    const token = await getOpenSkyToken();
    if (!token) {
      // Do NOT negative-cache auth failures — they poison ALL bbox keys.
      // Only negative-cache actual upstream 429/5xx responses.
      settleFlight();
      openskyInFlight.delete(cacheKey);
      return safeEnd(res, 503, { 'Content-Type': 'application/json' },
        JSON.stringify({ error: 'OpenSky not configured or auth failed', time: Date.now(), states: [] }));
    }

    let openskyUrl = 'https://opensky-network.org/api/states/all';
    if (normalizedBbox.queryParams.length > 0) {
      openskyUrl += '?' + normalizedBbox.queryParams.join('&');
    }

    logThrottled('log', `opensky-miss:${cacheKey}`, '[Relay] OpenSky request (MISS):', openskyUrl);
    incrementRelayMetric('openskyUpstreamFetches');

    // Serialized fetch — queued with spacing to prevent concurrent 429 storms
    const result = await openskyQueuedFetch(openskyUrl, token);
    const upstreamStatus = result.status || 502;

    if (upstreamStatus === 401) {
      openskyToken = null;
      openskyTokenExpiry = 0;
    }

    if (upstreamStatus === 429 && !result.rateLimited) {
      openskyGlobal429Until = Date.now() + OPENSKY_429_COOLDOWN_MS;
      console.warn(`[Relay] OpenSky 429 — global cooldown ${OPENSKY_429_COOLDOWN_MS / 1000}s (all bbox queries blocked)`);
    }

    if (upstreamStatus === 200 && result.data) {
      cacheOpenSkyPositive(cacheKey, result.data);
      openskyNegativeCache.delete(cacheKey);
    } else if (result.error) {
      logThrottled('error', `opensky-error:${cacheKey}:${result.error.code || result.error.message}`, '[Relay] OpenSky error:', result.error.message);
      cacheOpenSkyNegative(cacheKey, upstreamStatus || 500);
    } else {
      cacheOpenSkyNegative(cacheKey, upstreamStatus);
      logThrottled('warn', `opensky-upstream-${upstreamStatus}:${cacheKey}`,
        `[Relay] OpenSky upstream ${upstreamStatus} for ${openskyUrl}, negative-cached for ${OPENSKY_NEGATIVE_CACHE_TTL_MS / 1000}s`);
    }

    settleFlight();
    openskyInFlight.delete(cacheKey);

    // Serve stale cache on network errors
    if (result.error && cached) {
      return sendPreGzipped(req, res, 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'CDN-Cache-Control': 'no-store', 'X-Cache': 'STALE' }, cached.data, cached.gzip);
    }

    const responseData = result.data || JSON.stringify({ error: result.error?.message || 'upstream error', time: Date.now(), states: null });
    return sendCompressed(req, res, upstreamStatus, {
      'Content-Type': 'application/json',
      'Cache-Control': upstreamStatus === 200 ? 'public, max-age=30' : 'no-cache',
      'CDN-Cache-Control': upstreamStatus === 200 ? 'public, max-age=15' : 'no-store',
      'X-Cache': result.rateLimited ? 'RATE-LIMITED' : 'MISS',
    }, responseData);
  } catch (err) {
    if (settleFlight) settleFlight();
    if (!cacheKey) {
      try {
        const params = new URL(req.url, `http://localhost:${PORT}`).searchParams;
        cacheKey = normalizeOpenSkyBbox(params).cacheKey || ',,,';
      } catch {
        cacheKey = ',,,';
      }
    }
    openskyInFlight.delete(cacheKey);
    safeEnd(res, 500, { 'Content-Type': 'application/json' },
      JSON.stringify({ error: err.message, time: Date.now(), states: null }));
  }
}

// ── World Bank proxy (World Bank blocks Vercel edge IPs with 403) ──
const worldbankCache = new Map(); // key: query string → { data, timestamp }
const WORLDBANK_CACHE_TTL_MS = 30 * 60 * 1000; // 30 min — data rarely changes

function handleWorldBankRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const qs = url.search || '';
  const cacheKey = qs;

  const cached = worldbankCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < WORLDBANK_CACHE_TTL_MS) {
    return sendCompressed(req, res, 200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=1800',
      'CDN-Cache-Control': 'public, max-age=1800',
      'X-Cache': 'HIT',
    }, cached.data);
  }

  const targetUrl = `https://api.worldbank.org/v2${qs.includes('action=indicators') ? '' : '/country'}${url.pathname.replace('/worldbank', '')}${qs}`;
  // Passthrough: forward query params to the Vercel edge handler format
  // The client sends the same params as /api/worldbank, so we re-fetch from upstream
  const wbParams = new URLSearchParams(url.searchParams);
  const action = wbParams.get('action');

  if (action === 'indicators') {
    // Static response — return indicator list directly (same as api/worldbank.js)
    const indicators = {
      'IT.NET.USER.ZS': 'Internet Users (% of population)',
      'IT.CEL.SETS.P2': 'Mobile Subscriptions (per 100 people)',
      'IT.NET.BBND.P2': 'Fixed Broadband Subscriptions (per 100 people)',
      'IT.NET.SECR.P6': 'Secure Internet Servers (per million people)',
      'GB.XPD.RSDV.GD.ZS': 'R&D Expenditure (% of GDP)',
      'IP.PAT.RESD': 'Patent Applications (residents)',
      'IP.PAT.NRES': 'Patent Applications (non-residents)',
      'IP.TMK.TOTL': 'Trademark Applications',
      'TX.VAL.TECH.MF.ZS': 'High-Tech Exports (% of manufactured exports)',
      'BX.GSR.CCIS.ZS': 'ICT Service Exports (% of service exports)',
      'TM.VAL.ICTG.ZS.UN': 'ICT Goods Imports (% of total goods imports)',
      'SE.TER.ENRR': 'Tertiary Education Enrollment (%)',
      'SE.XPD.TOTL.GD.ZS': 'Education Expenditure (% of GDP)',
      'NY.GDP.MKTP.KD.ZG': 'GDP Growth (annual %)',
      'NY.GDP.PCAP.CD': 'GDP per Capita (current US$)',
      'NE.EXP.GNFS.ZS': 'Exports of Goods & Services (% of GDP)',
    };
    const defaultCountries = [
      'USA','CHN','JPN','DEU','KOR','GBR','IND','ISR','SGP','TWN',
      'FRA','CAN','SWE','NLD','CHE','FIN','IRL','AUS','BRA','IDN',
      'ARE','SAU','QAT','BHR','EGY','TUR','MYS','THA','VNM','PHL',
      'ESP','ITA','POL','CZE','DNK','NOR','AUT','BEL','PRT','EST',
      'MEX','ARG','CHL','COL','ZAF','NGA','KEN',
    ];
    const body = JSON.stringify({ indicators, defaultCountries });
    worldbankCache.set(cacheKey, { data: body, timestamp: Date.now() });
    return sendCompressed(req, res, 200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=86400',
      'CDN-Cache-Control': 'public, max-age=86400',
      'X-Cache': 'MISS',
    }, body);
  }

  const indicator = wbParams.get('indicator');
  if (!indicator) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Missing indicator parameter' }));
  }

  const country = wbParams.get('country');
  const countries = wbParams.get('countries');
  const years = parseInt(wbParams.get('years') || '5', 10);
  let countryList = country || (countries ? countries.split(',').join(';') : [
    'USA','CHN','JPN','DEU','KOR','GBR','IND','ISR','SGP','TWN',
    'FRA','CAN','SWE','NLD','CHE','FIN','IRL','AUS','BRA','IDN',
    'ARE','SAU','QAT','BHR','EGY','TUR','MYS','THA','VNM','PHL',
    'ESP','ITA','POL','CZE','DNK','NOR','AUT','BEL','PRT','EST',
    'MEX','ARG','CHL','COL','ZAF','NGA','KEN',
  ].join(';'));

  const currentYear = new Date().getFullYear();
  const startYear = currentYear - years;
  const TECH_INDICATORS = {
    'IT.NET.USER.ZS': 'Internet Users (% of population)',
    'IT.CEL.SETS.P2': 'Mobile Subscriptions (per 100 people)',
    'IT.NET.BBND.P2': 'Fixed Broadband Subscriptions (per 100 people)',
    'IT.NET.SECR.P6': 'Secure Internet Servers (per million people)',
    'GB.XPD.RSDV.GD.ZS': 'R&D Expenditure (% of GDP)',
    'IP.PAT.RESD': 'Patent Applications (residents)',
    'IP.PAT.NRES': 'Patent Applications (non-residents)',
    'IP.TMK.TOTL': 'Trademark Applications',
    'TX.VAL.TECH.MF.ZS': 'High-Tech Exports (% of manufactured exports)',
    'BX.GSR.CCIS.ZS': 'ICT Service Exports (% of service exports)',
    'TM.VAL.ICTG.ZS.UN': 'ICT Goods Imports (% of total goods imports)',
    'SE.TER.ENRR': 'Tertiary Education Enrollment (%)',
    'SE.XPD.TOTL.GD.ZS': 'Education Expenditure (% of GDP)',
    'NY.GDP.MKTP.KD.ZG': 'GDP Growth (annual %)',
    'NY.GDP.PCAP.CD': 'GDP per Capita (current US$)',
    'NE.EXP.GNFS.ZS': 'Exports of Goods & Services (% of GDP)',
  };

  const wbUrl = `https://api.worldbank.org/v2/country/${countryList}/indicator/${encodeURIComponent(indicator)}?format=json&date=${startYear}:${currentYear}&per_page=1000`;

  console.log('[Relay] World Bank request (MISS):', indicator);

  const request = https.get(wbUrl, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; WorldMonitor/1.0; +https://worldmonitor.app)',
    },
    timeout: 15000,
  }, (response) => {
    if (response.statusCode !== 200) {
      safeEnd(res, response.statusCode, { 'Content-Type': 'application/json' }, JSON.stringify({ error: `World Bank API ${response.statusCode}` }));
      return;
    }
    let rawData = '';
    response.on('data', chunk => rawData += chunk);
    response.on('end', () => {
      try {
        const parsed = JSON.parse(rawData);
        // Transform raw World Bank response to match client-expected format
        if (!parsed || !Array.isArray(parsed) || parsed.length < 2 || !parsed[1]) {
          const empty = JSON.stringify({
            indicator,
            indicatorName: TECH_INDICATORS[indicator] || indicator,
            metadata: { page: 1, pages: 1, total: 0 },
            byCountry: {}, latestByCountry: {}, timeSeries: [],
          });
          worldbankCache.set(cacheKey, { data: empty, timestamp: Date.now() });
          return sendCompressed(req, res, 200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=1800',
            'CDN-Cache-Control': 'public, max-age=1800',
            'X-Cache': 'MISS',
          }, empty);
        }

        const [metadata, records] = parsed;
        const transformed = {
          indicator,
          indicatorName: TECH_INDICATORS[indicator] || (records[0]?.indicator?.value || indicator),
          metadata: { page: metadata.page, pages: metadata.pages, total: metadata.total },
          byCountry: {}, latestByCountry: {}, timeSeries: [],
        };

        for (const record of records || []) {
          const cc = record.countryiso3code || record.country?.id;
          const cn = record.country?.value;
          const yr = record.date;
          const val = record.value;
          if (!cc || val === null) continue;
          if (!transformed.byCountry[cc]) transformed.byCountry[cc] = { code: cc, name: cn, values: [] };
          transformed.byCountry[cc].values.push({ year: yr, value: val });
          if (!transformed.latestByCountry[cc] || yr > transformed.latestByCountry[cc].year) {
            transformed.latestByCountry[cc] = { code: cc, name: cn, year: yr, value: val };
          }
          transformed.timeSeries.push({ countryCode: cc, countryName: cn, year: yr, value: val });
        }
        for (const c of Object.values(transformed.byCountry)) c.values.sort((a, b) => a.year - b.year);
        transformed.timeSeries.sort((a, b) => b.year - a.year || a.countryCode.localeCompare(b.countryCode));

        const body = JSON.stringify(transformed);
        worldbankCache.set(cacheKey, { data: body, timestamp: Date.now() });
        sendCompressed(req, res, 200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=1800',
          'CDN-Cache-Control': 'public, max-age=1800',
          'X-Cache': 'MISS',
        }, body);
      } catch (e) {
        console.error('[Relay] World Bank parse error:', e.message);
        safeEnd(res, 500, { 'Content-Type': 'application/json' }, JSON.stringify({ error: 'Parse error' }));
      }
    });
  });
  request.on('error', (err) => {
    console.error('[Relay] World Bank error:', err.message);
    if (cached) {
      return sendCompressed(req, res, 200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'CDN-Cache-Control': 'no-store',
        'X-Cache': 'STALE',
      }, cached.data);
    }
    safeEnd(res, 502, { 'Content-Type': 'application/json' }, JSON.stringify({ error: err.message }));
  });
  request.on('timeout', () => {
    request.destroy();
    if (cached) {
      return sendCompressed(req, res, 200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'CDN-Cache-Control': 'no-store',
        'X-Cache': 'STALE',
      }, cached.data);
    }
    safeEnd(res, 504, { 'Content-Type': 'application/json' }, JSON.stringify({ error: 'World Bank request timeout' }));
  });
}

// ── Polymarket proxy (Cloudflare JA3 blocks Vercel edge runtime) ──
const POLYMARKET_ENABLED = String(process.env.POLYMARKET_ENABLED || 'true').toLowerCase() !== 'false';
const polymarketCache = new Map(); // key: query string → { data, timestamp }
const polymarketInflight = new Map(); // key → Promise (dedup concurrent requests)
const POLYMARKET_CACHE_TTL_MS = 10 * 60 * 1000; // 10 min — reduce upstream pressure
const POLYMARKET_NEG_TTL_MS = 5 * 60 * 1000; // 5 min negative cache on 429/error

// Circuit breaker — stops upstream requests after repeated failures to prevent OOM
const polymarketCircuitBreaker = { failures: 0, openUntil: 0 };
const POLYMARKET_CB_THRESHOLD = 5;
const POLYMARKET_CB_COOLDOWN_MS = 60 * 1000;

// Concurrent upstream limiter — queues excess requests instead of rejecting them
const POLYMARKET_MAX_CONCURRENT = 3;
const POLYMARKET_MAX_QUEUED = 20;
let polymarketActiveUpstream = 0;
const polymarketQueue = []; // Array of () => void (resolve-waiters)

function tripPolymarketCircuitBreaker() {
  polymarketCircuitBreaker.failures++;
  if (polymarketCircuitBreaker.failures >= POLYMARKET_CB_THRESHOLD) {
    polymarketCircuitBreaker.openUntil = Date.now() + POLYMARKET_CB_COOLDOWN_MS;
    console.error(`[Relay] Polymarket circuit OPEN — cooling down ${POLYMARKET_CB_COOLDOWN_MS / 1000}s`);
  }
}

function releasePolymarketSlot() {
  polymarketActiveUpstream--;
  if (polymarketQueue.length > 0) {
    const next = polymarketQueue.shift();
    polymarketActiveUpstream++;
    next();
  }
}

function acquirePolymarketSlot() {
  if (polymarketActiveUpstream < POLYMARKET_MAX_CONCURRENT) {
    polymarketActiveUpstream++;
    return Promise.resolve();
  }
  if (polymarketQueue.length >= POLYMARKET_MAX_QUEUED) {
    return Promise.reject(new Error('queue full'));
  }
  return new Promise((resolve) => { polymarketQueue.push(resolve); });
}

function fetchPolymarketUpstream(cacheKey, endpoint, params, tag) {
  return acquirePolymarketSlot().catch(() => 'REJECTED').then((slotResult) => {
    if (slotResult === 'REJECTED') {
      polymarketCache.set(cacheKey, { data: '[]', timestamp: Date.now() - POLYMARKET_CACHE_TTL_MS + POLYMARKET_NEG_TTL_MS });
      return null;
    }
    const gammaUrl = `https://gamma-api.polymarket.com/${endpoint}?${params}`;
    console.log('[Relay] Polymarket request (MISS):', endpoint, tag || '');

    return new Promise((resolve) => {
      let finalized = false;
      function finalize(ok) {
        if (finalized) return;
        finalized = true;
        releasePolymarketSlot();
        if (ok) {
          polymarketCircuitBreaker.failures = 0;
        } else {
          tripPolymarketCircuitBreaker();
          polymarketCache.set(cacheKey, { data: '[]', timestamp: Date.now() - POLYMARKET_CACHE_TTL_MS + POLYMARKET_NEG_TTL_MS });
        }
      }
      const request = https.get(gammaUrl, {
        headers: { 'Accept': 'application/json' },
        timeout: 10000,
      }, (response) => {
        if (response.statusCode !== 200) {
          console.error(`[Relay] Polymarket upstream ${response.statusCode} (failures: ${polymarketCircuitBreaker.failures + 1})`);
          response.resume();
          finalize(false);
          resolve(null);
          return;
        }
        let data = '';
        response.on('data', chunk => data += chunk);
        response.on('end', () => {
          finalize(true);
          polymarketCache.set(cacheKey, { data, timestamp: Date.now() });
          resolve(data);
        });
        response.on('error', () => { finalize(false); resolve(null); });
      });
      request.on('error', (err) => {
        console.error('[Relay] Polymarket error:', err.message);
        finalize(false);
        resolve(null);
      });
      request.on('timeout', () => {
        request.destroy();
        finalize(false);
        resolve(null);
      });
    });
  });
}

function handlePolymarketRequest(req, res) {
  if (!POLYMARKET_ENABLED) {
    return sendCompressed(req, res, 503, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    }, JSON.stringify({ error: 'polymarket disabled', reason: 'POLYMARKET_ENABLED=false' }));
  }
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Build canonical params FIRST so cache key is deterministic regardless of
  // query-string ordering, tag vs tag_slug alias, or varying limit values.
  // Cache key excludes limit — always fetch upstream with limit=50, slice on serve.
  // This prevents cache fragmentation from different callers (limit=20 vs limit=30).
  const endpoint = url.searchParams.get('endpoint') || 'markets';
  const requestedLimit = Math.max(1, Math.min(100, parseInt(url.searchParams.get('limit') || '50', 10) || 50));
  const upstreamLimit = 50; // canonical upstream limit for cache sharing
  const params = new URLSearchParams();
  params.set('closed', url.searchParams.get('closed') || 'false');
  params.set('order', url.searchParams.get('order') || 'volume');
  params.set('ascending', url.searchParams.get('ascending') || 'false');
  params.set('limit', String(upstreamLimit));
  const tag = url.searchParams.get('tag') || url.searchParams.get('tag_slug');
  if (tag && endpoint === 'events') params.set('tag_slug', tag.replace(/[^a-z0-9-]/gi, '').slice(0, 100));

  const cacheKey = endpoint + ':' + params.toString();

  function sliceToLimit(jsonStr) {
    if (requestedLimit >= upstreamLimit) return jsonStr;
    try {
      const arr = JSON.parse(jsonStr);
      if (!Array.isArray(arr)) return jsonStr;
      return JSON.stringify(arr.slice(0, requestedLimit));
    } catch { return jsonStr; }
  }

  const cached = polymarketCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < POLYMARKET_CACHE_TTL_MS) {
    return sendCompressed(req, res, 200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=600',
      'CDN-Cache-Control': 'public, max-age=600',
      'X-Cache': 'HIT',
      'X-Polymarket-Source': 'railway-cache',
    }, sliceToLimit(cached.data));
  }

  // Circuit breaker open — serve stale cache or empty, skip upstream
  if (Date.now() < polymarketCircuitBreaker.openUntil) {
    if (cached) {
      return sendCompressed(req, res, 200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Cache': 'STALE',
        'X-Circuit': 'OPEN',
        'X-Polymarket-Source': 'railway-stale',
      }, cached.data);
    }
    return safeEnd(res, 200, { 'Content-Type': 'application/json', 'X-Circuit': 'OPEN' }, JSON.stringify([]));
  }

  let inflight = polymarketInflight.get(cacheKey);
  if (!inflight) {
    inflight = fetchPolymarketUpstream(cacheKey, endpoint, params, tag).finally(() => {
      polymarketInflight.delete(cacheKey);
    });
    polymarketInflight.set(cacheKey, inflight);
  }

  inflight.then((data) => {
    if (data) {
      sendCompressed(req, res, 200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=600',
        'CDN-Cache-Control': 'public, max-age=600',
        'X-Cache': 'MISS',
        'X-Polymarket-Source': 'railway',
      }, sliceToLimit(data));
    } else if (cached) {
      sendCompressed(req, res, 200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'CDN-Cache-Control': 'no-store',
        'X-Cache': 'STALE',
        'X-Polymarket-Source': 'railway-stale',
      }, sliceToLimit(cached.data));
    } else {
      safeEnd(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify([]));
    }
  });
}

// Periodic cache cleanup to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of openskyResponseCache) {
    if (now - entry.timestamp > OPENSKY_CACHE_TTL_MS * 2) openskyResponseCache.delete(key);
  }
  for (const [key, entry] of openskyNegativeCache) {
    if (now - entry.timestamp > OPENSKY_NEGATIVE_CACHE_TTL_MS * 2) openskyNegativeCache.delete(key);
  }
  for (const [key, entry] of rssResponseCache) {
    const maxAge = (entry.statusCode && entry.statusCode >= 200 && entry.statusCode < 300)
      ? RSS_CACHE_TTL_MS * 2 : RSS_NEGATIVE_CACHE_TTL_MS * 2;
    if (now - entry.timestamp > maxAge) rssResponseCache.delete(key);
  }
  for (const [key, entry] of worldbankCache) {
    if (now - entry.timestamp > WORLDBANK_CACHE_TTL_MS * 2) worldbankCache.delete(key);
  }
  for (const [key, entry] of polymarketCache) {
    if (now - entry.timestamp > POLYMARKET_CACHE_TTL_MS * 2) polymarketCache.delete(key);
  }
  for (const [key, bucket] of requestRateBuckets) {
    if (now >= bucket.resetAt + RELAY_RATE_LIMIT_WINDOW_MS * 2) requestRateBuckets.delete(key);
  }
  for (const [key, ts] of logThrottleState) {
    if (now - ts > RELAY_LOG_THROTTLE_MS * 6) logThrottleState.delete(key);
  }
}, 60 * 1000);

// ── YouTube Live Detection (residential proxy bypass) ──────────────
const YOUTUBE_PROXY_URL = process.env.YOUTUBE_PROXY_URL || '';
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

function parseProxyUrl(proxyUrl) {
  if (!proxyUrl) return null;
  try {
    const u = new URL(proxyUrl);
    return {
      host: u.hostname,
      port: parseInt(u.port, 10),
      auth: u.username ? `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}` : null,
    };
  } catch { return null; }
}

function ytFetchViaProxy(targetUrl, proxy) {
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl);
    const connectOpts = {
      host: proxy.host, port: proxy.port, method: 'CONNECT',
      path: `${target.hostname}:443`, headers: {},
    };
    if (proxy.auth) {
      connectOpts.headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(proxy.auth).toString('base64');
    }
    const connectReq = http.request(connectOpts);
    connectReq.on('connect', (_res, socket) => {
      const req = https.request({
        hostname: target.hostname,
        path: target.pathname + target.search,
        method: 'GET',
        headers: { 'User-Agent': CHROME_UA, 'Accept-Encoding': 'gzip, deflate' },
        socket, agent: false,
      }, (res) => {
        let stream = res;
        const enc = (res.headers['content-encoding'] || '').trim().toLowerCase();
        if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
        const chunks = [];
        stream.on('data', (c) => chunks.push(c));
        stream.on('end', () => resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          body: Buffer.concat(chunks).toString(),
        }));
        stream.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
    connectReq.on('error', reject);
    connectReq.setTimeout(12000, () => { connectReq.destroy(); reject(new Error('Proxy timeout')); });
    connectReq.end();
  });
}

function ytFetchDirect(targetUrl) {
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl);
    const req = https.request({
      hostname: target.hostname,
      path: target.pathname + target.search,
      method: 'GET',
      headers: { 'User-Agent': CHROME_UA, 'Accept-Encoding': 'gzip, deflate' },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return ytFetchDirect(res.headers.location).then(resolve, reject);
      }
      let stream = res;
      const enc = (res.headers['content-encoding'] || '').trim().toLowerCase();
      if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        body: Buffer.concat(chunks).toString(),
      }));
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('YouTube timeout')); });
    req.end();
  });
}

async function ytFetch(url) {
  const proxy = parseProxyUrl(YOUTUBE_PROXY_URL);
  if (proxy) {
    try { return await ytFetchViaProxy(url, proxy); } catch { /* fall through */ }
  }
  return ytFetchDirect(url);
}

const ytLiveCache = new Map();
const YT_CACHE_TTL = 5 * 60 * 1000;

function handleYouTubeLiveRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const channel = url.searchParams.get('channel');
  const videoIdParam = url.searchParams.get('videoId');

  if (videoIdParam && /^[A-Za-z0-9_-]{11}$/.test(videoIdParam)) {
    const cacheKey = `vid:${videoIdParam}`;
    const cached = ytLiveCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < 3600000) {
      return sendCompressed(req, res, 200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' }, cached.json);
    }
    ytFetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoIdParam}&format=json`)
      .then(r => {
        if (r.ok) {
          try {
            const data = JSON.parse(r.body);
            const json = JSON.stringify({ channelName: data.author_name || null, title: data.title || null, videoId: videoIdParam });
            ytLiveCache.set(cacheKey, { json, ts: Date.now() });
            return sendCompressed(req, res, 200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' }, json);
          } catch {}
        }
        sendCompressed(req, res, 200, { 'Content-Type': 'application/json' },
          JSON.stringify({ channelName: null, title: null, videoId: videoIdParam }));
      })
      .catch(() => {
        sendCompressed(req, res, 200, { 'Content-Type': 'application/json' },
          JSON.stringify({ channelName: null, title: null, videoId: videoIdParam }));
      });
    return;
  }

  if (!channel) {
    return sendCompressed(req, res, 400, { 'Content-Type': 'application/json' },
      JSON.stringify({ error: 'Missing channel parameter' }));
  }

  const channelHandle = channel.startsWith('@') ? channel : `@${channel}`;
  const cacheKey = `ch:${channelHandle}`;
  const cached = ytLiveCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < YT_CACHE_TTL) {
    return sendCompressed(req, res, 200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=60',
    }, cached.json);
  }

  const liveUrl = `https://www.youtube.com/${channelHandle}/live`;
  ytFetch(liveUrl)
    .then(r => {
      if (!r.ok) {
        return sendCompressed(req, res, 200, { 'Content-Type': 'application/json' },
          JSON.stringify({ videoId: null, channelExists: false }));
      }
      const html = r.body;
      const channelExists = html.includes('"channelId"') || html.includes('og:url');
      let channelName = null;
      const ownerMatch = html.match(/"ownerChannelName"\s*:\s*"([^"]+)"/);
      if (ownerMatch) channelName = ownerMatch[1];
      else { const am = html.match(/"author"\s*:\s*"([^"]+)"/); if (am) channelName = am[1]; }

      let videoId = null;
      const detailsIdx = html.indexOf('"videoDetails"');
      if (detailsIdx !== -1) {
        const block = html.substring(detailsIdx, detailsIdx + 5000);
        const vidMatch = block.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
        const liveMatch = block.match(/"isLive"\s*:\s*true/);
        if (vidMatch && liveMatch) videoId = vidMatch[1];
      }

      let hlsUrl = null;
      const hlsMatch = html.match(/"hlsManifestUrl"\s*:\s*"([^"]+)"/);
      if (hlsMatch && videoId) hlsUrl = hlsMatch[1].replace(/\\u0026/g, '&');

      const json = JSON.stringify({ videoId, isLive: videoId !== null, channelExists, channelName, hlsUrl });
      ytLiveCache.set(cacheKey, { json, ts: Date.now() });
      sendCompressed(req, res, 200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=60',
      }, json);
    })
    .catch(err => {
      console.error('[Relay] YouTube live check error:', err.message);
      sendCompressed(req, res, 200, { 'Content-Type': 'application/json' },
        JSON.stringify({ videoId: null, error: err.message }));
    });
}

// Periodic cleanup for YouTube cache
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of ytLiveCache) {
    const ttl = key.startsWith('vid:') ? 3600000 : YT_CACHE_TTL;
    if (now - val.ts > ttl * 2) ytLiveCache.delete(key);
  }
}, 5 * 60 * 1000);

// ─────────────────────────────────────────────────────────────
// NOTAM proxy — ICAO API times out from Vercel edge, relay proxies
// ─────────────────────────────────────────────────────────────
const ICAO_API_KEY = process.env.ICAO_API_KEY;
const notamCache = { data: null, ts: 0 };
const NOTAM_CACHE_TTL = 30 * 60 * 1000; // 30 min

function handleNotamProxyRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const locations = url.searchParams.get('locations');
  if (!locations) {
    return sendCompressed(req, res, 400, { 'Content-Type': 'application/json' },
      JSON.stringify({ error: 'Missing locations parameter' }));
  }
  if (!ICAO_API_KEY) {
    return sendCompressed(req, res, 200, { 'Content-Type': 'application/json' },
      JSON.stringify([]));
  }

  const cacheKey = locations.split(',').sort().join(',');
  if (notamCache.data && notamCache.key === cacheKey && Date.now() - notamCache.ts < NOTAM_CACHE_TTL) {
    return sendCompressed(req, res, 200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=1800, s-maxage=1800',
      'X-Cache': 'HIT',
    }, notamCache.data);
  }

  const apiUrl = `https://dataservices.icao.int/api/notams-realtime-list?api_key=${ICAO_API_KEY}&format=json&locations=${encodeURIComponent(locations)}`;

  const request = https.get(apiUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' },
    timeout: 25000,
  }, (upstream) => {
    if (upstream.statusCode !== 200) {
      console.warn(`[Relay] NOTAM upstream HTTP ${upstream.statusCode}`);
      upstream.resume();
      return sendCompressed(req, res, 200, { 'Content-Type': 'application/json' },
        JSON.stringify([]));
    }
    const ct = upstream.headers['content-type'] || '';
    if (ct.includes('text/html')) {
      console.warn('[Relay] NOTAM upstream returned HTML (challenge page)');
      upstream.resume();
      return sendCompressed(req, res, 200, { 'Content-Type': 'application/json' },
        JSON.stringify([]));
    }
    const chunks = [];
    upstream.on('data', c => chunks.push(c));
    upstream.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      try {
        JSON.parse(body); // validate JSON
        notamCache.data = body;
        notamCache.key = cacheKey;
        notamCache.ts = Date.now();
        console.log(`[Relay] NOTAM: ${body.length} bytes for ${locations}`);
        sendCompressed(req, res, 200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=1800, s-maxage=1800',
          'X-Cache': 'MISS',
        }, body);
      } catch {
        console.warn('[Relay] NOTAM: invalid JSON response');
        sendCompressed(req, res, 200, { 'Content-Type': 'application/json' },
          JSON.stringify([]));
      }
    });
  });

  request.on('error', (err) => {
    console.warn(`[Relay] NOTAM error: ${err.message}`);
    if (!res.headersSent) {
      sendCompressed(req, res, 200, { 'Content-Type': 'application/json' },
        JSON.stringify([]));
    }
  });

  request.on('timeout', () => {
    request.destroy();
    console.warn('[Relay] NOTAM timeout (25s)');
    if (!res.headersSent) {
      sendCompressed(req, res, 200, { 'Content-Type': 'application/json' },
        JSON.stringify([]));
    }
  });
}

// CORS origin allowlist — only our domains can use this relay
const ALLOWED_ORIGINS = [
  'https://worldmonitor.app',
  'https://www.worldmonitor.app',
  'https://tech.worldmonitor.app',
  'https://finance.worldmonitor.app',
  'https://info.5ls.us',
  'http://localhost:5173',   // Vite dev
  'http://localhost:5174',   // Vite dev alt port
  'http://localhost:4173',   // Vite preview
  'https://localhost',       // Tauri desktop
  'tauri://localhost',       // Tauri iOS/macOS
];

// --- HTTP Endpoints (bootstrap, panel, map) ---
const PHASE4_CHANNEL_KEYS = {
  stablecoins: 'relay:stablecoins:v1',
  'etf-flows': 'relay:etf-flows:v1',
  trade: 'relay:trade:v1',
  'gulf-quotes': 'relay:gulf-quotes:v1',
  spending: 'relay:spending:v1',
  'tech-events': 'relay:tech-events:v1',
  fred: 'relay:fred:v1',
  oil: 'relay:oil:v1',
  bis: 'relay:bis:v1',
  flights: 'relay:flights:v1',
  weather: 'relay:weather:v1',
  natural: 'relay:natural:v1',
  eonet: 'relay:eonet:v1',
  gdacs: 'relay:gdacs:v1',
  'gps-interference': 'relay:gps-interference:v1',
  cables: 'relay:cables:v1',
  cyber: 'relay:cyber:v1',
  'service-status': 'relay:service-status:v1',
  markets: 'market:dashboard:v1',
  'macro-signals': 'economic:macro-signals:v1',
  'strategic-risk': 'risk:scores:sebuf:v1',
  predictions: 'relay:predictions:v1',
  'supply-chain': 'supply_chain:chokepoints:v1',
  'strategic-posture': 'theater-posture:sebuf:v1',
  giving: 'giving:summary:v1',
  'config:news-sources': 'relay:config:news-sources',
  'config:feature-flags': 'relay:config:feature-flags',
  climate: 'relay:climate:v1',
  conflict: 'relay:conflict:v1',
  'news:full': 'news:digest:v1:full:en',
  'news:tech': 'news:digest:v1:tech:en',
  'news:finance': 'news:digest:v1:finance:en',
  'news:happy': 'news:digest:v1:happy:en',
  intelligence: 'digest:global:v1',
  'iran-events': 'conflict:iran-events:v1',
  'ucdp-events': 'conflict:ucdp-events:v1',
  telegram: 'relay:telegram:v1',
  oref: 'relay:oref:v1',
  ais: 'relay:ais-snapshot:v1',
};

// Map relay channel keys to frontend hydration keys (bootstrap.ts, getHydratedData, etc.)
const CHANNEL_TO_HYDRATION_KEY = {
  'config:news-sources': 'newsSources',
  'config:feature-flags': 'featureFlags',
  'etf-flows': 'etfFlows',
  'macro-signals': 'macroSignals',
  'service-status': 'serviceStatuses',
  'supply-chain': 'chokepoints',
  'giving': 'giving',
  climate: 'climateAnomalies',
  conflict: 'acledEvents',
  natural: 'natural',
  cyber: 'cyber',
  cables: 'cables',
  'gps-interference': 'gpsInterference',
  'news:full': 'news:full',
  'news:tech': 'news:tech',
  'news:finance': 'news:finance',
  'news:happy': 'news:happy',
  'strategic-risk': 'strategicRisk',
  'iran-events': 'iranEvents',
  'gulf-quotes': 'gulfQuotes',
  'tech-events': 'techEvents',
  'strategic-posture': 'strategicPosture',
  'ucdp-events': 'ucdpEvents',
  intelligence: 'intelligence',
  telegram: 'telegram',
  oref: 'oref',
  ais: 'aisSnapshot',
};
const PHASE4_MAP_KEYS = {
  'supply-chain': 'supply_chain:chokepoints:v1',
  gdacs: 'relay:gdacs:v1',
  eonet: 'relay:eonet:v1',
  natural: 'relay:natural:v1',
  cables: 'relay:cables:v1',
};

function getCorsOrigin(req) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  // Optional: allow Vercel preview deployments when explicitly enabled.
  if (ALLOW_VERCEL_PREVIEW_ORIGINS && origin.endsWith('.vercel.app')) return origin;
  return '';
}

const server = http.createServer(async (req, res) => {
  const pathname = (req.url || '/').split('?')[0];
  const corsOrigin = getCorsOrigin(req);
  if (corsOrigin) {
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', `Content-Type, Authorization, ${RELAY_AUTH_HEADER}`);

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(corsOrigin ? 204 : 403);
    return res.end();
  }

  // NOTE: With Cloudflare edge caching (CDN-Cache-Control), authenticated responses may be
  // served to unauthenticated requests from edge cache. This is acceptable — all proxied data
  // is public (RSS, WorldBank, UCDP, Polymarket, OpenSky, AIS). Auth exists for abuse
  // prevention (rate limiting), not data protection. Cloudflare WAF provides edge-level protection.
  const isPublicRoute = pathname === '/health' || pathname === '/';
  if (!isPublicRoute) {
    if (!isAuthorizedRequest(req)) {
      return safeEnd(res, 401, { 'Content-Type': 'application/json' },
        JSON.stringify({ error: 'Unauthorized', time: Date.now() }));
    }
    const rl = consumeRateLimit(req, pathname);
    if (rl.limited) {
      const retryAfterSec = Math.max(1, Math.ceil(rl.resetInMs / 1000));
      return safeEnd(res, 429, {
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfterSec),
        'X-RateLimit-Limit': String(rl.limit),
        'X-RateLimit-Remaining': String(rl.remaining),
        'X-RateLimit-Reset': String(retryAfterSec),
      }, JSON.stringify({ error: 'Too many requests', time: Date.now() }));
    }
  }

  if (pathname === '/health' || pathname === '/') {
    const mem = process.memoryUsage();
    sendCompressed(req, res, 200, { 'Content-Type': 'application/json' }, JSON.stringify({
      status: 'ok',
      clients: clients.size,
      messages: messageCount,
      droppedMessages,
      connected: upstreamSocket?.readyState === WebSocket.OPEN,
      upstreamPaused,
      vessels: vessels.size,
      densityZones: Array.from(densityGrid.values()).filter(c => c.vessels.size >= 2).length,
      telegram: {
        enabled: TELEGRAM_ENABLED,
        channels: telegramState.channels?.length || 0,
        items: telegramState.items?.length || 0,
        lastPollAt: telegramState.lastPollAt ? new Date(telegramState.lastPollAt).toISOString() : null,
        hasError: !!telegramState.lastError,
        lastError: telegramState.lastError || null,
        pollInFlight: telegramPollInFlight,
        pollInFlightSince: telegramPollInFlight && telegramPollStartedAt ? new Date(telegramPollStartedAt).toISOString() : null,
      },
      oref: {
        enabled: OREF_ENABLED,
        alertCount: orefState.lastAlerts?.length || 0,
        historyCount24h: orefState.historyCount24h,
        totalHistoryCount: orefState.totalHistoryCount,
        historyWaves: orefState.history?.length || 0,
        lastPollAt: orefState.lastPollAt ? new Date(orefState.lastPollAt).toISOString() : null,
        hasError: !!orefState.lastError,
        redisEnabled: UPSTASH_ENABLED,
        bootstrapSource: orefState.bootstrapSource,
      },
      memory: {
        rss: `${(mem.rss / 1024 / 1024).toFixed(0)}MB`,
        heapUsed: `${(mem.heapUsed / 1024 / 1024).toFixed(0)}MB`,
        heapTotal: `${(mem.heapTotal / 1024 / 1024).toFixed(0)}MB`,
      },
      cache: {
        opensky: openskyResponseCache.size,
        opensky_neg: openskyNegativeCache.size,
        rss: rssResponseCache.size,
        ucdp: ucdpCache.data ? 'warm' : 'cold',
        worldbank: worldbankCache.size,
        polymarket: polymarketCache.size,
        polymarketInflight: polymarketInflight.size,
      },
      auth: {
        sharedSecretEnabled: !!RELAY_SHARED_SECRET,
        wsTokenEnabled: !!RELAY_WS_TOKEN,
        authHeader: RELAY_AUTH_HEADER,
        allowVercelPreviewOrigins: ALLOW_VERCEL_PREVIEW_ORIGINS,
      },
      rateLimit: {
        windowMs: RELAY_RATE_LIMIT_WINDOW_MS,
        defaultMax: RELAY_RATE_LIMIT_MAX,
        openskyMax: RELAY_OPENSKY_RATE_LIMIT_MAX,
        rssMax: RELAY_RSS_RATE_LIMIT_MAX,
      },
    }));
  } else if (pathname === '/metrics') {
    return sendCompressed(req, res, 200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    }, JSON.stringify(getRelayRollingMetrics()));
  } else if (pathname.startsWith('/ais/snapshot')) {
    // Aggregated AIS snapshot for server-side fanout — serve pre-serialized + pre-gzipped
    connectUpstream();
    buildSnapshot(); // ensures cache is warm
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const includeCandidates = url.searchParams.get('candidates') === 'true';
    const json = includeCandidates ? lastSnapshotWithCandJson : lastSnapshotJson;
    const gz = includeCandidates ? lastSnapshotWithCandGzip : lastSnapshotGzip;

    if (json) {
      sendPreGzipped(req, res, 200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=2',
        'CDN-Cache-Control': 'public, max-age=10',
      }, json, gz);
    } else {
      // Cold start fallback
      const payload = { ...lastSnapshot, candidateReports: includeCandidates ? getCandidateReportsSnapshot() : [] };
      sendCompressed(req, res, 200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=2',
        'CDN-Cache-Control': 'public, max-age=10',
      }, JSON.stringify(payload));
    }
  } else if (pathname === '/opensky-reset') {
    openskyToken = null;
    openskyTokenExpiry = 0;
    openskyTokenPromise = null;
    openskyAuthCooldownUntil = 0;
    openskyGlobal429Until = 0;
    openskyNegativeCache.clear();
    console.log('[Relay] OpenSky auth + rate-limit state reset via /opensky-reset');
    const tokenStart = Date.now();
    const token = await getOpenSkyToken();
    return sendCompressed(req, res, 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'CDN-Cache-Control': 'no-store' }, JSON.stringify({
      reset: true,
      tokenAcquired: !!token,
      latencyMs: Date.now() - tokenStart,
      negativeCacheCleared: true,
      rateLimitCooldownCleared: true,
    }));
  } else if (pathname === '/opensky-diag') {
    // Temporary diagnostic route with safe output only (no token payloads).
    const now = Date.now();
    const hasFreshToken = !!(openskyToken && now < openskyTokenExpiry - 60000);
    const diag = { timestamp: new Date().toISOString(), steps: [] };
    const clientId = process.env.OPENSKY_CLIENT_ID;
    const clientSecret = process.env.OPENSKY_CLIENT_SECRET;

    diag.steps.push({ step: 'env_check', hasClientId: !!clientId, hasClientSecret: !!clientSecret });
    diag.steps.push({
      step: 'auth_state',
      cachedToken: !!openskyToken,
      freshToken: hasFreshToken,
      tokenExpiry: openskyTokenExpiry ? new Date(openskyTokenExpiry).toISOString() : null,
      cooldownRemainingMs: Math.max(0, openskyAuthCooldownUntil - now),
      tokenFetchInFlight: !!openskyTokenPromise,
      global429CooldownRemainingMs: Math.max(0, openskyGlobal429Until - now),
      requestSpacingMs: OPENSKY_REQUEST_SPACING_MS,
    });

    if (!clientId || !clientSecret) {
      diag.steps.push({ step: 'FAILED', reason: 'Missing OPENSKY_CLIENT_ID or OPENSKY_CLIENT_SECRET' });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(diag, null, 2));
    }

    // Use shared token path so diagnostics respect mutex + cooldown protections.
    const tokenStart = Date.now();
    const token = await getOpenSkyToken();
    diag.steps.push({
      step: 'token_request',
      method: 'getOpenSkyToken',
      success: !!token,
      fromCache: hasFreshToken,
      latencyMs: Date.now() - tokenStart,
      cooldownRemainingMs: Math.max(0, openskyAuthCooldownUntil - Date.now()),
    });

    if (token) {
      const apiResult = await new Promise((resolve) => {
        const start = Date.now();
        const apiReq = https.get('https://opensky-network.org/api/states/all?lamin=47&lomin=5&lamax=48&lomax=6', {
          family: 4,
          headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
          timeout: 15000,
        }, (apiRes) => {
          let data = '';
          apiRes.on('data', chunk => data += chunk);
          apiRes.on('end', () => resolve({
            status: apiRes.statusCode,
            latencyMs: Date.now() - start,
            bodyLength: data.length,
            statesCount: (data.match(/"states":\s*\[/) ? 'present' : 'missing'),
          }));
        });
        apiReq.on('error', (err) => resolve({ error: err.message, code: err.code, latencyMs: Date.now() - start }));
        apiReq.on('timeout', () => { apiReq.destroy(); resolve({ error: 'timeout', latencyMs: Date.now() - start }); });
      });
      diag.steps.push({ step: 'api_request', ...apiResult });
    } else {
      diag.steps.push({ step: 'api_request', skipped: true, reason: 'No token available (auth failure or cooldown active)' });
    }

    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(diag, null, 2));
  } else if (pathname === '/telegram' || pathname.startsWith('/telegram/')) {
    // Telegram Early Signals feed (public channels)
    try {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') || 50)));
      const topic = (url.searchParams.get('topic') || '').trim().toLowerCase();
      const channel = (url.searchParams.get('channel') || '').trim().toLowerCase();

      const items = Array.isArray(telegramState.items) ? telegramState.items : [];
      const filtered = items.filter((it) => {
        if (topic && String(it.topic || '').toLowerCase() !== topic) return false;
        if (channel && String(it.channel || '').toLowerCase() !== channel) return false;
        return true;
      }).slice(0, limit);

      sendCompressed(req, res, 200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=10',
        'CDN-Cache-Control': 'public, max-age=10',
      }, JSON.stringify({
        source: 'telegram',
        earlySignal: true,
        enabled: TELEGRAM_ENABLED,
        count: filtered.length,
        updatedAt: telegramState.lastPollAt ? new Date(telegramState.lastPollAt).toISOString() : null,
        items: filtered,
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal error' }));
    }
  } else if (pathname.startsWith('/rss')) {
    // Proxy RSS feeds that block Vercel IPs
    let feedUrl = '';
    try {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      feedUrl = url.searchParams.get('url') || '';

      if (!feedUrl) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Missing url parameter' }));
      }

      // Allow domains that block Vercel IPs (must match feeds.ts railwayRss usage)
      const allowedDomains = [
        // Original
        'rss.cnn.com',
        'www.defensenews.com',
        'layoffs.fyi',
        // International Organizations
        'news.un.org',
        'www.cisa.gov',
        'www.iaea.org',
        'www.who.int',
        'www.crisisgroup.org',
        // Middle East & Regional News
        'english.alarabiya.net',
        'www.arabnews.com',
        'www.timesofisrael.com',
        'www.scmp.com',
        'kyivindependent.com',
        'www.themoscowtimes.com',
        // Africa
        'feeds.24.com',
        'feeds.capi24.com',  // News24 redirect destination
        'islandtimes.org',
        'www.atlanticcouncil.org',
        'smartraveller.gov.au',
        'www.smartraveller.gov.au',
      ];
      const parsed = new URL(feedUrl);
      // Block deprecated/stale feed domains — stale clients still request these
      const blockedDomains = ['rsshub.app'];
      if (blockedDomains.includes(parsed.hostname)) {
        res.writeHead(410, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Feed deprecated' }));
      }
      if (!allowedDomains.includes(parsed.hostname)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Domain not allowed on Railway proxy' }));
      }

      // Serve from cache if fresh (5 min for success, 1 min for failures)
      const rssCached = rssResponseCache.get(feedUrl);
      if (rssCached) {
        const ttl = (rssCached.statusCode && rssCached.statusCode >= 200 && rssCached.statusCode < 300)
          ? RSS_CACHE_TTL_MS : RSS_NEGATIVE_CACHE_TTL_MS;
        if (Date.now() - rssCached.timestamp < ttl) {
          return sendCompressed(req, res, rssCached.statusCode || 200, {
            'Content-Type': rssCached.contentType || 'application/xml',
            'Cache-Control': rssCached.statusCode >= 200 && rssCached.statusCode < 300 ? 'public, max-age=300' : 'no-cache',
            'CDN-Cache-Control': rssCached.statusCode >= 200 && rssCached.statusCode < 300 ? 'public, max-age=600, stale-while-revalidate=300' : 'no-store',
            'X-Cache': 'HIT',
          }, rssCached.data);
        }
      }

      // In-flight dedup: if another request for the same feed is already fetching,
      // wait for it and serve from cache instead of hammering upstream.
      const existing = rssInFlight.get(feedUrl);
      if (existing) {
        try {
          await existing;
          const deduped = rssResponseCache.get(feedUrl);
          if (deduped) {
            return sendCompressed(req, res, deduped.statusCode || 200, {
              'Content-Type': deduped.contentType || 'application/xml',
              'Cache-Control': deduped.statusCode >= 200 && deduped.statusCode < 300 ? 'public, max-age=300' : 'no-cache',
              'CDN-Cache-Control': deduped.statusCode >= 200 && deduped.statusCode < 300 ? 'public, max-age=600, stale-while-revalidate=300' : 'no-store',
              'X-Cache': 'DEDUP',
            }, deduped.data);
          }
          // In-flight completed but nothing cached — serve 502 instead of cascading
          return safeEnd(res, 502, { 'Content-Type': 'application/json' },
            JSON.stringify({ error: 'Upstream fetch completed but not cached' }));
        } catch {
          // In-flight fetch failed — serve 502 instead of starting another fetch
          return safeEnd(res, 502, { 'Content-Type': 'application/json' },
            JSON.stringify({ error: 'Upstream fetch failed' }));
        }
      }

      logThrottled('log', `rss-miss:${feedUrl}`, '[Relay] RSS request (MISS):', feedUrl);

      const fetchPromise = new Promise((resolveInFlight, rejectInFlight) => {
      let responseHandled = false;

      const sendError = (statusCode, message) => {
        if (responseHandled || res.headersSent) return;
        responseHandled = true;
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: message }));
        rejectInFlight(new Error(message));
      };

      const fetchWithRedirects = (url, redirectCount = 0) => {
        if (redirectCount > 3) {
          return sendError(502, 'Too many redirects');
        }

        const conditionalHeaders = {};
        if (rssCached?.etag) conditionalHeaders['If-None-Match'] = rssCached.etag;
        if (rssCached?.lastModified) conditionalHeaders['If-Modified-Since'] = rssCached.lastModified;

        const protocol = url.startsWith('https') ? https : http;
        const request = protocol.get(url, {
          headers: {
            'Accept': 'application/rss+xml, application/xml, text/xml, */*',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
            ...conditionalHeaders,
          },
          timeout: 15000
        }, (response) => {
          if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
            const redirectUrl = response.headers.location.startsWith('http')
              ? response.headers.location
              : new URL(response.headers.location, url).href;
            const redirectHost = new URL(redirectUrl).hostname;
            if (!allowedDomains.includes(redirectHost)) {
              return sendError(403, 'Redirect to disallowed domain');
            }
            logThrottled('log', `rss-redirect:${feedUrl}:${redirectUrl}`, `[Relay] Following redirect to: ${redirectUrl}`);
            return fetchWithRedirects(redirectUrl, redirectCount + 1);
          }

          if (response.statusCode === 304 && rssCached) {
            responseHandled = true;
            rssCached.timestamp = Date.now();
            resolveInFlight();
            logThrottled('log', `rss-revalidated:${feedUrl}`, '[Relay] RSS 304 revalidated:', feedUrl);
            sendCompressed(req, res, 200, {
              'Content-Type': rssCached.contentType || 'application/xml',
              'Cache-Control': 'public, max-age=300',
              'CDN-Cache-Control': 'public, max-age=600, stale-while-revalidate=300',
              'X-Cache': 'REVALIDATED',
            }, rssCached.data);
            return;
          }

          const encoding = response.headers['content-encoding'];
          let stream = response;
          if (encoding === 'gzip' || encoding === 'deflate') {
            stream = encoding === 'gzip' ? response.pipe(zlib.createGunzip()) : response.pipe(zlib.createInflate());
          }

          const chunks = [];
          stream.on('data', chunk => chunks.push(chunk));
          stream.on('end', () => {
            if (responseHandled || res.headersSent) return;
            responseHandled = true;
            const data = Buffer.concat(chunks);
            // Cache all responses: 2xx with full TTL, non-2xx with short TTL (negative cache)
            // FIFO eviction: drop oldest-inserted entry if at capacity
            if (rssResponseCache.size >= RSS_CACHE_MAX_ENTRIES && !rssResponseCache.has(feedUrl)) {
              const oldest = rssResponseCache.keys().next().value;
              if (oldest) rssResponseCache.delete(oldest);
            }
            rssResponseCache.set(feedUrl, {
              data, contentType: 'application/xml', statusCode: response.statusCode, timestamp: Date.now(),
              etag: response.headers['etag'] || null,
              lastModified: response.headers['last-modified'] || null,
            });
            if (response.statusCode < 200 || response.statusCode >= 300) {
              logThrottled('warn', `rss-upstream:${feedUrl}:${response.statusCode}`, `[Relay] RSS upstream ${response.statusCode} for ${feedUrl}`);
            }
            resolveInFlight();
            sendCompressed(req, res, response.statusCode, {
              'Content-Type': 'application/xml',
              'Cache-Control': response.statusCode >= 200 && response.statusCode < 300 ? 'public, max-age=300' : 'no-cache',
              'CDN-Cache-Control': response.statusCode >= 200 && response.statusCode < 300 ? 'public, max-age=600, stale-while-revalidate=300' : 'no-store',
              'X-Cache': 'MISS',
            }, data);
          });
          stream.on('error', (err) => {
            logThrottled('error', `rss-decompress:${feedUrl}:${err.code || err.message}`, '[Relay] Decompression error:', err.message);
            sendError(502, 'Decompression failed: ' + err.message);
          });
        });

        request.on('error', (err) => {
          logThrottled('error', `rss-error:${feedUrl}:${err.code || err.message}`, '[Relay] RSS error:', err.message);
          // Serve stale on error
          if (rssCached) {
            if (!responseHandled && !res.headersSent) {
              responseHandled = true;
              sendCompressed(req, res, 200, { 'Content-Type': 'application/xml', 'Cache-Control': 'no-store', 'CDN-Cache-Control': 'no-store', 'X-Cache': 'STALE' }, rssCached.data);
            }
            resolveInFlight();
            return;
          }
          sendError(502, err.message);
        });

        request.on('timeout', () => {
          request.destroy();
          if (rssCached && !responseHandled && !res.headersSent) {
            responseHandled = true;
            sendCompressed(req, res, 200, { 'Content-Type': 'application/xml', 'Cache-Control': 'no-store', 'CDN-Cache-Control': 'no-store', 'X-Cache': 'STALE' }, rssCached.data);
            resolveInFlight();
            return;
          }
          sendError(504, 'Request timeout');
        });
      };

      fetchWithRedirects(feedUrl);
      }); // end fetchPromise

      rssInFlight.set(feedUrl, fetchPromise);
      fetchPromise.catch(() => {}).finally(() => rssInFlight.delete(feedUrl));
    } catch (err) {
      if (feedUrl) rssInFlight.delete(feedUrl);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
  } else if (pathname === '/oref/alerts') {
    sendCompressed(req, res, 200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=5, s-maxage=5, stale-while-revalidate=3',
    }, JSON.stringify({
      configured: OREF_ENABLED,
      alerts: orefState.lastAlerts || [],
      historyCount24h: orefState.historyCount24h,
      totalHistoryCount: orefState.totalHistoryCount,
      timestamp: orefState.lastPollAt ? new Date(orefState.lastPollAt).toISOString() : new Date().toISOString(),
      ...(orefState.lastError ? { error: orefState.lastError } : {}),
    }));
  } else if (pathname === '/oref/history') {
    sendCompressed(req, res, 200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=30, s-maxage=30, stale-while-revalidate=10',
    }, JSON.stringify({
      configured: OREF_ENABLED,
      history: orefState.history || [],
      historyCount24h: orefState.historyCount24h,
      totalHistoryCount: orefState.totalHistoryCount,
      timestamp: orefState.lastPollAt ? new Date(orefState.lastPollAt).toISOString() : new Date().toISOString(),
    }));
  } else if (pathname.startsWith('/ucdp-events')) {
    handleUcdpEventsRequest(req, res);
  } else if (pathname.startsWith('/opensky')) {
    handleOpenSkyRequest(req, res, PORT);
  } else if (pathname.startsWith('/worldbank')) {
    handleWorldBankRequest(req, res);
  } else if (pathname.startsWith('/polymarket')) {
    handlePolymarketRequest(req, res);
  } else if (pathname === '/youtube-live') {
    handleYouTubeLiveRequest(req, res);
  } else if (pathname === '/notam') {
    handleNotamProxyRequest(req, res);
  } else if (pathname === '/bootstrap') {
    // Note: ?variant is accepted but ignored — bootstrap returns all channel caches
    // regardless of variant. The frontend filters variant-specific data client-side.
    try {
      const entries = await Promise.all(
        Object.entries(PHASE4_CHANNEL_KEYS).map(async ([channel, key]) => {
          const data = await redisGet(key);
          return [channel, data];
        })
      );
      const result = Object.fromEntries(entries.filter(([, v]) => v !== null));
      const remappedResult = Object.fromEntries(
        Object.entries(result).map(([ch, v]) => [CHANNEL_TO_HYDRATION_KEY[ch] ?? ch, v])
      );
      sendCompressed(req, res, 200, { 'Content-Type': 'application/json' }, JSON.stringify(remappedResult));
    } catch (err) {
      console.error('[bootstrap] error:', err?.message ?? err);
      safeEnd(res, 500, { 'Content-Type': 'application/json' },
        JSON.stringify({ error: 'Bootstrap failed' }));
    }
  } else if (pathname.startsWith('/panel/')) {
    const channel = pathname.slice('/panel/'.length).split('/')[0] || '';
    const key = PHASE4_CHANNEL_KEYS[channel];
    if (!key) {
      safeEnd(res, 404, { 'Content-Type': 'application/json' },
        JSON.stringify({ error: 'Unknown channel' }));
      return;
    }
    const data = await redisGet(key);
    if (!data) {
      res.writeHead(204);
      res.end();
      return;
    }
    sendCompressed(req, res, 200, { 'Content-Type': 'application/json' }, JSON.stringify(data));
  } else if (pathname.startsWith('/map/')) {
    const layer = pathname.slice('/map/'.length).split('/')[0] || '';
    const key = PHASE4_MAP_KEYS[layer];
    if (!key) {
      safeEnd(res, 404, { 'Content-Type': 'application/json' },
        JSON.stringify({ error: 'Unknown layer' }));
      return;
    }
    const data = await redisGet(key);
    if (!data) {
      res.writeHead(204);
      res.end();
      return;
    }
    sendCompressed(req, res, 200, { 'Content-Type': 'application/json' }, JSON.stringify(data));
  } else if (pathname === '/gdelt') {
    // GDELT Doc API proxy — browser cannot call gdeltproject.org directly (CORS)
    const qs = new URLSearchParams((req.url || '').split('?')[1] || '');
    const query = qs.get('query') || '';
    const maxRecords = Math.min(parseInt(qs.get('max_records') || '10', 10) || 10, 20);
    const timespan = qs.get('timespan') || '24h';
    const toneFilter = qs.get('tone_filter') || '';
    const sort = qs.get('sort') || 'date';

    if (!query || query.length < 2) {
      safeEnd(res, 400, { 'Content-Type': 'application/json' }, JSON.stringify({ error: 'query required' }));
      return;
    }

    const fullQuery = toneFilter ? `${query} ${toneFilter}` : query;
    const cacheKey = `relay:gdelt:${Buffer.from(fullQuery).toString('base64').slice(0, 60)}:${timespan}:${maxRecords}`;

    try {
      const cached = await redisGet(cacheKey);
      if (cached) {
        sendCompressed(req, res, 200, { 'Content-Type': 'application/json' }, JSON.stringify(cached));
        return;
      }

      const gdeltUrl = new URL('https://api.gdeltproject.org/api/v2/doc/doc');
      gdeltUrl.searchParams.set('query', fullQuery);
      gdeltUrl.searchParams.set('mode', 'artlist');
      gdeltUrl.searchParams.set('maxrecords', String(maxRecords));
      gdeltUrl.searchParams.set('format', 'json');
      gdeltUrl.searchParams.set('sort', sort);
      gdeltUrl.searchParams.set('timespan', timespan);

      const resp = await fetch(gdeltUrl.toString(), {
        headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(12000),
      });

      if (!resp.ok) {
        safeEnd(res, 502, { 'Content-Type': 'application/json' }, JSON.stringify({ error: `GDELT returned ${resp.status}`, articles: [] }));
        return;
      }

      const contentType = resp.headers.get('content-type') || '';
      if (!contentType.includes('json')) {
        const text = await resp.text();
        safeEnd(res, 502, { 'Content-Type': 'application/json' }, JSON.stringify({ error: `GDELT non-JSON: ${text.slice(0, 80)}`, articles: [] }));
        return;
      }

      const raw = await resp.json();
      const articles = (raw.articles || []).map((a) => ({
        title: a.title || '',
        url: a.url || '',
        source: a.domain || a.source?.domain || '',
        date: a.seendate || '',
        image: a.socialimage || '',
        language: a.language || '',
        tone: typeof a.tone === 'number' ? a.tone : 0,
      }));

      const result = { articles, query: fullQuery, error: '' };
      if (articles.length > 0) await redisSetex(cacheKey, 600, result);
      sendCompressed(req, res, 200, { 'Content-Type': 'application/json' }, JSON.stringify(result));
    } catch (err) {
      safeEnd(res, 502, { 'Content-Type': 'application/json' }, JSON.stringify({ error: err?.message ?? 'fetch failed', articles: [] }));
    }
  } else {
    res.writeHead(404);
    res.end();
  }
});

function connectUpstream() {
  // Skip if already connected or connecting
  if (upstreamSocket?.readyState === WebSocket.OPEN ||
      upstreamSocket?.readyState === WebSocket.CONNECTING) return;

  console.log('[Relay] Connecting to aisstream.io...');
  const socket = new WebSocket(AISSTREAM_URL);
  upstreamSocket = socket;
  clearUpstreamQueue();
  upstreamPaused = false;

  const scheduleUpstreamDrain = () => {
    if (upstreamDrainScheduled) return;
    upstreamDrainScheduled = true;
    setImmediate(drainUpstreamQueue);
  };

  const drainUpstreamQueue = () => {
    if (upstreamSocket !== socket) {
      clearUpstreamQueue();
      upstreamPaused = false;
      return;
    }

    upstreamDrainScheduled = false;
    const startedAt = Date.now();
    let processed = 0;

    while (processed < UPSTREAM_DRAIN_BATCH &&
           getUpstreamQueueSize() > 0 &&
           Date.now() - startedAt < UPSTREAM_DRAIN_BUDGET_MS) {
      const raw = dequeueUpstreamMessage();
      if (!raw) break;
      processRawUpstreamMessage(raw);
      processed++;
    }

    const queueSize = getUpstreamQueueSize();
    if (queueSize >= UPSTREAM_QUEUE_HIGH_WATER && !upstreamPaused) {
      upstreamPaused = true;
      socket.pause();
      console.warn(`[Relay] Upstream paused (queue=${queueSize}, dropped=${droppedMessages})`);
    } else if (upstreamPaused && queueSize <= UPSTREAM_QUEUE_LOW_WATER) {
      upstreamPaused = false;
      socket.resume();
      console.log(`[Relay] Upstream resumed (queue=${queueSize})`);
    }

    if (queueSize > 0) scheduleUpstreamDrain();
  };

  socket.on('open', () => {
    // Verify this socket is still the current one (race condition guard)
    if (upstreamSocket !== socket) {
      console.log('[Relay] Stale socket open event, closing');
      socket.close();
      return;
    }
    console.log('[Relay] Connected to aisstream.io');
    socket.send(JSON.stringify({
      APIKey: API_KEY,
      BoundingBoxes: [[[-90, -180], [90, 180]]],
      FilterMessageTypes: ['PositionReport'],
    }));
  });

  socket.on('message', (data) => {
    if (upstreamSocket !== socket) return;

    const raw = data instanceof Buffer ? data : Buffer.from(data);
    if (getUpstreamQueueSize() >= UPSTREAM_QUEUE_HARD_CAP) {
      droppedMessages++;
      incrementRelayMetric('drops');
      return;
    }

    enqueueUpstreamMessage(raw);
    if (!upstreamPaused && getUpstreamQueueSize() >= UPSTREAM_QUEUE_HIGH_WATER) {
      upstreamPaused = true;
      socket.pause();
      console.warn(`[Relay] Upstream paused (queue=${getUpstreamQueueSize()}, dropped=${droppedMessages})`);
    }
    scheduleUpstreamDrain();
  });

  socket.on('close', () => {
    if (upstreamSocket === socket) {
      upstreamSocket = null;
      clearUpstreamQueue();
      upstreamPaused = false;
      console.log('[Relay] Disconnected, reconnecting in 5s...');
      setTimeout(connectUpstream, 5000);
    }
  });

  socket.on('error', (err) => {
    console.error('[Relay] Upstream error:', err.message);
  });
}

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

// ── Cron channel handlers ────────────────────────────────────────────────────
// Stagger crons to avoid thundering herd when many fire at once.

// ── Simple Channels (direct fetch from external APIs) ───────────────────────
const PHASE3A_TIMEOUT_MS = 10_000;

// Yahoo Finance rate-limit gate (min 350ms between requests)
let yahooLastRequest = 0;
const YAHOO_MIN_GAP_MS = 350;
let yahooQueue = Promise.resolve();
function yahooGate() {
  yahooQueue = yahooQueue.then(async () => {
    const elapsed = Date.now() - yahooLastRequest;
    if (elapsed < YAHOO_MIN_GAP_MS) await new Promise(r => setTimeout(r, YAHOO_MIN_GAP_MS - elapsed));
    yahooLastRequest = Date.now();
  });
  return yahooQueue;
}

async function fetchStablecoins() {
  const coins = 'tether,usd-coin,dai,first-digital-usd,ethena-usde';
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${coins}&order=market_cap_desc&sparkline=false&price_change_percentage=7d`;
  const resp = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(PHASE3A_TIMEOUT_MS),
  });
  if (resp.status === 429) throw new Error('CoinGecko rate limited');
  if (!resp.ok) throw new Error(`CoinGecko HTTP ${resp.status}`);
  const data = await resp.json();
  const stablecoins = data.map((coin) => {
    const price = coin.current_price || 0;
    const deviation = Math.abs(price - 1.0);
    let pegStatus;
    if (deviation <= 0.005) pegStatus = 'ON PEG';
    else if (deviation <= 0.01) pegStatus = 'SLIGHT DEPEG';
    else pegStatus = 'DEPEGGED';
    return {
      id: coin.id,
      symbol: (coin.symbol || '').toUpperCase(),
      name: coin.name,
      price,
      deviation: +(deviation * 100).toFixed(3),
      pegStatus,
      marketCap: coin.market_cap || 0,
      volume24h: coin.total_volume || 0,
      change24h: coin.price_change_percentage_24h || 0,
      change7d: coin.price_change_percentage_7d_in_currency || 0,
      image: coin.image || '',
    };
  });
  const totalMarketCap = stablecoins.reduce((s, c) => s + c.marketCap, 0);
  const totalVolume24h = stablecoins.reduce((s, c) => s + c.volume24h, 0);
  const depeggedCount = stablecoins.filter(c => c.pegStatus === 'DEPEGGED').length;
  return {
    timestamp: new Date().toISOString(),
    summary: {
      totalMarketCap,
      totalVolume24h,
      coinCount: stablecoins.length,
      depeggedCount,
      healthStatus: depeggedCount === 0 ? 'HEALTHY' : depeggedCount === 1 ? 'CAUTION' : 'WARNING',
    },
    stablecoins,
  };
}

const ETF_LIST = [
  { ticker: 'IBIT', issuer: 'BlackRock' },
  { ticker: 'FBTC', issuer: 'Fidelity' },
  { ticker: 'ARKB', issuer: 'ARK/21Shares' },
  { ticker: 'BITB', issuer: 'Bitwise' },
  { ticker: 'GBTC', issuer: 'Grayscale' },
  { ticker: 'HODL', issuer: 'VanEck' },
  { ticker: 'BRRR', issuer: 'Valkyrie' },
  { ticker: 'EZBC', issuer: 'Franklin' },
  { ticker: 'BTCO', issuer: 'Invesco' },
  { ticker: 'BTCW', issuer: 'WisdomTree' },
];

async function fetchEtfChart(ticker) {
  await yahooGate();
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=5d&interval=1d`;
  const resp = await fetch(url, { headers: { 'User-Agent': CHROME_UA }, signal: AbortSignal.timeout(PHASE3A_TIMEOUT_MS) });
  if (!resp.ok) return null;
  return resp.json();
}

function parseEtfChartData(chart, ticker, issuer) {
  try {
    const result = chart?.chart?.result?.[0];
    if (!result) return null;
    const quote = result.indicators?.quote?.[0];
    const closes = (quote?.close || []).filter(v => v != null);
    const volumes = (quote?.volume || []).filter(v => v != null);
    if (closes.length < 2) return null;
    const latestPrice = closes[closes.length - 1];
    const prevPrice = closes[closes.length - 2];
    const priceChange = prevPrice ? ((latestPrice - prevPrice) / prevPrice * 100) : 0;
    const latestVolume = volumes.length > 0 ? volumes[volumes.length - 1] : 0;
    const avgVolume = volumes.length > 1 ? volumes.slice(0, -1).reduce((a, b) => a + b, 0) / (volumes.length - 1) : latestVolume;
    const volumeRatio = avgVolume > 0 ? latestVolume / avgVolume : 1;
    const direction = priceChange > 0.1 ? 'inflow' : priceChange < -0.1 ? 'outflow' : 'neutral';
    const estFlowMagnitude = latestVolume * latestPrice * (priceChange > 0 ? 1 : -1) * 0.1;
    return {
      ticker,
      issuer,
      price: +latestPrice.toFixed(2),
      priceChange: +priceChange.toFixed(2),
      volume: latestVolume,
      avgVolume: Math.round(avgVolume),
      volumeRatio: +volumeRatio.toFixed(2),
      direction,
      estFlow: Math.round(estFlowMagnitude),
    };
  } catch { return null; }
}

async function fetchEtfFlows() {
  const etfs = [];
  let misses = 0;
  for (const etf of ETF_LIST) {
    const chart = await fetchEtfChart(etf.ticker);
    if (chart) {
      const parsed = parseEtfChartData(chart, etf.ticker, etf.issuer);
      if (parsed) etfs.push(parsed);
      else misses++;
    } else misses++;
    if (misses >= 3 && etfs.length === 0) break;
  }
  if (etfs.length === 0) {
    return {
      timestamp: new Date().toISOString(),
      summary: { etfCount: 0, totalVolume: 0, totalEstFlow: 0, netDirection: 'UNAVAILABLE', inflowCount: 0, outflowCount: 0 },
      etfs: [],
      rateLimited: misses >= 3,
    };
  }
  const totalVolume = etfs.reduce((s, e) => s + e.volume, 0);
  const totalEstFlow = etfs.reduce((s, e) => s + e.estFlow, 0);
  etfs.sort((a, b) => b.volume - a.volume);
  return {
    timestamp: new Date().toISOString(),
    summary: {
      etfCount: etfs.length,
      totalVolume,
      totalEstFlow,
      netDirection: totalEstFlow > 0 ? 'NET INFLOW' : totalEstFlow < 0 ? 'NET OUTFLOW' : 'NEUTRAL',
      inflowCount: etfs.filter(e => e.direction === 'inflow').length,
      outflowCount: etfs.filter(e => e.direction === 'outflow').length,
    },
    etfs,
    rateLimited: false,
  };
}

const WTO_MEMBER_CODES = {
  '840': 'United States', '156': 'China', '276': 'Germany', '392': 'Japan', '826': 'United Kingdom',
  '356': 'India', '076': 'Brazil', '643': 'Russia', '410': 'South Korea', '036': 'Australia',
  '124': 'Canada', '484': 'Mexico', '250': 'France', '380': 'Italy', '528': 'Netherlands',
};
const MAJOR_REPORTERS = ['840', '156', '276', '392', '826', '356', '076', '643', '410', '036', '124', '484', '250', '380', '528'];

async function wtoFetch(path, params) {
  const apiKey = process.env.WTO_API_KEY;
  if (!apiKey) {
    console.warn('[relay] WTO_API_KEY not set — trade channel disabled');
    return null;
  }
  try {
    const url = new URL(`https://api.wto.org/timeseries/v1${path}`);
    if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url.toString(), {
      headers: { 'Ocp-Apim-Subscription-Key': apiKey, 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 204) return { Dataset: [] };
    if (!res.ok) return null;
    return res.json();
  } catch (e) {
    console.warn('[relay] WTO fetch error:', e?.message ?? e);
    return null;
  }
}

async function fetchTrade() {
  const currentYear = new Date().getFullYear();
  const reporters = MAJOR_REPORTERS.join(',');
  const [agriData, nonAgriData] = await Promise.all([
    wtoFetch('/data', { i: 'TP_A_0160', r: reporters, ps: `${currentYear - 3}-${currentYear}`, fmt: 'json', mode: 'full', max: '500' }),
    wtoFetch('/data', { i: 'TP_A_0430', r: reporters, ps: `${currentYear - 3}-${currentYear}`, fmt: 'json', mode: 'full', max: '500' }),
  ]);
  if (!agriData && !nonAgriData) {
    return { barriers: [], fetchedAt: new Date().toISOString(), upstreamUnavailable: true };
  }
  function parseRows(data) {
    const dataset = Array.isArray(data) ? data : data?.Dataset ?? data?.dataset ?? [];
    return dataset.map((row) => ({
      country: WTO_MEMBER_CODES[row.ReportingEconomyCode] ?? row.ReportingEconomy ?? '',
      countryCode: String(row.ReportingEconomyCode ?? ''),
      year: parseInt(row.Year ?? row.year ?? '0', 10),
      value: parseFloat(row.Value ?? row.value ?? ''),
    })).filter(r => !isNaN(r.year) && !isNaN(r.value));
  }
  const agriRows = agriData ? parseRows(agriData) : [];
  const nonAgriRows = nonAgriData ? parseRows(nonAgriData) : [];
  const latestAgri = new Map();
  for (const row of agriRows) {
    const ex = latestAgri.get(row.countryCode);
    if (!ex || row.year > ex.year) latestAgri.set(row.countryCode, row);
  }
  const latestNonAgri = new Map();
  for (const row of nonAgriRows) {
    const ex = latestNonAgri.get(row.countryCode);
    if (!ex || row.year > ex.year) latestNonAgri.set(row.countryCode, row);
  }
  const barriers = [];
  const allCodes = new Set([...latestAgri.keys(), ...latestNonAgri.keys()]);
  for (const code of allCodes) {
    const agri = latestAgri.get(code);
    const nonAgri = latestNonAgri.get(code);
    const agriRate = agri?.value ?? 0;
    const nonAgriRate = nonAgri?.value ?? 0;
    const gap = agriRate - nonAgriRate;
    const country = agri?.country ?? nonAgri?.country ?? code;
    const year = String(agri?.year ?? nonAgri?.year ?? '');
    barriers.push({
      id: `${code}-tariff-gap-${year}`,
      notifyingCountry: country,
      title: `Agricultural tariff: ${agriRate.toFixed(1)}% vs Non-agricultural: ${nonAgriRate.toFixed(1)} (gap: ${gap > 0 ? '+' : ''}${gap.toFixed(1)}pp)`,
      measureType: gap > 10 ? 'High agricultural protection' : gap > 5 ? 'Moderate agricultural protection' : 'Low tariff gap',
      productDescription: 'Agricultural vs Non-agricultural products',
      objective: gap > 0 ? 'Agricultural sector protection' : 'Uniform tariff structure',
      status: gap > 10 ? 'high' : gap > 5 ? 'moderate' : 'low',
      dateDistributed: year,
      sourceUrl: 'https://stats.wto.org',
    });
  }
  barriers.sort((a, b) => {
    const gapA = parseFloat(a.title.match(/gap: ([+-]?\d+\.?\d*)/)?.[1] ?? '0');
    const gapB = parseFloat(b.title.match(/gap: ([+-]?\d+\.?\d*)/)?.[1] ?? '0');
    return gapB - gapA;
  });
  return { barriers: barriers.slice(0, 50), fetchedAt: new Date().toISOString(), upstreamUnavailable: false };
}

const GULF_SYMBOLS = [
  { symbol: '^TASI.SR', name: 'Tadawul All Share', country: 'Saudi Arabia', flag: '🇸🇦', type: 'index' },
  { symbol: 'DFMGI.AE', name: 'Dubai Financial Market', country: 'UAE', flag: '🇦🇪', type: 'index' },
  { symbol: 'UAE', name: 'Abu Dhabi (iShares)', country: 'UAE', flag: '🇦🇪', type: 'index' },
  { symbol: 'QAT', name: 'Qatar (iShares)', country: 'Qatar', flag: '🇶🇦', type: 'index' },
  { symbol: 'GULF', name: 'Gulf Dividend (WisdomTree)', country: 'Kuwait', flag: '🇰🇼', type: 'index' },
  { symbol: '^MSM', name: 'Muscat MSM 30', country: 'Oman', flag: '🇴🇲', type: 'index' },
  { symbol: 'SARUSD=X', name: 'Saudi Riyal', country: 'Saudi Arabia', flag: '🇸🇦', type: 'currency' },
  { symbol: 'AEDUSD=X', name: 'UAE Dirham', country: 'UAE', flag: '🇦🇪', type: 'currency' },
  { symbol: 'QARUSD=X', name: 'Qatari Riyal', country: 'Qatar', flag: '🇶🇦', type: 'currency' },
  { symbol: 'KWDUSD=X', name: 'Kuwaiti Dinar', country: 'Kuwait', flag: '🇰🇼', type: 'currency' },
  { symbol: 'BHDUSD=X', name: 'Bahraini Dinar', country: 'Bahrain', flag: '🇧🇭', type: 'currency' },
  { symbol: 'OMRUSD=X', name: 'Omani Rial', country: 'Oman', flag: '🇴🇲', type: 'currency' },
  { symbol: 'CL=F', name: 'WTI Crude', country: '', flag: '🛢️', type: 'oil' },
  { symbol: 'BZ=F', name: 'Brent Crude', country: '', flag: '🛢️', type: 'oil' },
];

async function fetchYahooQuote(symbol) {
  await yahooGate();
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
  const resp = await fetch(url, { headers: { 'User-Agent': CHROME_UA }, signal: AbortSignal.timeout(PHASE3A_TIMEOUT_MS) });
  if (!resp.ok) return null;
  const data = await resp.json();
  const result = data.chart?.result?.[0];
  const meta = result?.meta;
  if (!meta) return null;
  const price = meta.regularMarketPrice;
  const prevClose = meta.chartPreviousClose || meta.previousClose || price;
  const change = ((price - prevClose) / prevClose) * 100;
  const closes = result.indicators?.quote?.[0]?.close;
  const sparkline = (closes?.filter(v => v != null) || []);
  return { price, change, sparkline };
}

async function fetchGulfQuotes() {
  const results = new Map();
  let failures = 0;
  for (const s of GULF_SYMBOLS) {
    const q = await fetchYahooQuote(s.symbol);
    if (q) results.set(s.symbol, q);
    else failures++;
  }
  const quotes = [];
  for (const s of GULF_SYMBOLS) {
    const yahoo = results.get(s.symbol);
    if (yahoo) {
      quotes.push({
        symbol: s.symbol,
        name: s.name,
        country: s.country,
        flag: s.flag,
        type: s.type,
        price: yahoo.price,
        change: yahoo.change,
        sparkline: yahoo.sparkline,
      });
    }
  }
  return { quotes, rateLimited: failures > GULF_SYMBOLS.length / 2 };
}

async function fetchSpending() {
  const periodStart = new Date();
  periodStart.setDate(periodStart.getDate() - 7);
  const periodEnd = new Date();
  const startStr = periodStart.toISOString().slice(0, 10);
  const endStr = periodEnd.toISOString().slice(0, 10);
  const AWARD_TYPE_MAP = { A: 'contract', B: 'contract', C: 'contract', D: 'contract', '02': 'grant', '03': 'grant', '04': 'grant', '05': 'grant', '06': 'grant', '10': 'grant', '07': 'loan', '08': 'loan' };
  try {
    const resp = await fetch('https://api.usaspending.gov/api/v2/search/spending_by_award/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(20000),
      body: JSON.stringify({
        filters: {
          time_period: [{ start_date: startStr, end_date: endStr }],
          award_type_codes: ['A', 'B', 'C', 'D'],
        },
        fields: ['Award ID', 'Recipient Name', 'Award Amount', 'Awarding Agency', 'Description', 'Start Date', 'Award Type'],
        limit: 15,
        order: 'desc',
        sort: 'Award Amount',
      }),
    });
    if (!resp.ok) throw new Error(`USASpending API error: ${resp.status}`);
    const data = await resp.json();
    const results = data.results || [];
    const awards = results.map((r) => ({
      id: String(r['Award ID'] || ''),
      recipientName: String(r['Recipient Name'] || 'Unknown'),
      amount: Number(r['Award Amount']) || 0,
      agency: String(r['Awarding Agency'] || 'Unknown'),
      description: String(r['Description'] || '').slice(0, 200),
      startDate: String(r['Start Date'] || ''),
      awardType: AWARD_TYPE_MAP[String(r['Award Type'] || '')] || 'other',
    }));
    const totalAmount = awards.reduce((s, a) => s + a.amount, 0);
    return {
      awards,
      totalAmount,
      periodStart: startStr,
      periodEnd: endStr,
      fetchedAt: new Date(),
    };
  } catch (err) {
    return { awards: [], totalAmount: 0, periodStart: startStr, periodEnd: endStr, fetchedAt: new Date() };
  }
}

// Minimal city coords for tech-events geocoding (common conference cities)
const CITY_COORDS = {
  'dubai': { lat: 25.2048, lng: 55.2708, country: 'UAE', virtual: false },
  'san francisco': { lat: 37.7749, lng: -122.4194, country: 'USA', virtual: false },
  'new york': { lat: 40.7128, lng: -74.0060, country: 'USA', virtual: false },
  'london': { lat: 51.5074, lng: -0.1278, country: 'UK', virtual: false },
  'paris': { lat: 48.8566, lng: 2.3522, country: 'France', virtual: false },
  'berlin': { lat: 52.5200, lng: 13.4050, country: 'Germany', virtual: false },
  'amsterdam': { lat: 52.3676, lng: 4.9041, country: 'Netherlands', virtual: false },
  'barcelona': { lat: 41.3851, lng: 2.1734, country: 'Spain', virtual: false },
  'lisbon': { lat: 38.7223, lng: -9.1393, country: 'Portugal', virtual: false },
  'toronto': { lat: 43.6532, lng: -79.3832, country: 'Canada', virtual: false },
  'singapore': { lat: 1.3521, lng: 103.8198, country: 'Singapore', virtual: false },
  'tokyo': { lat: 35.6762, lng: 139.6503, country: 'Japan', virtual: false },
  'tel aviv': { lat: 32.0853, lng: 34.7818, country: 'Israel', virtual: false },
  'austin': { lat: 30.2672, lng: -97.7431, country: 'USA', virtual: false },
  'las vegas': { lat: 36.1699, lng: -115.1398, country: 'USA', virtual: false },
  'online': { lat: 0, lng: 0, country: 'Virtual', virtual: true },
};

function normalizeLocation(loc) {
  if (!loc) return null;
  let n = loc.toLowerCase().trim().replace(/^hybrid:\s*/i, '');
  if (CITY_COORDS[n]) return { ...CITY_COORDS[n], original: loc };
  const parts = n.split(',');
  if (parts.length > 1 && CITY_COORDS[parts[0].trim()]) return { ...CITY_COORDS[parts[0].trim()], original: loc };
  for (const [key, c] of Object.entries(CITY_COORDS)) {
    if (n.includes(key) || key.includes(n)) return { ...c, original: loc };
  }
  return null;
}

function parseTechEventsICS(icsText) {
  const events = [];
  const blocks = icsText.split('BEGIN:VEVENT').slice(1);
  for (const block of blocks) {
    const summary = block.match(/SUMMARY:(.+)/)?.[1]?.trim();
    const location = block.match(/LOCATION:(.+)/)?.[1]?.trim() || '';
    const dtstart = block.match(/DTSTART;VALUE=DATE:(\d+)/)?.[1];
    const dtend = block.match(/DTEND;VALUE=DATE:(\d+)/)?.[1];
    const url = block.match(/URL:(.+)/)?.[1]?.trim() || '';
    const uid = block.match(/UID:(.+)/)?.[1]?.trim() || '';
    if (!summary || !dtstart) continue;
    const startDate = `${dtstart.slice(0, 4)}-${dtstart.slice(4, 6)}-${dtstart.slice(6, 8)}`;
    const endDate = dtend ? `${dtend.slice(0, 4)}-${dtend.slice(4, 6)}-${dtend.slice(6, 8)}` : startDate;
    let type = 'other';
    if (summary.startsWith('Earnings:')) type = 'earnings';
    else if (summary.startsWith('IPO')) type = 'ipo';
    else if (location) type = 'conference';
    const coords = normalizeLocation(location || null);
    events.push({ id: uid, title: summary, type, location, coords: coords ?? undefined, startDate, endDate, url, source: 'techmeme', description: '' });
  }
  return events.sort((a, b) => a.startDate.localeCompare(b.startDate));
}

function parseDevEventsRSS(rssText) {
  const events = [];
  const itemMatches = rssText.matchAll(/<item>([\s\S]*?)<\/item>/g);
  for (const match of itemMatches) {
    const item = match[1];
    const title = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/);
    const link = item.match(/<link>(.*?)<\/link>/)?.[1] ?? '';
    const desc = item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>|<description>(.*?)<\/description>/s);
    const guid = item.match(/<guid[^>]*>(.*?)<\/guid>/)?.[1] ?? '';
    const titleStr = title ? (title[1] ?? title[2]) : null;
    if (!titleStr) continue;
    const dateMatch = (desc?.[1] ?? desc?.[2] ?? '').match(/on\s+(\w+\s+\d{1,2},?\s+\d{4})/i);
    let startDate = null;
    if (dateMatch) {
      const d = new Date(dateMatch[1]);
      if (!isNaN(d.getTime())) startDate = d.toISOString().slice(0, 10);
    }
    if (!startDate) continue;
    const eventDate = new Date(startDate);
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    if (eventDate < now) continue;
    let location = null;
    const locMatch = (desc?.[1] ?? desc?.[2] ?? '').match(/(?:in|at)\s+([A-Za-z\s]+,\s*[A-Za-z\s]+)(?:\.|$)/i);
    if (locMatch) location = locMatch[1].trim();
    if ((desc?.[1] ?? desc?.[2] ?? '').toLowerCase().includes('online')) location = 'Online';
    const coords = location && location !== 'Online' ? normalizeLocation(location) : (location === 'Online' ? { lat: 0, lng: 0, country: 'Virtual', original: 'Online', virtual: true } : null);
    events.push({ id: guid || `dev-events-${titleStr.slice(0, 20)}`, title: titleStr, type: 'conference', location: location || '', coords: coords ?? undefined, startDate, endDate: startDate, url: link, source: 'dev.events', description: '' });
  }
  return events;
}

const CURATED_TECH_EVENTS = [
  { id: 'step-dubai-2026', title: 'STEP Dubai 2026', type: 'conference', location: 'Dubai Internet City, Dubai', coords: { lat: 25.0956, lng: 55.1548, country: 'UAE', original: 'Dubai Internet City, Dubai', virtual: false }, startDate: '2026-02-11', endDate: '2026-02-12', url: 'https://dubai.stepconference.com', source: 'curated', description: 'Intelligence Everywhere: The AI Economy - 8,000+ attendees, 400+ startups' },
  { id: 'gitex-global-2026', title: 'GITEX Global 2026', type: 'conference', location: 'Dubai World Trade Centre, Dubai', coords: { lat: 25.2285, lng: 55.2867, country: 'UAE', original: 'Dubai World Trade Centre, Dubai', virtual: false }, startDate: '2026-12-07', endDate: '2026-12-11', url: 'https://www.gitex.com', source: 'curated', description: "World's largest tech & startup show" },
  { id: 'token2049-dubai-2026', title: 'TOKEN2049 Dubai 2026', type: 'conference', location: 'Dubai, UAE', coords: { lat: 25.2048, lng: 55.2708, country: 'UAE', original: 'Dubai, UAE', virtual: false }, startDate: '2026-04-29', endDate: '2026-04-30', url: 'https://www.token2049.com', source: 'curated', description: 'Premier crypto event in Dubai' },
  { id: 'collision-2026', title: 'Collision 2026', type: 'conference', location: 'Toronto, Canada', coords: { lat: 43.6532, lng: -79.3832, country: 'Canada', original: 'Toronto, Canada', virtual: false }, startDate: '2026-06-22', endDate: '2026-06-25', url: 'https://collisionconf.com', source: 'curated', description: "North America's fastest growing tech conference" },
  { id: 'web-summit-2026', title: 'Web Summit 2026', type: 'conference', location: 'Lisbon, Portugal', coords: { lat: 38.7223, lng: -9.1393, country: 'Portugal', original: 'Lisbon, Portugal', virtual: false }, startDate: '2026-11-02', endDate: '2026-11-05', url: 'https://websummit.com', source: 'curated', description: "The world's premier tech conference" },
];

async function fetchTechEvents() {
  const [icsRes, rssRes] = await Promise.allSettled([
    fetch('https://www.techmeme.com/newsy_events.ics', { headers: { 'User-Agent': CHROME_UA } }),
    fetch('https://dev.events/rss.xml', { headers: { 'User-Agent': CHROME_UA } }),
  ]);
  let events = [];
  if (icsRes.status === 'fulfilled' && icsRes.value.ok) events.push(...parseTechEventsICS(await icsRes.value.text()));
  if (rssRes.status === 'fulfilled' && rssRes.value.ok) events.push(...parseDevEventsRSS(await rssRes.value.text()));
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  for (const c of CURATED_TECH_EVENTS) {
    if (new Date(c.startDate) >= now) events.push(c);
  }
  const seen = new Set();
  events = events.filter((e) => {
    const key = e.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30) + e.startDate.slice(0, 4);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  events.sort((a, b) => a.startDate.localeCompare(b.startDate));
  const conferences = events.filter(e => e.type === 'conference');
  const mappableCount = conferences.filter(e => e.coords && !e.coords.virtual).length;
  return { success: true, count: events.length, conferenceCount: conferences.length, mappableCount, lastUpdated: new Date().toISOString(), events, error: '' };
}

// ── Medium Channels ──────────────────────────────────────────────────────────
const FRED_API_BASE = 'https://api.stlouisfed.org/fred';
const FRED_DASHBOARD_SERIES = [
  { id: 'WALCL', limit: 120 },
  { id: 'FEDFUNDS', limit: 120 },
  { id: 'T10Y2Y', limit: 120 },
  { id: 'UNRATE', limit: 120 },
  { id: 'CPIAUCSL', limit: 120 },
  { id: 'DGS10', limit: 120 },
  { id: 'VIXCLS', limit: 120 },
];

async function fetchFredSeries(seriesId, limit, apiKey) {
  const obsParams = new URLSearchParams({
    series_id: seriesId,
    api_key: apiKey,
    file_type: 'json',
    sort_order: 'desc',
    limit: String(limit),
  });
  const metaParams = new URLSearchParams({
    series_id: seriesId,
    api_key: apiKey,
    file_type: 'json',
  });
  const [obsRes, metaRes] = await Promise.all([
    fetch(`${FRED_API_BASE}/series/observations?${obsParams}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    }),
    fetch(`${FRED_API_BASE}/series?${metaParams}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    }),
  ]);
  if (!obsRes.ok) return null;
  const obsData = await obsRes.json();
  const observations = (obsData.observations || [])
    .map((obs) => {
      const value = parseFloat(obs.value);
      if (isNaN(value) || obs.value === '.') return null;
      return { date: obs.date, value };
    })
    .filter((o) => o !== null)
    .reverse();
  let title = seriesId;
  let units = '';
  let frequency = '';
  if (metaRes.ok) {
    const metaData = await metaRes.json();
    const meta = metaData.seriess?.[0];
    if (meta) {
      title = meta.title || seriesId;
      units = meta.units || '';
      frequency = meta.frequency || '';
    }
  }
  return { seriesId, title, units, frequency, observations };
}

async function fetchFred() {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) {
    console.warn('[relay] FRED_API_KEY not set — fred channel disabled');
    return null;
  }
  const results = await Promise.allSettled(
    FRED_DASHBOARD_SERIES.map(({ id, limit }) => fetchFredSeries(id, limit, apiKey))
  );
  const series = results
    .map((r) => (r.status === 'fulfilled' ? r.value : null))
    .filter((s) => s !== null);
  return series.length > 0 ? { series } : null;
}

const EIA_SERIES = [
  { commodity: 'wti', name: 'WTI Crude Oil', unit: '$/barrel', apiPath: '/v2/petroleum/pri/spt/data/', seriesFacet: 'RWTC' },
  { commodity: 'brent', name: 'Brent Crude Oil', unit: '$/barrel', apiPath: '/v2/petroleum/pri/spt/data/', seriesFacet: 'RBRTE' },
];

async function fetchEiaSeries(config, apiKey) {
  const params = new URLSearchParams({
    api_key: apiKey,
    'data[]': 'value',
    frequency: 'weekly',
    'facets[series][]': config.seriesFacet,
    'sort[0][column]': 'period',
    'sort[0][direction]': 'desc',
    length: '2',
  });
  const resp = await fetch(`https://api.eia.gov${config.apiPath}?${params}`, {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  const rows = data.response?.data;
  if (!rows || rows.length === 0) return null;
  const current = rows[0];
  const previous = rows[1];
  const price = current.value ?? 0;
  const prevPrice = previous?.value ?? price;
  const change = prevPrice !== 0 ? ((price - prevPrice) / prevPrice) * 100 : 0;
  const priceAt = current.period ? new Date(current.period).getTime() : Date.now();
  return {
    commodity: config.commodity,
    name: config.name,
    price,
    unit: config.unit,
    change: Math.round(change * 10) / 10,
    priceAt: Number.isFinite(priceAt) ? priceAt : Date.now(),
  };
}

async function fetchOil() {
  const apiKey = process.env.EIA_API_KEY;
  if (!apiKey) {
    console.warn('[relay] EIA_API_KEY not set — oil channel disabled');
    return null;
  }
  const results = await Promise.all(EIA_SERIES.map((s) => fetchEiaSeries(s, apiKey)));
  const prices = results.filter((p) => p !== null);
  return prices.length > 0 ? { prices } : null;
}

const BIS_BASE = 'https://stats.bis.org/api/v1/data';
const BIS_COUNTRIES = {
  US: { name: 'United States', centralBank: 'Federal Reserve' },
  GB: { name: 'United Kingdom', centralBank: 'Bank of England' },
  JP: { name: 'Japan', centralBank: 'Bank of Japan' },
  XM: { name: 'Euro Area', centralBank: 'ECB' },
  CH: { name: 'Switzerland', centralBank: 'Swiss National Bank' },
  SG: { name: 'Singapore', centralBank: 'MAS' },
  IN: { name: 'India', centralBank: 'Reserve Bank of India' },
  AU: { name: 'Australia', centralBank: 'RBA' },
  CN: { name: 'China', centralBank: "People's Bank of China" },
  CA: { name: 'Canada', centralBank: 'Bank of Canada' },
  KR: { name: 'South Korea', centralBank: 'Bank of Korea' },
  BR: { name: 'Brazil', centralBank: 'Banco Central do Brasil' },
};
const BIS_COUNTRY_KEYS = Object.keys(BIS_COUNTRIES).join('+');

function parseBisCsv(csv) {
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',').map((v) => v.trim());
    if (vals.length < headers.length) continue;
    const row = {};
    headers.forEach((h, idx) => { row[h] = vals[idx]; });
    rows.push(row);
  }
  return rows;
}

function parseBisNumber(val) {
  if (!val || val === '.' || val.trim() === '') return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

async function fetchBis() {
  const threeMonthsAgo = new Date();
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
  const startPeriod = `${threeMonthsAgo.getFullYear()}-${String(threeMonthsAgo.getMonth() + 1).padStart(2, '0')}`;
  const url = `${BIS_BASE}/WS_CBPOL/M.${BIS_COUNTRY_KEYS}?startPeriod=${startPeriod}&detail=dataonly&format=csv`;
  const res = await fetch(url, {
    headers: { 'User-Agent': CHROME_UA, Accept: 'text/csv' },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`BIS HTTP ${res.status}`);
  const csv = await res.text();
  const rows = parseBisCsv(csv);
  const byCountry = new Map();
  for (const row of rows) {
    const cc = row['REF_AREA'] || row['Reference area'] || '';
    const date = row['TIME_PERIOD'] || row['Time period'] || '';
    const val = parseBisNumber(row['OBS_VALUE'] || row['Observation value']);
    if (!cc || !date || val === null) continue;
    if (!byCountry.has(cc)) byCountry.set(cc, []);
    byCountry.get(cc).push({ date, value: val });
  }
  const rates = [];
  for (const [cc, obs] of byCountry) {
    const info = BIS_COUNTRIES[cc];
    if (!info) continue;
    obs.sort((a, b) => a.date.localeCompare(b.date));
    const latest = obs[obs.length - 1];
    const previous = obs.length >= 2 ? obs[obs.length - 2] : undefined;
    if (latest) {
      rates.push({
        countryCode: cc,
        countryName: info.name,
        rate: latest.value,
        previousRate: previous?.value ?? latest.value,
        date: latest.date,
        centralBank: info.centralBank,
      });
    }
  }
  return rates.length > 0 ? { rates } : null;
}

// Flights: FAA + AviationStack + NOTAM (simplified — no NOTAM ICAO API in relay)
const FAA_URL = 'https://nasstatus.faa.gov/api/airport-status-information';
const FAA_AIRPORTS = ['JFK', 'LAX', 'ORD', 'ATL', 'DFW', 'DEN', 'SFO', 'SEA', 'MIA', 'BOS', 'EWR', 'IAH', 'PHX', 'LAS'];
const MONITORED_AIRPORTS_PHASE3B = [
  { iata: 'JFK', icao: 'KJFK', name: 'John F. Kennedy International', city: 'New York', country: 'USA', lat: 40.6413, lon: -73.7781, region: 'americas' },
  { iata: 'LAX', icao: 'KLAX', name: 'Los Angeles International', city: 'Los Angeles', country: 'USA', lat: 33.9416, lon: -118.4085, region: 'americas' },
  { iata: 'ORD', icao: 'KORD', name: "O'Hare International", city: 'Chicago', country: 'USA', lat: 41.9742, lon: -87.9073, region: 'americas' },
  { iata: 'ATL', icao: 'KATL', name: 'Hartsfield-Jackson Atlanta', city: 'Atlanta', country: 'USA', lat: 33.6407, lon: -84.4277, region: 'americas' },
  { iata: 'DFW', icao: 'KDFW', name: 'Dallas/Fort Worth International', city: 'Dallas', country: 'USA', lat: 32.8998, lon: -97.0403, region: 'americas' },
  { iata: 'DEN', icao: 'KDEN', name: 'Denver International', city: 'Denver', country: 'USA', lat: 39.8561, lon: -104.6737, region: 'americas' },
  { iata: 'SFO', icao: 'KSFO', name: 'San Francisco International', city: 'San Francisco', country: 'USA', lat: 37.6213, lon: -122.379, region: 'americas' },
  { iata: 'SEA', icao: 'KSEA', name: 'Seattle-Tacoma International', city: 'Seattle', country: 'USA', lat: 47.4502, lon: -122.3088, region: 'americas' },
  { iata: 'MIA', icao: 'KMIA', name: 'Miami International', city: 'Miami', country: 'USA', lat: 25.7959, lon: -80.287, region: 'americas' },
  { iata: 'BOS', icao: 'KBOS', name: 'Boston Logan International', city: 'Boston', country: 'USA', lat: 42.3656, lon: -71.0096, region: 'americas' },
  { iata: 'EWR', icao: 'KEWR', name: 'Newark Liberty International', city: 'Newark', country: 'USA', lat: 40.6895, lon: -74.1745, region: 'americas' },
  { iata: 'IAH', icao: 'KIAH', name: 'George Bush Intercontinental', city: 'Houston', country: 'USA', lat: 29.9902, lon: -95.3368, region: 'americas' },
  { iata: 'PHX', icao: 'KPHX', name: 'Phoenix Sky Harbor', city: 'Phoenix', country: 'USA', lat: 33.4373, lon: -112.0078, region: 'americas' },
  { iata: 'LAS', icao: 'KLAS', name: 'Harry Reid International', city: 'Las Vegas', country: 'USA', lat: 36.084, lon: -115.1537, region: 'americas' },
  { iata: 'LHR', icao: 'EGLL', name: 'London Heathrow', city: 'London', country: 'UK', lat: 51.47, lon: -0.4543, region: 'europe' },
  { iata: 'CDG', icao: 'LFPG', name: 'Paris Charles de Gaulle', city: 'Paris', country: 'France', lat: 49.0097, lon: 2.5479, region: 'europe' },
  { iata: 'FRA', icao: 'EDDF', name: 'Frankfurt Airport', city: 'Frankfurt', country: 'Germany', lat: 50.0379, lon: 8.5622, region: 'europe' },
  { iata: 'DXB', icao: 'OMDB', name: 'Dubai International', city: 'Dubai', country: 'UAE', lat: 25.2532, lon: 55.3657, region: 'mena' },
  { iata: 'HND', icao: 'RJTT', name: 'Tokyo Haneda', city: 'Tokyo', country: 'Japan', lat: 35.5494, lon: 139.7798, region: 'apac' },
  { iata: 'SIN', icao: 'WSSS', name: 'Singapore Changi', city: 'Singapore', country: 'Singapore', lat: 1.3644, lon: 103.9915, region: 'apac' },
];

function toProtoRegion(r) {
  const map = { americas: 'AIRPORT_REGION_AMERICAS', europe: 'AIRPORT_REGION_EUROPE', apac: 'AIRPORT_REGION_APAC', mena: 'AIRPORT_REGION_MENA', africa: 'AIRPORT_REGION_AFRICA' };
  return map[r] || 'AIRPORT_REGION_UNSPECIFIED';
}
function toProtoDelayType(t) {
  const map = { ground_stop: 'FLIGHT_DELAY_TYPE_GROUND_STOP', ground_delay: 'FLIGHT_DELAY_TYPE_GROUND_DELAY', departure_delay: 'FLIGHT_DELAY_TYPE_DEPARTURE_DELAY', arrival_delay: 'FLIGHT_DELAY_TYPE_ARRIVAL_DELAY', general: 'FLIGHT_DELAY_TYPE_GENERAL', closure: 'FLIGHT_DELAY_TYPE_CLOSURE' };
  return map[t] || 'FLIGHT_DELAY_TYPE_GENERAL';
}
function toProtoSeverity(s) {
  const map = { normal: 'FLIGHT_DELAY_SEVERITY_NORMAL', minor: 'FLIGHT_DELAY_SEVERITY_MINOR', moderate: 'FLIGHT_DELAY_SEVERITY_MODERATE', major: 'FLIGHT_DELAY_SEVERITY_MAJOR', severe: 'FLIGHT_DELAY_SEVERITY_SEVERE' };
  return map[s] || 'FLIGHT_DELAY_SEVERITY_NORMAL';
}
function determineSeverity(avgDelay) {
  if (avgDelay >= 60) return 'severe';
  if (avgDelay >= 45) return 'major';
  if (avgDelay >= 30) return 'moderate';
  if (avgDelay >= 15) return 'minor';
  return 'normal';
}
function parseFaaXml(xml) {
  const delays = new Map();
  let root;
  try {
    const m = xml.match(/<AIRPORT_STATUS_INFORMATION[^>]*>([\s\S]*?)<\/AIRPORT_STATUS_INFORMATION>/);
    if (!m) return delays;
    root = m[1];
  } catch { return delays; }
  const groundDelayRe = /<Ground_Delay>[\s\S]*?<ARPT>([A-Z]{3})<\/ARPT>[\s\S]*?<Reason>([^<]*)<\/Reason>[\s\S]*?<Avg>(\d*)<\/Avg>/g;
  let gd;
  while ((gd = groundDelayRe.exec(root)) !== null) {
    delays.set(gd[1], { airport: gd[1], reason: gd[2] || 'Ground delay', avgDelay: parseInt(gd[3], 10) || 30, type: 'ground_delay' });
  }
  const groundStopRe = /<Ground_Stop>[\s\S]*?<ARPT>([A-Z]{3})<\/ARPT>[\s\S]*?<Reason>([^<]*)<\/Reason>/g;
  let gs;
  while ((gs = groundStopRe.exec(root)) !== null) {
    delays.set(gs[1], { airport: gs[1], reason: gs[2] || 'Ground stop', avgDelay: 60, type: 'ground_stop' });
  }
  const delayRe = /<Delay>[\s\S]*?<ARPT>([A-Z]{3})<\/ARPT>[\s\S]*?<Reason>([^<]*)<\/Reason>[\s\S]*?<Arrival_Delay>[\s\S]*?<Min>(\d*)<\/Min>[\s\S]*?<Max>(\d*)<\/Max>/g;
  let d;
  while ((d = delayRe.exec(root)) !== null) {
    const min = parseInt(d[3], 10) || 15;
    const max = parseInt(d[4], 10) || 30;
    if (!delays.has(d[1])) delays.set(d[1], { airport: d[1], reason: d[2] || 'Delays', avgDelay: Math.round((min + max) / 2), type: 'general' });
  }
  return delays;
}

async function fetchFlights() {
  const faaAlerts = [];
  try {
    const faaResp = await fetch(FAA_URL, {
      headers: { Accept: 'application/xml', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(15000),
    });
    let faaDelays = new Map();
    if (faaResp.ok) faaDelays = parseFaaXml(await faaResp.text());
    for (const iata of FAA_AIRPORTS) {
      const airport = MONITORED_AIRPORTS_PHASE3B.find((a) => a.iata === iata);
      if (!airport) continue;
      const d = faaDelays.get(iata);
      if (d) {
        faaAlerts.push({
          id: `faa-${iata}`,
          iata,
          icao: airport.icao,
          name: airport.name,
          city: airport.city,
          country: airport.country,
          location: { latitude: airport.lat, longitude: airport.lon },
          region: toProtoRegion(airport.region),
          delayType: toProtoDelayType(d.type),
          severity: toProtoSeverity(determineSeverity(d.avgDelay)),
          avgDelayMinutes: d.avgDelay,
          delayedFlightsPct: 0,
          cancelledFlights: 0,
          totalFlights: 0,
          reason: d.reason,
          source: 'FLIGHT_DELAY_SOURCE_FAA',
          updatedAt: Date.now(),
        });
      }
    }
  } catch (err) {
    console.warn('[relay] flights FAA fetch failed:', err?.message ?? err);
  }
  const apiKey = process.env.AVIATIONSTACK_API_KEY || process.env.AVIATIONSTACK_API;
  let intlAlerts = [];
  if (apiKey) {
    try {
      const nonUs = MONITORED_AIRPORTS_PHASE3B.filter((a) => a.country !== 'USA');
      for (const airport of nonUs.slice(0, 10)) {
        const url = `https://api.aviationstack.com/v1/flights?access_key=${apiKey}&dep_iata=${airport.iata}&limit=50`;
        const resp = await fetch(url, { headers: { 'User-Agent': CHROME_UA }, signal: AbortSignal.timeout(5000) });
        if (!resp.ok) continue;
        const json = await resp.json();
        if (json.error) continue;
        const flights = json?.data ?? [];
        let delayed = 0, cancelled = 0, totalDelay = 0;
        for (const f of flights) {
          if (f.flight_status === 'cancelled') cancelled++;
          if (f.departure?.delay && f.departure.delay > 0) { delayed++; totalDelay += f.departure.delay; }
        }
        const total = flights.length;
        if (total < 5) continue;
        const cancelledPct = (cancelled / total) * 100;
        const avgDelay = delayed > 0 ? Math.round(totalDelay / delayed) : 0;
        let severity = 'normal', reason = 'Normal operations';
        if (cancelledPct >= 50 && total >= 10) { severity = 'major'; reason = `${Math.round(cancelledPct)}% flights cancelled`; }
        else if (cancelledPct >= 20 && total >= 10) { severity = 'moderate'; reason = `${Math.round(cancelledPct)}% flights cancelled`; }
        else if (avgDelay > 0) { severity = determineSeverity(avgDelay); reason = `Avg ${avgDelay}min delay`; }
        if (severity === 'normal') continue;
        intlAlerts.push({
          id: `avstack-${airport.iata}`,
          iata: airport.iata,
          icao: airport.icao,
          name: airport.name,
          city: airport.city,
          country: airport.country,
          location: { latitude: airport.lat, longitude: airport.lon },
          region: toProtoRegion(airport.region),
          delayType: toProtoDelayType(avgDelay >= 60 ? 'ground_delay' : 'general'),
          severity: toProtoSeverity(severity),
          avgDelayMinutes: avgDelay,
          delayedFlightsPct: Math.round((delayed / total) * 100),
          cancelledFlights: cancelled,
          totalFlights: total,
          reason,
          source: 'FLIGHT_DELAY_SOURCE_COMPUTED',
          updatedAt: Date.now(),
        });
      }
    } catch (err) {
      console.warn('[relay] flights intl fetch failed:', err?.message ?? err);
    }
  }
  const allAlerts = [...faaAlerts, ...intlAlerts];
  const alertedIatas = new Set(allAlerts.map((a) => a.iata));
  for (const airport of MONITORED_AIRPORTS_PHASE3B) {
    if (!alertedIatas.has(airport.iata)) {
      allAlerts.push({
        id: `status-${airport.iata}`,
        iata: airport.iata,
        icao: airport.icao,
        name: airport.name,
        city: airport.city,
        country: airport.country,
        location: { latitude: airport.lat, longitude: airport.lon },
        region: toProtoRegion(airport.region),
        delayType: 'FLIGHT_DELAY_TYPE_GENERAL',
        severity: 'FLIGHT_DELAY_SEVERITY_NORMAL',
        avgDelayMinutes: 0,
        delayedFlightsPct: 0,
        cancelledFlights: 0,
        totalFlights: 0,
        reason: 'Normal operations',
        source: 'FLIGHT_DELAY_SOURCE_COMPUTED',
        updatedAt: Date.now(),
      });
    }
  }
  return { alerts: allAlerts };
}

// Aviation pre-cache: FAA, intl, NOTAM (for list-airport-delays cache)
const AVIATION_CACHE_TTL = 14400;
async function runAviationPreCache() {
  const faaAlerts = [];
  try {
    const faaResp = await fetch(FAA_URL, {
      headers: { Accept: 'application/xml', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(15000),
    });
    let faaDelays = new Map();
    if (faaResp.ok) faaDelays = parseFaaXml(await faaResp.text());
    for (const iata of FAA_AIRPORTS) {
      const airport = MONITORED_AIRPORTS_PHASE3B.find((a) => a.iata === iata);
      if (!airport) continue;
      const d = faaDelays.get(iata);
      if (d) {
        faaAlerts.push({
          id: `faa-${iata}`,
          iata,
          icao: airport.icao,
          name: airport.name,
          city: airport.city,
          country: airport.country,
          location: { latitude: airport.lat, longitude: airport.lon },
          region: toProtoRegion(airport.region),
          delayType: toProtoDelayType(d.type),
          severity: toProtoSeverity(determineSeverity(d.avgDelay)),
          avgDelayMinutes: d.avgDelay,
          delayedFlightsPct: 0,
          cancelledFlights: 0,
          totalFlights: 0,
          reason: d.reason,
          source: 'FLIGHT_DELAY_SOURCE_FAA',
          updatedAt: Date.now(),
        });
      }
    }
    await redisSetex('aviation:delays:faa:v1', AVIATION_CACHE_TTL, { alerts: faaAlerts });
    console.log(`[relay] aviation pre-cache FAA: ${faaAlerts.length} alerts`);
  } catch (err) {
    console.warn('[relay] aviation pre-cache FAA failed:', err?.message ?? err);
  }
  const apiKey = process.env.AVIATIONSTACK_API_KEY || process.env.AVIATIONSTACK_API;
  if (apiKey) {
    try {
      const nonUs = MONITORED_AIRPORTS_PHASE3B.filter((a) => a.country !== 'USA');
      const intlAlerts = [];
      for (const airport of nonUs.slice(0, 15)) {
        const url = `https://api.aviationstack.com/v1/flights?access_key=${apiKey}&dep_iata=${airport.iata}&limit=50`;
        const resp = await fetch(url, { headers: { 'User-Agent': CHROME_UA }, signal: AbortSignal.timeout(5000) });
        if (!resp.ok) continue;
        const json = await resp.json();
        if (json.error) continue;
        const flights = json?.data ?? [];
        let delayed = 0, cancelled = 0, totalDelay = 0;
        for (const f of flights) {
          if (f.flight_status === 'cancelled') cancelled++;
          if (f.departure?.delay && f.departure.delay > 0) { delayed++; totalDelay += f.departure.delay; }
        }
        const total = flights.length;
        if (total < 5) continue;
        const cancelledPct = (cancelled / total) * 100;
        const avgDelay = delayed > 0 ? Math.round(totalDelay / delayed) : 0;
        let severity = 'normal', reason = 'Normal operations';
        if (cancelledPct >= 50 && total >= 10) { severity = 'major'; reason = `${Math.round(cancelledPct)}% flights cancelled`; }
        else if (cancelledPct >= 20 && total >= 10) { severity = 'moderate'; reason = `${Math.round(cancelledPct)}% flights cancelled`; }
        else if (avgDelay > 0) { severity = determineSeverity(avgDelay); reason = `Avg ${avgDelay}min delay`; }
        if (severity === 'normal') continue;
        intlAlerts.push({
          id: `avstack-${airport.iata}`,
          iata: airport.iata,
          icao: airport.icao,
          name: airport.name,
          city: airport.city,
          country: airport.country,
          location: { latitude: airport.lat, longitude: airport.lon },
          region: toProtoRegion(airport.region),
          delayType: toProtoDelayType(avgDelay >= 60 ? 'ground_delay' : 'general'),
          severity: toProtoSeverity(severity),
          avgDelayMinutes: avgDelay,
          delayedFlightsPct: Math.round((delayed / total) * 100),
          cancelledFlights: cancelled,
          totalFlights: total,
          reason,
          source: 'FLIGHT_DELAY_SOURCE_COMPUTED',
          updatedAt: Date.now(),
        });
      }
      await redisSetex('aviation:delays:intl:v3', AVIATION_CACHE_TTL, { alerts: intlAlerts });
      console.log(`[relay] aviation pre-cache intl: ${intlAlerts.length} alerts`);
    } catch (err) {
      console.warn('[relay] aviation pre-cache intl failed:', err?.message ?? err);
    }
  }
  await redisSetex('aviation:notam:closures:v1', AVIATION_CACHE_TTL, { closedIcaos: [], reasons: {} });
}

const FIRMS_SOURCE = 'VIIRS_SNPP_NRT';
const MONITORED_REGIONS = {
  'Ukraine': '22,44,40,53',
  'Russia': '20,50,180,82',
  'Iran': '44,25,63,40',
  'Israel/Gaza': '34,29,36,34',
  'Syria': '35,32,42,37',
  'Taiwan': '119,21,123,26',
  'North Korea': '124,37,131,43',
  'Saudi Arabia': '34,16,56,32',
  'Turkey': '26,36,45,42',
};

function mapFireConfidence(c) {
  const v = (c || '').toLowerCase();
  if (v === 'h') return 'FIRE_CONFIDENCE_HIGH';
  if (v === 'n') return 'FIRE_CONFIDENCE_NOMINAL';
  if (v === 'l') return 'FIRE_CONFIDENCE_LOW';
  return 'FIRE_CONFIDENCE_UNSPECIFIED';
}

function parseFirmsCsv(csv) {
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',').map((v) => v.trim());
    if (vals.length < headers.length) continue;
    const row = {};
    headers.forEach((h, idx) => { row[h] = vals[idx]; });
    rows.push(row);
  }
  return rows;
}

function parseDetectedAt(acqDate, acqTime) {
  const padded = String(acqTime || '').padStart(4, '0');
  return new Date(`${acqDate || '1970-01-01'}T${padded.slice(0, 2)}:${padded.slice(2)}:00Z`).getTime();
}

async function fetchNatural() {
  const apiKey = process.env.NASA_FIRMS_API_KEY || process.env.FIRMS_API_KEY;
  if (!apiKey) {
    console.warn('[relay] NASA_FIRMS_API_KEY not set — natural channel disabled');
    return null;
  }
  const entries = Object.entries(MONITORED_REGIONS);
  const results = await Promise.allSettled(
    entries.map(async ([regionName, bbox]) => {
      const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${apiKey}/${FIRMS_SOURCE}/${bbox}/1`;
      const res = await fetch(url, {
        headers: { Accept: 'text/csv', 'User-Agent': CHROME_UA },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`FIRMS ${res.status}`);
      const csv = await res.text();
      const rows = parseFirmsCsv(csv);
      return { regionName, rows };
    })
  );
  const fireDetections = [];
  for (const r of results) {
    if (r.status === 'fulfilled') {
      const { regionName, rows } = r.value;
      for (const row of rows) {
        fireDetections.push({
          id: `${row.latitude ?? ''}-${row.longitude ?? ''}-${row.acq_date ?? ''}-${row.acq_time ?? ''}`,
          location: { latitude: parseFloat(row.latitude ?? '0') || 0, longitude: parseFloat(row.longitude ?? '0') || 0 },
          brightness: parseFloat(row.bright_ti4 ?? '0') || 0,
          frp: parseFloat(row.frp ?? '0') || 0,
          confidence: mapFireConfidence(row.confidence),
          satellite: row.satellite || '',
          detectedAt: parseDetectedAt(row.acq_date, row.acq_time),
          region: regionName,
          dayNight: row.daynight || '',
        });
      }
    }
  }
  return fireDetections.length > 0 ? { fireDetections, pagination: undefined } : null;
}

async function fetchWeather() {
  const res = await fetch('https://api.weather.gov/alerts/active', {
    headers: { 'User-Agent': 'WorldMonitor/1.0' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const features = data.features || [];
  const alerts = features
    .filter((a) => a.properties?.severity !== 'Unknown')
    .slice(0, 50)
    .map((a) => {
      const p = a.properties || {};
      let coords = [];
      if (a.geometry?.type === 'Polygon' && a.geometry.coordinates?.[0]) {
        coords = a.geometry.coordinates[0].map((c) => [c[0], c[1]]);
      } else if (a.geometry?.type === 'MultiPolygon' && a.geometry.coordinates?.[0]?.[0]) {
        coords = a.geometry.coordinates[0][0].map((c) => [c[0], c[1]]);
      }
      const centroid = coords.length > 0
        ? [coords.reduce((s, c) => s + c[0], 0) / coords.length, coords.reduce((s, c) => s + c[1], 0) / coords.length]
        : undefined;
      return {
        id: a.id,
        event: p.event || '',
        severity: p.severity || 'Unknown',
        headline: p.headline || '',
        description: (p.description || '').slice(0, 500),
        areaDesc: p.areaDesc || '',
        onset: p.onset ? new Date(p.onset).toISOString() : new Date().toISOString(),
        expires: p.expires ? new Date(p.expires).toISOString() : new Date().toISOString(),
        coordinates: coords,
        centroid,
      };
    });
  return alerts;
}

async function fetchEonet() {
  const res = await fetch('https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=30', {
    headers: { 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const events = [];
  const now = Date.now();
  const WILDFIRE_MAX_AGE_MS = 48 * 60 * 60 * 1000;
  for (const event of data.events || []) {
    const category = event.categories?.[0];
    if (!category || category.id === 'earthquakes') continue;
    const latestGeo = event.geometry?.[event.geometry.length - 1];
    if (!latestGeo || latestGeo.type !== 'Point') continue;
    const eventDate = new Date(latestGeo.date).getTime();
    if (category.id === 'wildfires' && now - eventDate > WILDFIRE_MAX_AGE_MS) continue;
    const [lon, lat] = latestGeo.coordinates || [0, 0];
    const source = event.sources?.[0];
    events.push({
      id: event.id,
      title: event.title,
      description: event.description || undefined,
      category: category.id,
      categoryTitle: category.title,
      lat,
      lon,
      date: new Date(latestGeo.date),
      magnitude: latestGeo.magnitudeValue,
      magnitudeUnit: latestGeo.magnitudeUnit,
      sourceUrl: source?.url,
      sourceName: source?.id,
      closed: event.closed !== null,
    });
  }
  return events;
}

// Fetches global climate anomaly data from NOAA NCEI.
// Returns { anomalies: [] } matching ListClimateAnomaliesResponse proto shape.
async function fetchClimateAnomaliesData() {
  const currentYear = new Date().getFullYear();
  const url = `https://www.ncei.noaa.gov/access/monitoring/climate-at-a-glance/global/time-series/globe/land_ocean/ann/1/1990-${currentYear}.json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`NOAA NCEI HTTP ${res.status}`);
  const json = await res.json();
  const entries = Object.entries(json.data ?? {});
  const anomalies = [];
  for (const [period, rawValue] of entries) {
    const value = parseFloat(rawValue);
    if (isNaN(value)) continue;
    const absVal = Math.abs(value);
    const severity = absVal >= 1.0 ? 'ANOMALY_SEVERITY_EXTREME' : absVal >= 0.5 ? 'ANOMALY_SEVERITY_MODERATE' : null;
    if (!severity) continue;
    anomalies.push({
      zone: 'Global',
      location: { latitude: 0, longitude: 0 },
      tempDelta: value,
      precipDelta: 0,
      severity,
      type: value > 0 ? 'ANOMALY_TYPE_WARM' : 'ANOMALY_TYPE_COLD',
      period,
    });
  }
  return { anomalies: anomalies.slice(-12) };
}

async function fetchGdacs() {
  const res = await fetch('https://www.gdacs.org/gdacsapi/api/events/geteventlist/MAP', {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const features = data.features || [];
  const seen = new Set();
  const EVENT_TYPE_NAMES = { EQ: 'Earthquake', FL: 'Flood', TC: 'Tropical Cyclone', VO: 'Volcano', WF: 'Wildfire', DR: 'Drought' };
  const events = features
    .filter((f) => f.geometry?.type === 'Point')
    .filter((f) => {
      const key = `${f.properties?.eventtype}-${f.properties?.eventid}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return f.properties?.alertlevel !== 'Green';
    })
    .slice(0, 100)
    .map((f) => ({
      id: `gdacs-${f.properties.eventtype}-${f.properties.eventid}`,
      eventType: f.properties.eventtype,
      name: f.properties.name,
      description: f.properties.description || EVENT_TYPE_NAMES[f.properties.eventtype] || f.properties.eventtype,
      alertLevel: f.properties.alertlevel,
      country: f.properties.country,
      coordinates: f.geometry.coordinates,
      fromDate: f.properties.fromdate,
      severity: f.properties.severitydata?.severitytext || '',
      url: f.properties.url?.report || '',
    }));
  return events;
}

async function fetchGpsInterference() {
  const manifestResp = await fetch('https://gpsjam.org/data/manifest.csv', {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WorldMonitor/1.0)' },
    signal: AbortSignal.timeout(10000),
  });
  if (!manifestResp.ok) throw new Error(`Manifest HTTP ${manifestResp.status}`);
  const manifest = await manifestResp.text();
  const lines = manifest.trim().split('\n');
  const latestDate = lines[lines.length - 1]?.split(',')[0];
  if (!latestDate) throw new Error('No manifest date');
  const hexResp = await fetch(`https://gpsjam.org/data/${latestDate}-h3_4.csv`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WorldMonitor/1.0)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!hexResp.ok) throw new Error(`Hex data HTTP ${hexResp.status}`);
  const csv = await hexResp.text();
  const rows = csv.trim().split('\n');
  const hexes = [];
  const MIN_AIRCRAFT = 3;
  for (let i = 1; i < rows.length; i++) {
    const parts = rows[i].split(',');
    if (parts.length < 3) continue;
    const hex = parts[0];
    const good = parseInt(parts[1], 10);
    const bad = parseInt(parts[2], 10);
    const total = good + bad;
    if (total < MIN_AIRCRAFT) continue;
    const pct = (bad / total) * 100;
    let level;
    if (pct > 10) level = 'high';
    else if (pct >= 2) level = 'medium';
    else continue;
    hexes.push({ h3: hex, pct: Math.round(pct * 10) / 10, good, bad, total, level });
  }
  hexes.sort((a, b) => {
    if (a.level !== b.level) return a.level === 'high' ? -1 : 1;
    return b.pct - a.pct;
  });
  return {
    date: latestDate,
    fetchedAt: new Date().toISOString(),
    source: 'gpsjam.org',
    stats: { totalHexes: rows.length - 1, highCount: hexes.filter((h) => h.level === 'high').length, mediumCount: hexes.filter((h) => h.level === 'medium').length },
    hexes,
  };
}

const CABLE_KEYWORDS = ['CABLE', 'CABLESHIP', 'CABLE SHIP', 'CABLE LAYING', 'CABLE OPERATIONS', 'SUBMARINE CABLE', 'UNDERSEA CABLE', 'FIBER OPTIC', 'TELECOMMUNICATIONS CABLE'];
const FAULT_KEYWORDS = /FAULT|BREAK|CUT|DAMAGE|SEVERED|RUPTURE|OUTAGE|FAILURE/i;
const CABLE_NAME_MAP = { 'MAREA': 'marea', 'GRACE HOPPER': 'grace_hopper', 'HAVFRUE': 'havfrue', 'FASTER': 'faster', 'SOUTHERN CROSS': 'southern_cross', 'CURIE': 'curie', 'SEA-ME-WE': 'seamewe6', 'SEAMEWE': 'seamewe6', 'SMW6': 'seamewe6', 'FLAG': 'flag', '2AFRICA': '2africa', 'WACS': 'wacs', 'EASSY': 'eassy', 'SAM-1': 'sam1', 'SAM1': 'sam1', 'ELLALINK': 'ellalink', 'APG': 'apg', 'INDIGO': 'indigo', 'SJC': 'sjc', 'FARICE': 'farice', 'FALCON': 'falcon' };
const CABLE_LANDINGS = {
  marea: [[36.85, -75.98], [43.26, -2.93]],
  grace_hopper: [[40.57, -73.97], [50.83, -4.55], [43.26, -2.93]],
  havfrue: [[40.22, -74.01], [58.15, 8.0], [55.56, 8.13]],
  faster: [[43.37, -124.22], [34.95, 139.95], [34.32, 136.85]],
  southern_cross: [[-33.87, 151.21], [-36.85, 174.76], [33.74, -118.27]],
  curie: [[33.74, -118.27], [-33.05, -71.62]],
  seamewe6: [[1.35, 103.82], [19.08, 72.88], [25.13, 56.34], [21.49, 39.19], [29.97, 32.55], [43.3, 5.37]],
  flag: [[50.04, -5.66], [31.2, 29.92], [25.2, 55.27], [19.08, 72.88], [1.35, 103.82], [35.69, 139.69]],
  '2africa': [[50.83, -4.55], [38.72, -9.14], [14.69, -17.44], [6.52, 3.38], [-33.93, 18.42], [-4.04, 39.67], [21.49, 39.19], [31.26, 32.3]],
  wacs: [[-33.93, 18.42], [6.52, 3.38], [14.69, -17.44], [38.72, -9.14], [51.51, -0.13]],
  eassy: [[-29.85, 31.02], [-25.97, 32.58], [-6.8, 39.28], [-4.04, 39.67], [11.59, 43.15]],
  sam1: [[-22.91, -43.17], [-34.6, -58.38], [26.36, -80.08]],
  ellalink: [[38.72, -9.14], [-3.72, -38.52]],
  apg: [[35.69, 139.69], [25.15, 121.44], [22.29, 114.17], [1.35, 103.82]],
  indigo: [[-31.95, 115.86], [1.35, 103.82], [-6.21, 106.85]],
  sjc: [[35.69, 139.69], [36.07, 120.32], [1.35, 103.82], [22.29, 114.17]],
  farice: [[64.13, -21.9], [62.01, -6.77], [55.95, -3.19]],
  falcon: [[25.13, 56.34], [23.59, 58.38], [26.23, 50.59], [29.38, 47.98]],
};

function isCableRelated(text) {
  return CABLE_KEYWORDS.some((kw) => (text || '').toUpperCase().includes(kw));
}

function parseCoordinates(text) {
  const coords = [];
  const dms = /(\d{1,3})-(\d{1,2}(?:\.\d+)?)\s*([NS])\s+(\d{1,3})-(\d{1,2}(?:\.\d+)?)\s*([EW])/gi;
  let m;
  while ((m = dms.exec(text)) !== null) {
    let lat = parseInt(m[1], 10) + parseFloat(m[2]) / 60;
    let lon = parseInt(m[4], 10) + parseFloat(m[5]) / 60;
    if (m[3].toUpperCase() === 'S') lat = -lat;
    if (m[6].toUpperCase() === 'W') lon = -lon;
    if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) coords.push([lat, lon]);
  }
  return coords;
}

function matchCableByName(text) {
  const upper = (text || '').toUpperCase();
  for (const [name, id] of Object.entries(CABLE_NAME_MAP)) {
    if (upper.includes(name)) return id;
  }
  return null;
}

function findNearestCable(lat, lon) {
  let bestId = null;
  let bestDist = Infinity;
  const MAX_DIST_KM = 555;
  const cosLat = Math.cos(lat * Math.PI / 180);
  for (const [cableId, landings] of Object.entries(CABLE_LANDINGS)) {
    for (const [lLat, lLon] of landings) {
      const dLat = (lat - lLat) * 111;
      const dLon = (lon - lLon) * 111 * cosLat;
      const distKm = Math.sqrt(dLat ** 2 + dLon ** 2);
      if (distKm < bestDist && distKm < MAX_DIST_KM) {
        bestDist = distKm;
        bestId = cableId;
      }
    }
  }
  return bestId ? { cableId: bestId, distanceKm: bestDist } : null;
}

const MONTH_MAP = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

function parseIssueDate(dateStr) {
  const m = (dateStr || '').match(/(\d{2})(\d{4})Z\s+([A-Z]{3})\s+(\d{4})/i);
  if (!m) return 0;
  const d = new Date(Date.UTC(parseInt(m[4], 10), MONTH_MAP[m[3].toUpperCase()] ?? 0, parseInt(m[1], 10), parseInt(m[2].slice(0, 2), 10), parseInt(m[2].slice(2, 4), 10)));
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

function processNgaSignals(warnings) {
  const signals = [];
  const cableWarnings = (warnings || []).filter((w) => isCableRelated(w.text || ''));
  for (const warning of cableWarnings) {
    const text = warning.text || '';
    const ts = parseIssueDate(warning.issueDate);
    const coords = parseCoordinates(text);
    let cableId = matchCableByName(text);
    let joinMethod = 'name';
    let distanceKm = 0;
    if (!cableId && coords.length > 0) {
      const centLat = coords.reduce((s, c) => s + c[0], 0) / coords.length;
      const centLon = coords.reduce((s, c) => s + c[1], 0) / coords.length;
      const nearest = findNearestCable(centLat, centLon);
      if (nearest) { cableId = nearest.cableId; joinMethod = 'geometry'; distanceKm = Math.round(nearest.distanceKm); }
    }
    if (!cableId) continue;
    const isFault = FAULT_KEYWORDS.test(text);
    const summaryText = text.slice(0, 150) + (text.length > 150 ? '...' : '');
    if (isFault) {
      signals.push({ cableId, ts, severity: 1.0, confidence: joinMethod === 'name' ? 0.9 : Math.max(0.4, 0.8 - distanceKm / 500), ttlSeconds: 5 * 86400, kind: 'operator_fault', evidence: [{ source: 'NGA', summary: `Fault/damage: ${summaryText}`, ts }] });
    } else {
      signals.push({ cableId, ts, severity: 0.6, confidence: joinMethod === 'name' ? 0.8 : Math.max(0.3, 0.7 - distanceKm / 500), ttlSeconds: 3 * 86400, kind: 'cable_advisory', evidence: [{ source: 'NGA', summary: `Advisory: ${summaryText}`, ts }] });
    }
  }
  return signals;
}

function computeHealthMap(signals) {
  const now = Date.now();
  const byCable = {};
  for (const sig of signals) {
    if (!byCable[sig.cableId]) byCable[sig.cableId] = [];
    byCable[sig.cableId].push(sig);
  }
  const healthMap = {};
  for (const [cableId, cableSignals] of Object.entries(byCable)) {
    const effectiveSignals = [];
    for (const sig of cableSignals) {
      const ageMs = now - sig.ts;
      const recencyWeight = Math.max(0, Math.min(1, 1 - (ageMs / 1000) / sig.ttlSeconds));
      if (recencyWeight <= 0) continue;
      const effective = sig.severity * sig.confidence * recencyWeight;
      effectiveSignals.push({ ...sig, effective, recencyWeight });
    }
    if (effectiveSignals.length === 0) continue;
    effectiveSignals.sort((a, b) => b.effective - a.effective);
    const top = effectiveSignals[0];
    const hasOperatorFault = effectiveSignals.some((s) => s.kind === 'operator_fault' && s.effective >= 0.5);
    const hasRepairActivity = effectiveSignals.some((s) => s.kind === 'repair_activity' && s.effective >= 0.4);
    let status;
    if (top.effective >= 0.8 && hasOperatorFault) status = 'CABLE_HEALTH_STATUS_FAULT';
    else if (top.effective >= 0.8 && hasRepairActivity) status = 'CABLE_HEALTH_STATUS_DEGRADED';
    else if (top.effective >= 0.5) status = 'CABLE_HEALTH_STATUS_DEGRADED';
    else status = 'CABLE_HEALTH_STATUS_OK';
    healthMap[cableId] = {
      status,
      score: Math.round(top.effective * 100) / 100,
      confidence: Math.round(top.confidence * top.recencyWeight * 100) / 100,
      lastUpdated: top.ts,
      evidence: effectiveSignals.slice(0, 3).flatMap((s) => s.evidence).slice(0, 3),
    };
  }
  return healthMap;
}

async function fetchCables() {
  const res = await fetch('https://msi.nga.mil/api/publications/broadcast-warn?output=json&status=A', {
    headers: { 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return { generatedAt: Date.now(), cables: {} };
  const data = await res.json();
  const warnings = Array.isArray(data) ? data : data?.warnings ?? [];
  const signals = processNgaSignals(warnings);
  const cables = computeHealthMap(signals);
  return { generatedAt: Date.now(), cables };
}

// Cyber: simplified — Feodo + URLhaus only (no GeoIP in relay)
const FEODO_URL = 'https://feodotracker.abuse.ch/downloads/ipblocklist.json';
const URLHAUS_RECENT_URL = (limit) => `https://urlhaus-api.abuse.ch/v1/urls/recent/limit/${limit}/`;

async function fetchFeodoThreats(limit, cutoffMs) {
  try {
    const res = await fetch(FEODO_URL, { headers: { 'User-Agent': CHROME_UA }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const data = await res.json();
    const list = data || [];
    return list
      .filter((t) => t.ip_address && t.first_seen_utc)
      .slice(0, limit)
      .map((t) => {
        const firstSeen = new Date(t.first_seen_utc).getTime();
        if (firstSeen < cutoffMs) return null;
        return {
          id: `feodo:${t.ip_address}`,
          type: 'c2_server',
          source: 'feodo',
          indicator: t.ip_address,
          indicatorType: 'ip',
          lat: null,
          lon: null,
          country: (t.country || '').toUpperCase().slice(0, 2),
          severity: 'high',
          firstSeen,
          lastSeen: new Date(t.last_seen_utc || t.first_seen_utc).getTime(),
        };
      })
      .filter((t) => t !== null);
  } catch { return []; }
}

async function fetchUrlhausThreats(limit, cutoffMs) {
  try {
    const res = await fetch(URLHAUS_RECENT_URL(limit), { headers: { 'User-Agent': CHROME_UA }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const data = await res.json();
    const urls = data?.urls || [];
    return urls
      .filter((u) => u.url && u.date_added)
      .slice(0, limit)
      .map((u) => {
        const firstSeen = new Date(u.date_added).getTime();
        if (firstSeen < cutoffMs) return null;
        return {
          id: `urlhaus:${u.id || u.url}`,
          type: 'malicious_url',
          source: 'urlhaus',
          indicator: u.url,
          indicatorType: 'url',
          lat: null,
          lon: null,
          country: '',
          severity: 'medium',
          firstSeen,
          lastSeen: firstSeen,
        };
      })
      .filter((t) => t !== null);
  } catch { return []; }
}

function toProtoCyberThreat(t) {
  return {
    id: t.id,
    indicator: t.indicator,
    indicatorType: t.indicatorType === 'ip' ? 'CYBER_THREAT_INDICATOR_TYPE_IP' : t.indicatorType === 'domain' ? 'CYBER_THREAT_INDICATOR_TYPE_DOMAIN' : 'CYBER_THREAT_INDICATOR_TYPE_URL',
    country: t.country || '',
    firstSeenAt: t.firstSeen,
    lastSeenAt: t.lastSeen,
    type: t.type === 'c2_server' ? 'CYBER_THREAT_TYPE_C2_SERVER' : t.type === 'malware_host' ? 'CYBER_THREAT_TYPE_MALWARE_HOST' : t.type === 'phishing' ? 'CYBER_THREAT_TYPE_PHISHING' : 'CYBER_THREAT_TYPE_MALICIOUS_URL',
    source: t.source === 'feodo' ? 'CYBER_THREAT_SOURCE_FEODO' : t.source === 'urlhaus' ? 'CYBER_THREAT_SOURCE_URLHAUS' : 'CYBER_THREAT_SOURCE_C2INTEL',
    severity: t.severity === 'critical' ? 'CRITICALITY_LEVEL_CRITICAL' : t.severity === 'high' ? 'CRITICALITY_LEVEL_HIGH' : t.severity === 'medium' ? 'CRITICALITY_LEVEL_MEDIUM' : 'CRITICALITY_LEVEL_LOW',
  };
}

async function fetchCyber() {
  const now = Date.now();
  const cutoffMs = now - 14 * 24 * 60 * 60 * 1000;
  const [feodo, urlhaus] = await Promise.all([
    fetchFeodoThreats(500, cutoffMs),
    fetchUrlhausThreats(500, cutoffMs),
  ]);
  const combined = [...feodo, ...urlhaus];
  const threats = combined.slice(0, 500).map(toProtoCyberThreat);
  return { threats };
}

// Service status: simplified — fetch statuspage JSON for key services
const SERVICE_STATUS_PAGES = [
  { id: 'aws', name: 'AWS', url: 'https://health.aws.amazon.com/health/status' },
  { id: 'cloudflare', name: 'Cloudflare', url: 'https://www.cloudflarestatus.com/api/v2/status.json' },
  { id: 'vercel', name: 'Vercel', url: 'https://www.vercel-status.com/api/v2/status.json' },
  { id: 'github', name: 'GitHub', url: 'https://www.githubstatus.com/api/v2/status.json' },
  { id: 'npm', name: 'npm', url: 'https://status.npmjs.org/api/v2/status.json' },
  { id: 'openai', name: 'OpenAI', url: 'https://status.openai.com/api/v2/status.json' },
  { id: 'supabase', name: 'Supabase', url: 'https://status.supabase.com/api/v2/status.json' },
];

function normalizeStatus(indicator) {
  const v = (indicator || '').toLowerCase();
  if (v === 'none' || v === 'operational' || v.includes('all systems')) return 'SERVICE_OPERATIONAL_STATUS_OPERATIONAL';
  if (v === 'minor' || v.includes('degraded')) return 'SERVICE_OPERATIONAL_STATUS_DEGRADED';
  if (v === 'partial_outage') return 'SERVICE_OPERATIONAL_STATUS_PARTIAL_OUTAGE';
  if (v === 'major' || v === 'critical' || v.includes('outage')) return 'SERVICE_OPERATIONAL_STATUS_MAJOR_OUTAGE';
  if (v.includes('maintenance')) return 'SERVICE_OPERATIONAL_STATUS_MAINTENANCE';
  return 'SERVICE_OPERATIONAL_STATUS_UNSPECIFIED';
}

async function fetchServiceStatus() {
  const results = await Promise.all(
    SERVICE_STATUS_PAGES.map(async (svc) => {
      const now = Date.now();
      try {
        const start = Date.now();
        const res = await fetch(svc.url, {
          headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
          signal: AbortSignal.timeout(10000),
        });
        const latencyMs = Date.now() - start;
        if (!res.ok) return { id: svc.id, name: svc.name, url: svc.url, status: 'SERVICE_OPERATIONAL_STATUS_UNSPECIFIED', description: `HTTP ${res.status}`, checkedAt: now, latencyMs };
        const data = await res.json();
        const indicator = data.status?.indicator || data.status?.status || '';
        const desc = data.status?.description || '';
        return { id: svc.id, name: svc.name, url: svc.url, status: normalizeStatus(indicator), description: desc, checkedAt: now, latencyMs };
      } catch {
        return { id: svc.id, name: svc.name, url: svc.url, status: 'SERVICE_OPERATIONAL_STATUS_UNSPECIFIED', description: 'Request failed', checkedAt: now, latencyMs: 0 };
      }
    })
  );
  return { statuses: results };
}

// ── Complex Channels ─────────────────────────────────────────────────────────
const PHASE3C_TIMEOUT_MS = 15_000;

async function fetchMarketSymbols() {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase.rpc('get_market_symbols');
    if (error || !data) return null;
    return data;
  } catch { return null; }
}

function isYahooOnlySymbol(s) {
  return s.startsWith('^') || s.includes('=');
}

async function fetchFinnhubQuote(symbol, apiKey) {
  try {
    const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}`;
    const resp = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': CHROME_UA, 'X-Finnhub-Token': apiKey },
      signal: AbortSignal.timeout(PHASE3C_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data.c === 0 && data.h === 0 && data.l === 0) return null;
    return { symbol, price: data.c, changePercent: data.dp };
  } catch { return null; }
}

async function fetchYahooQuote(symbol) {
  await yahooGate();
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(PHASE3C_TIMEOUT_MS),
  });
  if (!resp.ok) return null;
  const chart = await resp.json();
  const result = chart?.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0];
  const closes = (quote?.close || []).filter((v) => v != null);
  const price = closes.length > 0 ? closes[closes.length - 1] : result?.meta?.regularMarketPrice;
  const prev = closes.length >= 2 ? closes[closes.length - 2] : result?.chartPreviousClose;
  const change = prev && price ? ((price - prev) / prev) * 100 : 0;
  return price != null ? { price, change, sparkline: closes.slice(-48) } : null;
}

async function fetchCoinGeckoMarkets(ids) {
  if (!ids || ids.length === 0) return [];
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids.join(',')}&sparkline=true&price_change_percentage=24h`;
  const resp = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(PHASE3C_TIMEOUT_MS),
  });
  if (resp.status === 429) throw new Error('CoinGecko rate limited');
  if (!resp.ok) return [];
  return resp.json();
}

const CRYPTO_META = { bitcoin: { name: 'Bitcoin', symbol: 'BTC' }, ethereum: { name: 'Ethereum', symbol: 'ETH' }, solana: { name: 'Solana', symbol: 'SOL' }, ripple: { name: 'XRP', symbol: 'XRP' } };

async function fetchMarkets() {
  const config = await fetchMarketSymbols();
  if (!config) {
    return { stocks: [], commodities: [], sectors: [], crypto: [], finnhubSkipped: true, skipReason: 'Symbol config unavailable', rateLimited: false };
  }
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) console.warn('[relay] FINNHUB_API_KEY not set — markets will use Yahoo fallback only');

  const stockSymbols = (config.stock || []).map((s) => s.symbol);
  const commoditySymbols = (config.commodity || []).map((s) => s.symbol);
  const sectorSymbols = (config.sector || []).map((s) => s.symbol);
  const cryptoIds = (config.crypto || []).map((s) => s.symbol);

  const stockMeta = new Map((config.stock || []).map((e) => [e.symbol, e]));
  const commodityMeta = new Map((config.commodity || []).map((e) => [e.symbol, e]));
  const sectorMeta = new Map((config.sector || []).map((e) => [e.symbol, e]));

  const finnhubSymbols = stockSymbols.filter((s) => !isYahooOnlySymbol(s));
  const allFinnhubSymbols = apiKey ? [...finnhubSymbols, ...sectorSymbols] : [];
  const yahooStockSymbols = [...stockSymbols.filter(isYahooOnlySymbol), ...(!apiKey ? finnhubSymbols : [])];
  const yahooSectorFallback = !apiKey ? sectorSymbols : [];

  const [finnhubResults, yahooCommodityResults, yahooStockResults, yahooSectorResults, cryptoResults] = await Promise.allSettled([
    allFinnhubSymbols.length > 0 ? Promise.all(allFinnhubSymbols.map((s) => fetchFinnhubQuote(s, apiKey || '').then((r) => (r ? { ...r, symbol: s } : null)))) : Promise.resolve([]),
    commoditySymbols.length > 0 ? Promise.all(commoditySymbols.map((s) => fetchYahooQuote(s).then((q) => (q ? { symbol: s, ...q } : null)))) : Promise.resolve([]),
    yahooStockSymbols.length > 0 ? Promise.all(yahooStockSymbols.map((s) => fetchYahooQuote(s).then((q) => (q ? { symbol: s, ...q } : null)))) : Promise.resolve([]),
    yahooSectorFallback.length > 0 ? Promise.all(yahooSectorFallback.map((s) => fetchYahooQuote(s).then((q) => (q ? { symbol: s, ...q } : null)))) : Promise.resolve([]),
    cryptoIds.length > 0 ? fetchCoinGeckoMarkets(cryptoIds) : Promise.resolve([]),
  ]);

  const finnhubData = finnhubResults.status === 'fulfilled' ? finnhubResults.value : [];
  const yahooCommodity = yahooCommodityResults.status === 'fulfilled' ? (yahooCommodityResults.value || []).filter(Boolean) : [];
  const yahooStock = yahooStockResults.status === 'fulfilled' ? (yahooStockResults.value || []).filter(Boolean) : [];
  const yahooSector = yahooSectorResults.status === 'fulfilled' ? (yahooSectorResults.value || []).filter(Boolean) : [];
  const cryptoData = cryptoResults.status === 'fulfilled' ? cryptoResults.value : [];

  const yahooMap = new Map();
  for (const x of [...yahooCommodity, ...yahooStock, ...yahooSector]) {
    if (x && x.symbol) yahooMap.set(x.symbol, { price: x.price, change: x.change, sparkline: x.sparkline || [] });
  }

  const stocks = [];
  const finnhubHits = new Set();
  for (const r of finnhubData) {
    if (r) {
      finnhubHits.add(r.symbol);
      const meta = stockMeta.get(r.symbol);
      stocks.push({ symbol: r.symbol, name: meta?.name ?? r.symbol, display: meta?.display ?? r.symbol, price: r.price, change: r.changePercent, sparkline: [] });
    }
  }
  const missedFinnhub = apiKey ? finnhubSymbols.filter((s) => !finnhubHits.has(s)) : finnhubSymbols;
  for (const s of [...stockSymbols.filter(isYahooOnlySymbol), ...missedFinnhub]) {
    if (finnhubHits.has(s)) continue;
    const y = yahooMap.get(s);
    if (y) {
      const meta = stockMeta.get(s);
      stocks.push({ symbol: s, name: meta?.name ?? s, display: meta?.display ?? s, price: y.price, change: y.change, sparkline: y.sparkline });
    }
  }
  const stockOrder = new Map(stockSymbols.map((s, i) => [s, i]));
  stocks.sort((a, b) => (stockOrder.get(a.symbol) ?? 999) - (stockOrder.get(b.symbol) ?? 999));

  const commodities = commoditySymbols.map((s) => {
    const y = yahooMap.get(s);
    if (!y) return null;
    const meta = commodityMeta.get(s);
    return { symbol: s, name: meta?.name ?? s, display: meta?.display ?? s, price: y.price, change: y.change, sparkline: y.sparkline };
  }).filter(Boolean);

  const sectorFinnhubHits = new Set();
  const sectors = [];
  for (const r of finnhubData) {
    if (r && sectorSymbols.includes(r.symbol)) {
      sectorFinnhubHits.add(r.symbol);
      const meta = sectorMeta.get(r.symbol);
      sectors.push({ symbol: r.symbol, name: meta?.name ?? r.symbol, change: r.changePercent });
    }
  }
  for (const s of sectorSymbols) {
    if (sectorFinnhubHits.has(s)) continue;
    const y = yahooMap.get(s);
    if (y) {
      const meta = sectorMeta.get(s);
      sectors.push({ symbol: s, name: meta?.name ?? s, change: y.change });
    }
  }

  const crypto = [];
  const cryptoById = new Map((cryptoData || []).map((c) => [c.id, c]));
  for (const id of cryptoIds) {
    const coin = cryptoById.get(id);
    if (!coin) continue;
    const configEntry = (config.crypto || []).find((c) => c.symbol === id);
    const meta = CRYPTO_META[id];
    const prices = coin.sparkline_in_7d?.price;
    const sparkline = prices && prices.length > 24 ? prices.slice(-48) : (prices || []);
    crypto.push({
      name: configEntry?.name ?? meta?.name ?? id,
      symbol: configEntry?.display ?? meta?.symbol ?? id.toUpperCase(),
      price: coin.current_price ?? 0,
      change: coin.price_change_percentage_24h ?? 0,
      sparkline,
    });
  }

  const hasData = stocks.length > 0 || commodities.length > 0 || sectors.length > 0 || crypto.length > 0;
  if (!hasData) return null;

  const coveredByYahoo = finnhubSymbols.every((s) => stocks.some((q) => q.symbol === s));
  const skipped = !apiKey && !coveredByYahoo;

  return {
    stocks,
    commodities,
    sectors,
    crypto,
    finnhubSkipped: skipped,
    skipReason: skipped ? 'FINNHUB_API_KEY not configured' : '',
    rateLimited: false,
  };
}

// --- fetchMacroSignals: Yahoo + Alternative.me + Mempool (7 signals) ---
function rateOfChange(prices, days) {
  if (!prices || prices.length < days + 1) return null;
  const recent = prices[prices.length - 1];
  const past = prices[prices.length - 1 - days];
  if (!past || past === 0) return null;
  return ((recent - past) / past) * 100;
}
function smaCalc(prices, period) {
  if (!prices || prices.length < period) return null;
  return prices.slice(-period).reduce((a, b) => a + b, 0) / period;
}
function extractClosePrices(chart) {
  try {
    return chart?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter((p) => p != null) || [];
  } catch { return []; }
}
function extractAlignedPriceVolume(chart) {
  try {
    const result = chart?.chart?.result?.[0];
    const closes = result?.indicators?.quote?.[0]?.close || [];
    const volumes = result?.indicators?.quote?.[0]?.volume || [];
    const pairs = [];
    for (let i = 0; i < closes.length; i++) {
      if (closes[i] != null && volumes[i] != null) pairs.push({ price: closes[i], volume: volumes[i] });
    }
    return pairs;
  } catch { return []; }
}

async function fetchMacroSignals() {
  const yahooBase = 'https://query1.finance.yahoo.com/v8/finance/chart';
  const jpyChart = await fetch(yahooBase + '/JPY=X?range=1y&interval=1d', { headers: { 'User-Agent': CHROME_UA } }).then((r) => r.ok ? r.json() : null).catch(() => null);
  await yahooGate();
  const btcChart = await fetch(yahooBase + '/BTC-USD?range=1y&interval=1d', { headers: { 'User-Agent': CHROME_UA } }).then((r) => r.ok ? r.json() : null).catch(() => null);
  await yahooGate();
  const qqqChart = await fetch(yahooBase + '/QQQ?range=1y&interval=1d', { headers: { 'User-Agent': CHROME_UA } }).then((r) => r.ok ? r.json() : null).catch(() => null);
  await yahooGate();
  const xlpChart = await fetch(yahooBase + '/XLP?range=1y&interval=1d', { headers: { 'User-Agent': CHROME_UA } }).then((r) => r.ok ? r.json() : null).catch(() => null);

  const [fearGreed, mempoolHash] = await Promise.allSettled([
    fetch('https://api.alternative.me/fng/?limit=30&format=json', { headers: { 'User-Agent': CHROME_UA } }).then((r) => r.ok ? r.json() : null),
    fetch('https://mempool.space/api/v1/mining/hashrate/1m', { headers: { 'User-Agent': CHROME_UA } }).then((r) => r.ok ? r.json() : null),
  ]);

  const jpyPrices = extractClosePrices(jpyChart);
  const btcPrices = extractClosePrices(btcChart);
  const btcAligned = extractAlignedPriceVolume(btcChart);
  const qqqPrices = extractClosePrices(qqqChart);
  const xlpPrices = extractClosePrices(xlpChart);

  const jpyRoc30 = rateOfChange(jpyPrices, 30);
  const liquidityStatus = jpyRoc30 !== null ? (jpyRoc30 < -2 ? 'SQUEEZE' : 'NORMAL') : 'UNKNOWN';

  const btcReturn5 = rateOfChange(btcPrices, 5);
  const qqqReturn5 = rateOfChange(qqqPrices, 5);
  let flowStatus = 'UNKNOWN';
  if (btcReturn5 !== null && qqqReturn5 !== null) {
    flowStatus = Math.abs(btcReturn5 - qqqReturn5) > 5 ? 'PASSIVE GAP' : 'ALIGNED';
  }

  const qqqRoc20 = rateOfChange(qqqPrices, 20);
  const xlpRoc20 = rateOfChange(xlpPrices, 20);
  let regimeStatus = 'UNKNOWN';
  if (qqqRoc20 !== null && xlpRoc20 !== null) regimeStatus = qqqRoc20 > xlpRoc20 ? 'RISK-ON' : 'DEFENSIVE';

  const btcSma50 = smaCalc(btcPrices, 50);
  const btcSma200 = smaCalc(btcPrices, 200);
  const btcCurrent = btcPrices.length > 0 ? btcPrices[btcPrices.length - 1] : null;

  let btcVwap = null;
  if (btcAligned.length >= 30) {
    const last30 = btcAligned.slice(-30);
    let sumPV = 0, sumV = 0;
    for (const { price, volume } of last30) { sumPV += price * volume; sumV += volume; }
    if (sumV > 0) btcVwap = +(sumPV / sumV).toFixed(0);
  }

  let trendStatus = 'UNKNOWN';
  let mayerMultiple = null;
  if (btcCurrent && btcSma50) {
    const aboveSma = btcCurrent > btcSma50 * 1.02;
    const belowSma = btcCurrent < btcSma50 * 0.98;
    const aboveVwap = btcVwap ? btcCurrent > btcVwap : null;
    if (aboveSma && aboveVwap !== false) trendStatus = 'BULLISH';
    else if (belowSma && aboveVwap !== true) trendStatus = 'BEARISH';
    else trendStatus = 'NEUTRAL';
  }
  if (btcCurrent && btcSma200) mayerMultiple = +(btcCurrent / btcSma200).toFixed(2);

  let hashStatus = 'UNKNOWN';
  let hashChange = null;
  if (mempoolHash.status === 'fulfilled' && mempoolHash.value) {
    const hr = mempoolHash.value.hashrates || mempoolHash.value;
    if (Array.isArray(hr) && hr.length >= 2) {
      const recent = hr[hr.length - 1]?.avgHashrate ?? hr[hr.length - 1];
      const older = hr[0]?.avgHashrate ?? hr[0];
      if (recent && older && older > 0) {
        hashChange = +((recent - older) / older * 100).toFixed(1);
        hashStatus = hashChange > 3 ? 'GROWING' : hashChange < -3 ? 'DECLINING' : 'STABLE';
      }
    }
  }

  let momentumStatus = mayerMultiple !== null ? (mayerMultiple > 1.0 ? 'STRONG' : mayerMultiple > 0.8 ? 'MODERATE' : 'WEAK') : 'UNKNOWN';

  let fgValue, fgLabel = 'UNKNOWN', fgHistory = [];
  if (fearGreed.status === 'fulfilled' && fearGreed.value?.data) {
    const d = fearGreed.value.data[0];
    fgValue = parseInt(d?.value, 10);
    if (!Number.isFinite(fgValue)) fgValue = undefined;
    fgLabel = d?.value_classification || 'UNKNOWN';
    fgHistory = (fearGreed.value.data || []).slice(0, 30).map((x) => ({ value: parseInt(x.value, 10), date: new Date(parseInt(x.timestamp, 10) * 1000).toISOString().slice(0, 10) })).reverse();
  }

  const signalList = [
    { status: liquidityStatus, bullish: liquidityStatus === 'NORMAL' },
    { status: flowStatus, bullish: flowStatus === 'ALIGNED' },
    { status: regimeStatus, bullish: regimeStatus === 'RISK-ON' },
    { status: trendStatus, bullish: trendStatus === 'BULLISH' },
    { status: hashStatus, bullish: hashStatus === 'GROWING' },
    { status: momentumStatus, bullish: momentumStatus === 'STRONG' },
    { status: fgLabel, bullish: fgValue !== undefined && fgValue > 50 },
  ];
  let bullishCount = 0, totalCount = 0;
  for (const s of signalList) {
    if (s.status !== 'UNKNOWN') { totalCount++; if (s.bullish) bullishCount++; }
  }
  const verdict = totalCount === 0 ? 'UNKNOWN' : (bullishCount / totalCount >= 0.57 ? 'BUY' : 'CASH');

  return {
    timestamp: new Date().toISOString(),
    verdict,
    bullishCount,
    totalCount,
    signals: {
      liquidity: { status: liquidityStatus, value: jpyRoc30 !== null ? +jpyRoc30.toFixed(2) : undefined, sparkline: jpyPrices.slice(-30) },
      flowStructure: { status: flowStatus, btcReturn5: btcReturn5 !== null ? +btcReturn5.toFixed(2) : undefined, qqqReturn5: qqqReturn5 !== null ? +qqqReturn5.toFixed(2) : undefined },
      macroRegime: { status: regimeStatus, qqqRoc20: qqqRoc20 !== null ? +qqqRoc20.toFixed(2) : undefined, xlpRoc20: xlpRoc20 !== null ? +xlpRoc20.toFixed(2) : undefined },
      technicalTrend: { status: trendStatus, btcPrice: btcCurrent ?? undefined, sma50: btcSma50 ? +btcSma50.toFixed(0) : undefined, sma200: btcSma200 ? +btcSma200.toFixed(0) : undefined, vwap30d: btcVwap ?? undefined, mayerMultiple: mayerMultiple ?? undefined, sparkline: btcPrices.slice(-30) },
      hashRate: { status: hashStatus, change30d: hashChange ?? undefined },
      priceMomentum: { status: momentumStatus },
      fearGreed: { status: fgLabel, value: fgValue, history: fgHistory },
    },
    meta: { qqqSparkline: qqqPrices.slice(-30) },
    unavailable: false,
  };
}

// --- fetchStrategicRisk: ACLED + composite scoring ---
const TIER1_COUNTRIES = { US: 'US', RU: 'RU', CN: 'CN', UA: 'UA', IR: 'IR', IL: 'IL', TW: 'TW', KP: 'KP', SA: 'SA', TR: 'TR', PL: 'PL', DE: 'DE', FR: 'FR', GB: 'GB', IN: 'IN', PK: 'PK', SY: 'SY', YE: 'YE', MM: 'MM', VE: 'VE' };
const BASELINE_RISK = { US: 5, RU: 35, CN: 25, UA: 50, IR: 40, IL: 45, TW: 30, KP: 45, SA: 20, TR: 25, PL: 10, DE: 5, FR: 10, GB: 5, IN: 20, PK: 35, SY: 50, YE: 50, MM: 45, VE: 40 };
const EVENT_MULTIPLIER = { US: 0.3, RU: 2.0, CN: 2.5, UA: 0.8, IR: 2.0, IL: 0.7, TW: 1.5, KP: 3.0, SA: 2.0, TR: 1.2, PL: 0.8, DE: 0.5, FR: 0.6, GB: 0.5, IN: 0.8, PK: 1.5, SY: 0.7, YE: 0.7, MM: 1.8, VE: 1.8 };
const COUNTRY_KEYWORDS = { US: ['united states', 'usa', 'america'], RU: ['russia', 'moscow'], CN: ['china', 'beijing'], UA: ['ukraine', 'kyiv'], IR: ['iran', 'tehran'], IL: ['israel', 'tel aviv'], TW: ['taiwan'], KP: ['north korea'], SA: ['saudi arabia'], TR: ['turkey'], PL: ['poland'], DE: ['germany'], FR: ['france'], GB: ['britain', 'uk'], IN: ['india'], PK: ['pakistan'], SY: ['syria'], YE: ['yemen'], MM: ['myanmar'], VE: ['venezuela'] };

function normalizeCountryName(text) {
  const lower = (text || '').toLowerCase();
  for (const [code, keywords] of Object.entries(COUNTRY_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) return code;
  }
  return null;
}

async function fetchStrategicRisk() {
  const token = process.env.ACLED_ACCESS_TOKEN;
  if (!token) {
    console.warn('[relay] ACLED_ACCESS_TOKEN not set — strategic-risk channel disabled');
    return null;
  }
  const endDate = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const params = new URLSearchParams({ event_type: 'Protests|Riots', event_date: `${startDate}|${endDate}`, event_date_where: 'BETWEEN', limit: '500', _format: 'json' });
  let protests = [];
  try {
    const resp = await fetch(`https://acleddata.com/api/acled/read?${params}`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(PHASE3C_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    protests = (data.data || []).map((e) => ({ country: e.country || '', event_type: e.event_type || '' }));
  } catch { return null; }

  const countryEvents = new Map();
  for (const e of protests) {
    const code = normalizeCountryName(e.country);
    if (code && TIER1_COUNTRIES[code]) {
      const c = countryEvents.get(code) || { protests: 0, riots: 0 };
      if (e.event_type === 'Riots') c.riots++; else c.protests++;
      countryEvents.set(code, c);
    }
  }

  const ciiScores = [];
  for (const [code] of Object.entries(TIER1_COUNTRIES)) {
    const events = countryEvents.get(code) || { protests: 0, riots: 0 };
    const baseline = BASELINE_RISK[code] || 20;
    const mult = EVENT_MULTIPLIER[code] || 1.0;
    const unrest = Math.min(100, Math.round((events.protests + events.riots * 2) * mult * 2));
    const security = Math.min(100, baseline + events.riots * mult * 5);
    const information = Math.min(100, (events.protests + events.riots) * mult * 3);
    const composite = Math.min(100, Math.round(baseline + (unrest * 0.4 + security * 0.35 + information * 0.25) * 0.5));
    ciiScores.push({ region: code, staticBaseline: baseline, dynamicScore: composite - baseline, combinedScore: composite, trend: 'TREND_DIRECTION_STABLE', components: { newsActivity: information, ciiContribution: unrest, geoConvergence: 0, militaryActivity: 0 }, computedAt: Date.now() });
  }
  ciiScores.sort((a, b) => b.combinedScore - a.combinedScore);

  const top5 = ciiScores.slice(0, 5);
  const weights = top5.map((_, i) => 1 - i * 0.15);
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  const weightedSum = top5.reduce((s, sc, i) => s + sc.combinedScore * weights[i], 0);
  const overallScore = Math.min(100, Math.round((weightedSum / totalWeight) * 0.7 + 15));
  const strategicRisks = [{
    region: 'global',
    level: overallScore >= 70 ? 'SEVERITY_LEVEL_HIGH' : overallScore >= 40 ? 'SEVERITY_LEVEL_MEDIUM' : 'SEVERITY_LEVEL_LOW',
    score: overallScore,
    factors: top5.map((s) => s.region),
    trend: 'TREND_DIRECTION_STABLE',
  }];

  return { ciiScores, strategicRisks };
}

// --- fetchAcledConflictEvents: raw ACLED events in proto ListAcledEventsResponse shape ---
async function fetchAcledConflictEvents() {
  const token = process.env.ACLED_ACCESS_TOKEN;
  if (!token) return null;
  const endDate = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const params = new URLSearchParams({
    event_date: `${startDate}|${endDate}`, event_date_where: 'BETWEEN',
    limit: '500', _format: 'json',
  });
  const resp = await fetch(`https://acleddata.com/api/acled/read?${params}`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(PHASE3C_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`ACLED HTTP ${resp.status}`);
  const data = await resp.json();
  const events = (data.data || []).map((e) => ({
    id: String(e.data_id || e.event_id_cnty || ''),
    eventType: (e.event_type || '').toLowerCase().replace(/\s+/g, '_'),
    subEventType: e.sub_event_type || '',
    country: e.country || '',
    admin1: e.admin1 || '',
    location: { latitude: parseFloat(e.latitude) || 0, longitude: parseFloat(e.longitude) || 0 },
    occurredAt: e.event_date ? new Date(e.event_date).getTime() : 0,
    fatalities: parseInt(e.fatalities, 10) || 0,
    actors: [e.actor1, e.actor2].filter(Boolean),
    source: e.source || 'ACLED',
  }));
  return { events };
}

// --- fetchPredictions: Polymarket Gamma API ---
async function fetchPredictions() {
  const GAMMA_BASE = 'https://gamma-api.polymarket.com';
  const params = new URLSearchParams({ closed: 'false', active: 'true', archived: 'false', end_date_min: new Date().toISOString(), order: 'volume', ascending: 'false', limit: '50' });
  try {
    const resp = await fetch(`${GAMMA_BASE}/markets?${params}`, {
      headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const markets = (data || []).map((m) => {
      let yesPrice = 0.5;
      try {
        const prices = m.outcomePrices ? JSON.parse(m.outcomePrices) : [];
        if (prices.length >= 1) yesPrice = parseFloat(prices[0]) || 0.5;
      } catch {}
      const closesAtMs = m.endDate ? Date.parse(m.endDate) : 0;
      return {
        id: m.slug || '',
        title: m.question || '',
        yesPrice,
        volume: (m.volumeNum ?? (m.volume ? parseFloat(m.volume) : 0)) || 0,
        url: `https://polymarket.com/market/${m.slug}`,
        closesAt: Number.isFinite(closesAtMs) ? closesAtMs : 0,
        category: '',
      };
    });
    return markets.length > 0 ? { markets, pagination: undefined } : null;
  } catch { return null; }
}

// --- fetchSupplyChain: NGA warnings + relay AIS disruptions ---
const SUPPLY_CHAIN_CHOKEPOINTS = [
  { id: 'suez', name: 'Suez Canal', lat: 30.45, lon: 32.35, areaKeywords: ['suez', 'red sea'], routes: ['China-Europe (Suez)', 'Gulf-Europe Oil', 'Qatar LNG-Europe'] },
  { id: 'malacca', name: 'Malacca Strait', lat: 1.43, lon: 103.5, areaKeywords: ['malacca', 'singapore strait'], routes: ['China-Middle East Oil', 'China-Europe (via Suez)', 'Japan-Middle East Oil'] },
  { id: 'hormuz', name: 'Strait of Hormuz', lat: 26.56, lon: 56.25, areaKeywords: ['hormuz', 'persian gulf', 'arabian gulf'], routes: ['Gulf Oil Exports', 'Qatar LNG', 'Iran Exports'] },
  { id: 'bab_el_mandeb', name: 'Bab el-Mandeb', lat: 12.58, lon: 43.33, areaKeywords: ['bab el-mandeb', 'bab al-mandab', 'mandeb', 'aden'], routes: ['Suez-Indian Ocean', 'Gulf-Europe Oil', 'Red Sea Transit'] },
  { id: 'panama', name: 'Panama Canal', lat: 9.08, lon: -79.68, areaKeywords: ['panama'], routes: ['US East Coast-Asia', 'US East Coast-South America', 'Atlantic-Pacific Bulk'] },
  { id: 'taiwan', name: 'Taiwan Strait', lat: 24.0, lon: 119.5, areaKeywords: ['taiwan strait', 'formosa'], routes: ['China-Japan Trade', 'Korea-Southeast Asia', 'Pacific Semiconductor'] },
];
const SEVERITY_SCORE = { AIS_DISRUPTION_SEVERITY_LOW: 1, AIS_DISRUPTION_SEVERITY_ELEVATED: 2, AIS_DISRUPTION_SEVERITY_HIGH: 3 };

function computeDisruptionScore(warningCount, congestionSeverity) {
  return Math.min(100, warningCount * 15 + congestionSeverity * 30);
}
function scoreToStatus(score) {
  if (score < 20) return 'green';
  if (score < 50) return 'yellow';
  return 'red';
}

async function fetchSupplyChain() {
  let warnings = [];
  try {
    const resp = await fetch('https://msi.nga.mil/api/publications/broadcast-warn?output=json&status=A', {
      headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(15000),
    });
    if (resp.ok) {
      const data = await resp.json();
      const raw = Array.isArray(data) ? data : (data?.broadcast_warn || []);
      warnings = raw.map((w) => ({ id: `${w.navArea || ''}-${w.msgYear || ''}-${w.msgNumber || ''}`, text: w.text || '', area: `${w.navArea || ''}${w.subregion || ''}` }));
    }
  } catch {}

  buildSnapshot();
  const disruptions = lastSnapshot?.disruptions || [];
  const disruptionsMapped = disruptions.map((d) => ({
    ...d,
    type: d.type === 'chokepoint_congestion' ? 'AIS_DISRUPTION_TYPE_CHOKEPOINT_CONGESTION' : d.type,
    severity: d.severity === 'high' ? 'AIS_DISRUPTION_SEVERITY_HIGH' : d.severity === 'elevated' ? 'AIS_DISRUPTION_SEVERITY_ELEVATED' : d.severity === 'low' ? 'AIS_DISRUPTION_SEVERITY_LOW' : 'AIS_DISRUPTION_SEVERITY_UNSPECIFIED',
  }));

  const chokepoints = SUPPLY_CHAIN_CHOKEPOINTS.map((cp) => {
    const matchedWarnings = warnings.filter((w) => cp.areaKeywords.some((kw) => (w.text || '').toLowerCase().includes(kw) || (w.area || '').toLowerCase().includes(kw)));
    const matchedDisruptions = disruptionsMapped.filter((d) => d.type === 'AIS_DISRUPTION_TYPE_CHOKEPOINT_CONGESTION' && cp.areaKeywords.some((kw) => (d.region || '').toLowerCase().includes(kw) || (d.name || '').toLowerCase().includes(kw)));
    const maxSeverity = matchedDisruptions.reduce((max, d) => Math.max(max, SEVERITY_SCORE[d.severity] ?? 0), 0);
    const disruptionScore = computeDisruptionScore(matchedWarnings.length, maxSeverity);
    const status = scoreToStatus(disruptionScore);
    const congestionLevel = maxSeverity >= 3 ? 'high' : maxSeverity >= 2 ? 'elevated' : maxSeverity >= 1 ? 'low' : 'normal';
    const descriptions = [];
    if (matchedWarnings.length > 0) descriptions.push(`${matchedWarnings.length} active navigational warning(s)`);
    if (matchedDisruptions.length > 0) descriptions.push('AIS congestion detected');
    if (descriptions.length === 0) descriptions.push('No active disruptions');
    return { id: cp.id, name: cp.name, lat: cp.lat, lon: cp.lon, disruptionScore, status, activeWarnings: matchedWarnings.length, congestionLevel, affectedRoutes: cp.routes, description: descriptions.join('; ') };
  });

  return { chokepoints, fetchedAt: new Date().toISOString(), upstreamUnavailable: false };
}

// --- fetchStrategicPosture: OpenSky + Wingbits (via relay /opensky) ---
const THEATER_QUERY_REGIONS = [
  { name: 'WESTERN', lamin: 10, lamax: 66, lomin: 9, lomax: 66 },
  { name: 'PACIFIC', lamin: 4, lamax: 44, lomin: 104, lomax: 133 },
];
const POSTURE_THEATERS = [
  { id: 'baltic', bounds: { north: 66, south: 54, east: 30, west: 9 }, thresholds: { critical: 15, elevated: 8 }, strikeIndicators: { minTankers: 2, minAwacs: 1, minFighters: 4 } },
  { id: 'eastern_med', bounds: { north: 42, south: 30, east: 40, west: 18 }, thresholds: { critical: 12, elevated: 6 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 } },
  { id: 'persian_gulf', bounds: { north: 30, south: 24, east: 60, west: 48 }, thresholds: { critical: 10, elevated: 5 }, strikeIndicators: { minTankers: 1, minAwacs: 0, minFighters: 2 } },
  { id: 'red_sea', bounds: { north: 30, south: 12, east: 44, west: 32 }, thresholds: { critical: 8, elevated: 4 }, strikeIndicators: { minTankers: 1, minAwacs: 0, minFighters: 2 } },
  { id: 'scs', bounds: { north: 25, south: 4, east: 122, west: 104 }, thresholds: { critical: 12, elevated: 6 }, strikeIndicators: { minTankers: 2, minAwacs: 1, minFighters: 4 } },
  { id: 'korea', bounds: { north: 44, south: 33, east: 133, west: 124 }, thresholds: { critical: 10, elevated: 5 }, strikeIndicators: { minTankers: 2, minAwacs: 1, minFighters: 4 } },
];

function isMilitaryCallsign(cs) {
  const c = (cs || '').trim().toUpperCase();
  return /^(RCH|EVAC|VALOR|SPAR|NAF|REACH|DUKE|VIPER|BLUE|COBRA|SNAKE|HAWK|EAGLE|WOLF|TIGER|BONE|HAMMER|SABRE|STRIKE|WILD|BULL|VIP|AF\d|NAVY|NAVY\d|MARINE|ARMY|ARMY\d)\d*$/.test(c) || /^[A-Z]{2}\d{2,}$/.test(c);
}
function isMilitaryHex(icao) {
  const h = (icao || '').toUpperCase();
  return /^[0-9A-F]{6}$/.test(h) && (h.startsWith('AE') || h.startsWith('AD') || h.startsWith('AC') || h.startsWith('43') || h.startsWith('48') || h.startsWith('39'));
}

async function fetchStrategicPosture() {
  const relayBase = process.env.WS_RELAY_URL ? process.env.WS_RELAY_URL.replace(/^wss?:\/\//, 'https://').replace(/\/$/, '') : null;
  const headers = { Accept: 'application/json', 'User-Agent': CHROME_UA };
  if (process.env.RELAY_SHARED_SECRET) {
    const h = (process.env.RELAY_AUTH_HEADER || 'x-relay-key').toLowerCase();
    headers[h] = process.env.RELAY_SHARED_SECRET;
    headers.Authorization = `Bearer ${process.env.RELAY_SHARED_SECRET}`;
  }

  let flights = [];
  const openskyUrl = relayBase ? `${relayBase}/opensky` : 'https://opensky-network.org/api/states/all';

  for (const region of THEATER_QUERY_REGIONS) {
    const params = `lamin=${region.lamin}&lamax=${region.lamax}&lomin=${region.lomin}&lomax=${region.lomax}`;
    try {
      const resp = await fetch(`${openskyUrl}?${params}`, { headers, signal: AbortSignal.timeout(15000) });
      if (!resp.ok) continue;
      const data = await resp.json();
      const states = data.states || [];
      for (const s of states) {
        const [icao24, callsign, , , , lon, lat, altitude, onGround, velocity, heading] = s;
        if (lat == null || lon == null || onGround) continue;
        if (!isMilitaryCallsign(callsign) && !isMilitaryHex(icao24)) continue;
        flights.push({ id: icao24, callsign: (callsign || '').trim(), lat, lon, altitude: altitude ?? 0, heading: heading ?? 0, speed: velocity ?? 0 });
      }
    } catch {}
  }

  const seen = new Set();
  flights = flights.filter((f) => !seen.has(f.id) && seen.add(f.id));

  const theaters = POSTURE_THEATERS.map((t) => {
    const theaterFlights = flights.filter((f) => f.lat >= t.bounds.south && f.lat <= t.bounds.north && f.lon >= t.bounds.west && f.lon <= t.bounds.east);
    const total = theaterFlights.length;
    const byType = { tankers: 0, awacs: 0, fighters: 0 };
    for (const f of theaterFlights) {
      const c = (f.callsign || '').toUpperCase();
      if (/RCH|TANK|KC|KC\d/.test(c)) byType.tankers++;
      else if (/E3|AWACS|E-\d/.test(c)) byType.awacs++;
      else byType.fighters++;
    }
    const postureLevel = total >= t.thresholds.critical ? 'critical' : total >= t.thresholds.elevated ? 'elevated' : 'normal';
    const strikeCapable = byType.tankers >= t.strikeIndicators.minTankers && byType.awacs >= t.strikeIndicators.minAwacs && byType.fighters >= t.strikeIndicators.minFighters;
    const ops = [];
    if (strikeCapable) ops.push('strike_capable');
    if (byType.tankers > 0) ops.push('aerial_refueling');
    if (byType.awacs > 0) ops.push('airborne_early_warning');
    return { theater: t.id, postureLevel, activeFlights: total, trackedVessels: 0, activeOperations: ops, assessedAt: Date.now() };
  });

  return { theaters };
}

// --- fetchPizzint: PizzINT API + GDELT ---
async function fetchPizzint() {
  const PIZZINT_API = 'https://www.pizzint.watch/api/dashboard-data';
  const GDELT_URL = 'https://www.pizzint.watch/api/gdelt/batch?pairs=usa_russia,russia_ukraine,usa_china,china_taiwan,usa_iran,usa_venezuela&method=gpr';
  try {
    const resp = await fetch(PIZZINT_API, { headers: { Accept: 'application/json', 'User-Agent': CHROME_UA }, signal: AbortSignal.timeout(PHASE3C_TIMEOUT_MS) });
    if (!resp.ok) return null;
    const raw = await resp.json();
    if (!raw.success || !raw.data) return null;
    const locs = raw.data.map((d) => ({
      placeId: d.place_id, name: d.name, address: d.address, currentPopularity: d.current_popularity,
      percentageOfUsual: d.percentage_of_usual ?? 0, isSpike: d.is_spike, spikeMagnitude: d.spike_magnitude ?? 0,
      dataSource: d.data_source, recordedAt: d.recorded_at, dataFreshness: d.data_freshness === 'fresh' ? 'DATA_FRESHNESS_FRESH' : 'DATA_FRESHNESS_STALE',
      isClosedNow: d.is_closed_now ?? false, lat: d.lat ?? 0, lng: d.lng ?? 0,
    }));
    const openLocs = locs.filter((l) => !l.isClosedNow);
    const activeSpikes = locs.filter((l) => l.isSpike).length;
    const avgPop = openLocs.length > 0 ? openLocs.reduce((s, l) => s + l.currentPopularity, 0) / openLocs.length : 0;
    let adjusted = avgPop + activeSpikes * 10;
    adjusted = Math.min(100, adjusted);
    let defconLevel = 5, defconLabel = 'Normal Activity';
    if (adjusted >= 85) { defconLevel = 1; defconLabel = 'Maximum Activity'; }
    else if (adjusted >= 70) { defconLevel = 2; defconLabel = 'High Activity'; }
    else if (adjusted >= 50) { defconLevel = 3; defconLabel = 'Elevated Activity'; }
    else if (adjusted >= 25) { defconLevel = 4; defconLabel = 'Above Normal'; }
    const hasFresh = locs.some((l) => l.dataFreshness === 'DATA_FRESHNESS_FRESH');
    const pizzint = { defconLevel, defconLabel, aggregateActivity: Math.round(avgPop), activeSpikes, locationsMonitored: locs.length, locationsOpen: openLocs.length, updatedAt: Date.now(), dataFreshness: hasFresh ? 'DATA_FRESHNESS_FRESH' : 'DATA_FRESHNESS_STALE', locations: locs };

    let tensionPairs = [];
    try {
      const gResp = await fetch(GDELT_URL, { headers: { Accept: 'application/json', 'User-Agent': CHROME_UA }, signal: AbortSignal.timeout(PHASE3C_TIMEOUT_MS) });
      if (gResp.ok) {
        const gRaw = await gResp.json();
        tensionPairs = Object.entries(gRaw || {}).map(([pairKey, dataPoints]) => {
          const countries = pairKey.split('_');
          const arr = Array.isArray(dataPoints) ? dataPoints : [];
          const latest = arr[arr.length - 1];
          const prev = arr.length > 1 ? arr[arr.length - 2] : latest;
          const change = prev?.v > 0 ? ((latest?.v ?? 0) - prev.v) / prev.v * 100 : 0;
          const trend = change > 5 ? 'TREND_DIRECTION_RISING' : change < -5 ? 'TREND_DIRECTION_FALLING' : 'TREND_DIRECTION_STABLE';
          return { id: pairKey, countries, label: countries.map((c) => c.toUpperCase()).join(' - '), score: latest?.v ?? 0, trend, changePercent: Math.round(change * 10) / 10, region: 'global' };
        });
      }
    } catch {}

    return { pizzint, tensionPairs };
  } catch { return null; }
}

// --- fetchIranEvents: Redis read (populated by seed script) ---
async function fetchIranEvents() {
  const val = await redisGet('conflict:iran-events:v1');
  if (val && typeof val === 'object' && Array.isArray(val.events)) return val;
  return { events: [], scrapedAt: '0' };
}

// --- fetchNewsDigest: RSS + Supabase sources + keyword classification ---
const NEWS_LEVEL_TO_PROTO = { critical: 'THREAT_LEVEL_CRITICAL', high: 'THREAT_LEVEL_HIGH', medium: 'THREAT_LEVEL_MEDIUM', low: 'THREAT_LEVEL_LOW', info: 'THREAT_LEVEL_UNSPECIFIED' };
const NEWS_CRITICAL_KW = { 'nuclear strike': 'military', 'nuclear attack': 'military', 'invasion': 'conflict', 'coup': 'military', 'genocide': 'conflict', 'mass casualty': 'conflict' };
const NEWS_HIGH_KW = { 'war': 'conflict', 'airstrike': 'conflict', 'missile': 'military', 'bombing': 'conflict', 'hostage': 'terrorism', 'cyber attack': 'cyber', 'earthquake': 'disaster' };
const NEWS_MEDIUM_KW = { 'protest': 'protest', 'riot': 'protest', 'military exercise': 'military', 'trade war': 'economic', 'recession': 'economic', 'flood': 'disaster' };
const NEWS_LOW_KW = { 'election': 'diplomatic', 'summit': 'diplomatic', 'treaty': 'diplomatic', 'ceasefire': 'diplomatic' };
const NEWS_EXCLUSIONS = ['protein', 'couples', 'dating', 'recipe', 'celebrity', 'sports', 'movie', 'vacation'];

function classifyNewsTitle(title, variant) {
  const lower = (title || '').toLowerCase();
  if (NEWS_EXCLUSIONS.some((ex) => lower.includes(ex))) return { level: 'info', category: 'general', confidence: 0.3 };
  for (const [kw, cat] of Object.entries(NEWS_CRITICAL_KW)) { if (lower.includes(kw)) return { level: 'critical', category: cat, confidence: 0.9 }; }
  for (const [kw, cat] of Object.entries(NEWS_HIGH_KW)) { if (lower.includes(kw)) return { level: 'high', category: cat, confidence: 0.8 }; }
  for (const [kw, cat] of Object.entries(NEWS_MEDIUM_KW)) { if (lower.includes(kw)) return { level: 'medium', category: cat, confidence: 0.7 }; }
  for (const [kw, cat] of Object.entries(NEWS_LOW_KW)) { if (lower.includes(kw)) return { level: 'low', category: cat, confidence: 0.6 }; }
  return { level: 'info', category: 'general', confidence: 0.3 };
}

async function fetchNewsSourcesForVariant(variant, lang) {
  // Prefer the Redis-cached sources (written by config:news-sources cron) to avoid
  // a redundant Supabase query on every news digest fetch.
  let rows = await redisGet('relay:config:news-sources');
  if (!rows && supabase) {
    try {
      const { data, error } = await supabase.rpc('get_public_news_sources', { p_variant: variant });
      if (!error && data) rows = data;
    } catch { /* fall through to empty */ }
  }
  if (!rows || !Array.isArray(rows)) {
    console.warn(`[relay] fetchNewsSourcesForVariant(${variant}) — no rows from Redis or Supabase`);
    return {};
  }
  const grouped = {};
  for (const row of rows) {
    if (Array.isArray(row.variants) && !row.variants.includes(variant)) continue;
    const url = typeof row.url === 'string' ? row.url : (row.url?.[lang] || row.url?.en || Object.values(row.url || {})[0] || '');
    if (!url) continue;
    const cat = row.category || 'general';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push({ name: row.name, url, category: cat });
  }
  const total = Object.values(grouped).reduce((s, a) => s + a.length, 0);
  if (total === 0) console.warn(`[relay] fetchNewsSourcesForVariant(${variant}) — ${rows.length} rows but 0 feeds after filtering`);
  return grouped;
}

function parseRssItems(xml, variant) {
  const items = [];
  const itemRe = /<item[\s>]([\s\S]*?)<\/item>/gi;
  const entryRe = /<entry[\s>]([\s\S]*?)<\/entry>/gi;
  let matches = [...xml.matchAll(itemRe)];
  if (matches.length === 0) matches = [...xml.matchAll(entryRe)];
  const isAtom = matches.length > 0 && matches[0][0].includes('<entry');
  const extractTag = (block, tag) => {
    const cdata = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tag}>`, 'i');
    const plain = new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i');
    const m = block.match(cdata) || block.match(plain);
    return m ? m[1].trim().replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : '';
  };
  for (const m of matches.slice(0, 5)) {
    const block = m[1] || '';
    const title = extractTag(block, 'title');
    if (!title) continue;
    const link = isAtom ? (block.match(/<link[^>]+href=["']([^"']+)["']/) || [])[1] || '' : extractTag(block, 'link');
    const pubStr = isAtom ? (extractTag(block, 'published') || extractTag(block, 'updated')) : extractTag(block, 'pubDate');
    const publishedAt = pubStr ? (Date.parse(pubStr) || Date.now()) : Date.now();
    const threat = classifyNewsTitle(title, variant);
    items.push({ source: (block.match(/<dc:creator[^>]*>([^<]*)<\/dc:creator>/i) || [])[1] || 'RSS', title, link, publishedAt, isAlert: threat.level === 'critical' || threat.level === 'high', threat, category: threat.category });
  }
  return items;
}

async function fetchNewsDigest(variant, lang) {
  const feedsByCategory = await fetchNewsSourcesForVariant(variant, lang);
  const categories = {};
  const feedStatuses = {};
  const allFeeds = [];
  for (const [cat, feeds] of Object.entries(feedsByCategory)) {
    for (const f of feeds) allFeeds.push({ category: cat, feed: f });
  }

  if (allFeeds.length === 0) {
    console.warn(`[relay] fetchNewsDigest(${variant}) — no feed sources, skipping`);
    return null;
  }

  const results = new Map();
  for (let i = 0; i < allFeeds.length; i += 15) {
    const batch = allFeeds.slice(i, i + 15);
    const settled = await Promise.allSettled(batch.map(async ({ category, feed }) => {
      try {
        const resp = await fetch(feed.url, { headers: { 'User-Agent': CHROME_UA, Accept: 'application/rss+xml, application/xml, text/xml, */*' }, signal: AbortSignal.timeout(8000) });
        if (!resp.ok) return { category, items: [] };
        const text = await resp.text();
        const items = parseRssItems(text, variant).map((it) => ({ ...it, source: feed.name }));
        feedStatuses[feed.name] = items.length > 0 ? 'ok' : 'empty';
        return { category, items };
      } catch {
        feedStatuses[feed.name] = 'timeout';
        return { category, items: [] };
      }
    }));
    for (const r of settled) {
      if (r.status === 'fulfilled') {
        const { category, items } = r.value;
        const existing = results.get(category) || [];
        existing.push(...items);
        results.set(category, existing);
      }
    }
  }

  for (const [cat, items] of results) {
    items.sort((a, b) => b.publishedAt - a.publishedAt);
    categories[cat] = { items: items.slice(0, 20).map((it) => ({ source: it.source, title: it.title, link: it.link, publishedAt: it.publishedAt, isAlert: it.isAlert, threat: { level: NEWS_LEVEL_TO_PROTO[it.threat?.level] || 'THREAT_LEVEL_UNSPECIFIED', category: it.threat?.category || 'general', confidence: it.threat?.confidence ?? 0.3, source: 'keyword' }, locationName: '' })) };
  }
  return { categories, feedStatuses, generatedAt: new Date().toISOString() };
}

cron.schedule('1-59/5 * * * *', async () => {
  try {
    await directFetchAndBroadcast('stablecoins', 'relay:stablecoins:v1', 60, fetchStablecoins);
  } catch (err) {
    console.error('[relay] stablecoins cron error:', err?.message ?? err);
  }
});
cron.schedule('2-59/5 * * * *', async () => {
  try {
    await directFetchAndBroadcast('etf-flows', 'relay:etf-flows:v1', 300, fetchEtfFlows);
  } catch (err) {
    console.error('[relay] etf-flows cron error:', err?.message ?? err);
  }
});
cron.schedule('1-59/10 * * * *', async () => {
  try {
    await directFetchAndBroadcast('trade', 'relay:trade:v1', 21600, fetchTrade);
  } catch (err) {
    console.error('[relay] trade cron error:', err?.message ?? err);
  }
});
cron.schedule('*/15 * * * *', async () => {
  try {
    await directFetchAndBroadcast('gulf-quotes', 'relay:gulf-quotes:v1', 480, fetchGulfQuotes);
  } catch (err) {
    console.error('[relay] gulf-quotes cron error:', err?.message ?? err);
  }
});
cron.schedule('*/30 * * * *', async () => {
  try {
    await directFetchAndBroadcast('spending', 'relay:spending:v1', 1800, fetchSpending);
  } catch (err) {
    console.error('[relay] spending cron error:', err?.message ?? err);
  }
});
cron.schedule('*/15 * * * *', async () => {
  try {
    await directFetchAndBroadcast('tech-events', 'relay:tech-events:v1', 21600, fetchTechEvents);
  } catch (err) {
    console.error('[relay] tech-events cron error:', err?.message ?? err);
  }
});

cron.schedule('*/5 * * * *', async () => {
  try { await directFetchAndBroadcast('markets', 'market:dashboard:v1', 480, fetchMarkets); } catch (err) { console.error('[relay] markets cron error:', err?.message ?? err); }
});
cron.schedule('3-59/5 * * * *', async () => {
  try { await directFetchAndBroadcast('macro-signals', 'economic:macro-signals:v1', 900, fetchMacroSignals); } catch (err) { console.error('[relay] macro-signals cron error:', err?.message ?? err); }
});
cron.schedule('*/5 * * * *', async () => {
  try { await directFetchAndBroadcast('strategic-risk', 'risk:scores:sebuf:v1', 600, fetchStrategicRisk); } catch (err) { console.error('[relay] strategic-risk cron error:', err?.message ?? err); }
});
cron.schedule('1-59/5 * * * *', async () => {
  try { await directFetchAndBroadcast('predictions', 'relay:predictions:v1', 600, fetchPredictions); } catch (err) { console.error('[relay] predictions cron error:', err?.message ?? err); }
});

cron.schedule('*/5 * * * *', async () => {
  try { await directFetchAndBroadcast('news:full', 'news:digest:v1:full:en', 900, () => fetchNewsDigest('full', 'en')); } catch (err) { console.error('[relay] news:full cron error:', err?.message ?? err); }
});
cron.schedule('1-59/5 * * * *', async () => {
  try { await directFetchAndBroadcast('news:tech', 'news:digest:v1:tech:en', 900, () => fetchNewsDigest('tech', 'en')); } catch (err) { console.error('[relay] news:tech cron error:', err?.message ?? err); }
});
cron.schedule('2-59/5 * * * *', async () => {
  try { await directFetchAndBroadcast('news:finance', 'news:digest:v1:finance:en', 900, () => fetchNewsDigest('finance', 'en')); } catch (err) { console.error('[relay] news:finance cron error:', err?.message ?? err); }
});
cron.schedule('3-59/5 * * * *', async () => {
  try { await directFetchAndBroadcast('news:happy', 'news:digest:v1:happy:en', 900, () => fetchNewsDigest('happy', 'en')); } catch (err) { console.error('[relay] news:happy cron error:', err?.message ?? err); }
});

// intelligence — LLM route, stays on Vercel (warmIntelligenceAndBroadcast)
cron.schedule('*/10 * * * *', () => {
  void warmIntelligenceAndBroadcast().catch(err => console.error('[relay-cron] intelligence unhandled error:', err));
});

cron.schedule('2-59/10 * * * *', async () => {
  try { await directFetchAndBroadcast('supply-chain', 'supply_chain:chokepoints:v1', 900, fetchSupplyChain); } catch (err) { console.error('[relay] supply-chain cron error:', err?.message ?? err); }
});
cron.schedule('3-59/10 * * * *', async () => {
  try { await directFetchAndBroadcast('strategic-posture', 'theater-posture:sebuf:v1', 900, fetchStrategicPosture); } catch (err) { console.error('[relay] strategic-posture cron error:', err?.message ?? err); }
});
cron.schedule('4-59/10 * * * *', async () => {
  try { await directFetchAndBroadcast('pizzint', 'intel:pizzint:v1', 600, fetchPizzint); } catch (err) { console.error('[relay] pizzint cron error:', err?.message ?? err); }
});

cron.schedule('*/30 * * * *', async () => {
  try { await directFetchAndBroadcast('fred', 'relay:fred:v1', 1800, fetchFred); } catch (err) { console.error('[relay] fred cron error:', err?.message ?? err); }
});
cron.schedule('1-59/30 * * * *', async () => {
  try { await directFetchAndBroadcast('oil', 'relay:oil:v1', 3600, fetchOil); } catch (err) { console.error('[relay] oil cron error:', err?.message ?? err); }
});
cron.schedule('0 * * * *', async () => {
  try { await directFetchAndBroadcast('bis', 'relay:bis:v1', 21600, fetchBis); } catch (err) { console.error('[relay] bis cron error:', err?.message ?? err); }
});
cron.schedule('5 * * * *', async () => {
  try { await directFetchAndBroadcast('flights', 'relay:flights:v1', 7200, fetchFlights); } catch (err) { console.error('[relay] flights cron error:', err?.message ?? err); }
});
cron.schedule('0 0 * * *', async () => {
  try { await runAviationPreCache(); } catch (err) { console.error('[relay] aviation pre-cache error:', err?.message ?? err); }
});
cron.schedule('*/10 * * * *', async () => {
  try { await directFetchAndBroadcast('weather', 'relay:weather:v1', 600, () => fetchWeather().then((a) => a || null)); } catch (err) { console.error('[relay] weather cron error:', err?.message ?? err); }
});
cron.schedule('2-59/30 * * * *', async () => {
  try { await directFetchAndBroadcast('natural', 'relay:natural:v1', 3600, fetchNatural); } catch (err) { console.error('[relay] natural cron error:', err?.message ?? err); }
});
cron.schedule('*/30 * * * *', async () => {
  try { await directFetchAndBroadcast('eonet', 'relay:eonet:v1', 1800, () => fetchEonet().then((e) => e || null)); } catch (err) { console.error('[relay] eonet cron error:', err?.message ?? err); }
});
cron.schedule('*/30 * * * *', async () => {
  try { await directFetchAndBroadcast('gdacs', 'relay:gdacs:v1', 1800, () => fetchGdacs().then((g) => g || null)); } catch (err) { console.error('[relay] gdacs cron error:', err?.message ?? err); }
});
cron.schedule('0 */6 * * *', async () => {
  try { await directFetchAndBroadcast('climate', 'relay:climate:v1', 21600, fetchClimateAnomaliesData); } catch (err) { console.error('[relay] climate cron error:', err?.message ?? err); }
});
cron.schedule('*/30 * * * *', async () => {
  if (!process.env.ACLED_ACCESS_TOKEN) return;
  try { await directFetchAndBroadcast('conflict', 'relay:conflict:v1', 1800, fetchAcledConflictEvents); } catch (err) { console.error('[relay] conflict cron error:', err?.message ?? err); }
});
cron.schedule('0 */6 * * *', async () => {
  if (!ucdpCache.data) return;
  try {
    await redisSetex('conflict:ucdp-events:v1', 86400, ucdpCache.data);
    broadcastToChannel('ucdp-events', ucdpCache.data);
  } catch (err) {
    console.error('[relay] ucdp-events cron error:', err?.message ?? err);
  }
});
cron.schedule('*/5 * * * *', async () => {
  try { await directFetchAndBroadcast('gps-interference', 'relay:gps-interference:v1', 3600, fetchGpsInterference); } catch (err) { console.error('[relay] gps-interference cron error:', err?.message ?? err); }
});
cron.schedule('*/15 * * * *', async () => {
  try { await directFetchAndBroadcast('cables', 'relay:cables:v1', 600, fetchCables); } catch (err) { console.error('[relay] cables cron error:', err?.message ?? err); }
});
cron.schedule('5-59/10 * * * *', async () => {
  try { await directFetchAndBroadcast('cyber', 'relay:cyber:v1', 7200, fetchCyber); } catch (err) { console.error('[relay] cyber cron error:', err?.message ?? err); }
});
cron.schedule('*/5 * * * *', async () => {
  try { await directFetchAndBroadcast('service-status', 'relay:service-status:v1', 1800, () => fetchServiceStatus().then((s) => s || null)); } catch (err) { console.error('[relay] service-status cron error:', err?.message ?? err); }
});

// Giving — static data from published annual reports (24h TTL, no Vercel round-trip)
function fetchGivingSummary() {
  const gofundme = { platform: 'GoFundMe', dailyVolumeUsd: 9e9 / 365, activeCampaignsSampled: 0, newCampaigns24h: 0, donationVelocity: 0, dataFreshness: 'annual', lastUpdated: new Date().toISOString() };
  const globalGiving = { platform: 'GlobalGiving', dailyVolumeUsd: 100e6 / 365, activeCampaignsSampled: 0, newCampaigns24h: 0, donationVelocity: 0, dataFreshness: 'annual', lastUpdated: new Date().toISOString() };
  const justGiving = { platform: 'JustGiving', dailyVolumeUsd: 7e9 / 365, activeCampaignsSampled: 0, newCampaigns24h: 0, donationVelocity: 0, dataFreshness: 'annual', lastUpdated: new Date().toISOString() };
  const platforms = [gofundme, globalGiving, justGiving];
  const crypto = { dailyInflowUsd: 2e9 / 365, trackedWallets: 150, transactions24h: 0, topReceivers: ['Endaoment', 'The Giving Block', 'UNICEF Crypto Fund', 'Save the Children'], pctOfTotal: 0.8 };
  const institutional = { oecdOdaAnnualUsdBn: 223.7, oecdDataYear: 2023, cafWorldGivingIndex: 34, cafDataYear: 2024, candidGrantsTracked: 18e6, dataLag: 'Annual' };
  const categories = [
    { category: 'Medical & Health', share: 0.33, change24h: 0, activeCampaigns: 0, trending: true },
    { category: 'Disaster Relief', share: 0.15, change24h: 0, activeCampaigns: 0, trending: false },
    { category: 'Education', share: 0.12, change24h: 0, activeCampaigns: 0, trending: false },
    { category: 'Community', share: 0.10, change24h: 0, activeCampaigns: 0, trending: false },
    { category: 'Memorials', share: 0.08, change24h: 0, activeCampaigns: 0, trending: false },
    { category: 'Animals & Pets', share: 0.07, change24h: 0, activeCampaigns: 0, trending: false },
    { category: 'Environment', share: 0.05, change24h: 0, activeCampaigns: 0, trending: false },
    { category: 'Hunger & Food', share: 0.05, change24h: 0, activeCampaigns: 0, trending: false },
    { category: 'Other', share: 0.05, change24h: 0, activeCampaigns: 0, trending: false },
  ];
  const totalDailyVolume = platforms.reduce((s, p) => s + p.dailyVolumeUsd, 0) + crypto.dailyInflowUsd;
  let activityIndex = 50;
  const volumeRatio = totalDailyVolume / 50e6;
  activityIndex += Math.min(20, Math.max(-20, (volumeRatio - 1) * 20));
  activityIndex += platforms.filter(p => p.dailyVolumeUsd > 0).length * 2;
  activityIndex = Math.max(0, Math.min(100, Math.round(activityIndex)));
  const trend = activityIndex >= 65 ? 'rising' : activityIndex <= 35 ? 'falling' : 'stable';
  return {
    summary: {
      generatedAt: new Date().toISOString(),
      activityIndex,
      trend,
      estimatedDailyFlowUsd: totalDailyVolume,
      platforms,
      categories,
      crypto,
      institutional,
    },
  };
}
cron.schedule('0 0 * * *', async () => {
  await directFetchAndBroadcast('giving', 'giving:summary:v1', 86400, fetchGivingSummary);
});
// Broadcast giving on startup so subscribers get data immediately
void directFetchAndBroadcast('giving', 'giving:summary:v1', 86400, fetchGivingSummary).catch(() => {});

// Prime config:news-sources cache first, then kick off news digest fetches.
void (async () => {
  try {
    await directFetchAndBroadcast('config:news-sources', 'relay:config:news-sources', 300, fetchNewsSourcesConfig);
    console.log('[relay-startup] config:news-sources cached');
  } catch (err) {
    console.warn('[relay-startup] config:news-sources failed:', err?.message ?? err);
  }
  for (const v of ['full', 'tech', 'finance', 'happy']) {
    directFetchAndBroadcast(`news:${v}`, `news:digest:v1:${v}:en`, 900, () => fetchNewsDigest(v, 'en'))
      .then(() => console.log(`[relay-startup] news:${v} ready`))
      .catch((e) => console.warn(`[relay-startup] news:${v} failed:`, e?.message ?? e));
  }
})();

// Every 1 min — telegram intel (direct broadcast from in-memory state)
cron.schedule('* * * * *', async () => {
  const items = Array.isArray(telegramState.items) ? telegramState.items : [];
  const payload = {
    source: 'telegram',
    earlySignal: true,
    enabled: TELEGRAM_ENABLED,
    count: items.length,
    updatedAt: telegramState.lastPollAt ? new Date(telegramState.lastPollAt).toISOString() : null,
    items,
  };
  await redisSetex('relay:telegram:v1', 120, payload);
  broadcastToChannel('telegram', payload);
});

// Every 5 min — config channels (direct Supabase fetch, no Vercel round-trip)
async function fetchNewsSourcesConfig() {
  if (!supabase) throw new Error('Supabase client not configured');
  const all = [];
  for (const v of ['full', 'tech', 'finance', 'happy']) {
    const { data, error } = await supabase.rpc('get_public_news_sources', { p_variant: v });
    if (error) throw new Error(error.message);
    if (data) all.push(...data);
  }
  // Dedupe by name+url (a source in multiple variants appears in multiple RPC calls)
  const seen = new Set();
  const deduped = [];
  for (const row of all) {
    const key = `${row.name}||${typeof row.url === 'string' ? row.url : JSON.stringify(row.url)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
}
cron.schedule('*/5 * * * *', async () => {
  try {
    await directFetchAndBroadcast('config:news-sources', 'relay:config:news-sources', 300, fetchNewsSourcesConfig);
  } catch (err) {
    if (!supabase) return;
    console.warn(`[relay-cron] config:news-sources failed:`, err?.message ?? err);
  }
});

async function fetchFeatureFlagsConfig() {
  if (!supabase) throw new Error('Supabase client not configured');
  const { data, error } = await supabase.rpc('get_public_feature_flags');
  if (error) throw new Error(error.message);
  const flags = {};
  for (const row of data ?? []) flags[row.key] = row.value;
  return flags;
}
cron.schedule('*/5 * * * *', async () => {
  try {
    await directFetchAndBroadcast('config:feature-flags', 'relay:config:feature-flags', 300, fetchFeatureFlagsConfig);
  } catch (err) {
    if (!supabase) return;
    console.warn(`[relay-cron] config:feature-flags failed:`, err?.message ?? err);
  }
});

// Every 5 min — oref (direct broadcast from in-memory state)
cron.schedule('*/5 * * * *', async () => {
  const payload = {
    configured: OREF_ENABLED,
    alerts: orefState.lastAlerts || [],
    historyCount24h: orefState.historyCount24h,
    totalHistoryCount: orefState.totalHistoryCount,
    timestamp: orefState.lastPollAt ? new Date(orefState.lastPollAt).toISOString() : new Date().toISOString(),
    ...(orefState.lastError ? { error: orefState.lastError } : {}),
  };
  await redisSetex('relay:oref:v1', 600, payload);
  broadcastToChannel('oref', payload);
});
cron.schedule('*/10 * * * *', async () => {
  try { await directFetchAndBroadcast('iran-events', 'conflict:iran-events:v1', 600, fetchIranEvents); } catch (err) { console.error('[relay] iran-events cron error:', err?.message ?? err); }
});

// ── AIS direct broadcast (relay already has this data) ──────────────────────
cron.schedule('*/5 * * * *', async () => {
  buildSnapshot();
  if (lastSnapshot) {
    await redisSetex('relay:ais-snapshot:v1', 600, lastSnapshot);
    broadcastToChannel('ais', lastSnapshot);
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    const retryDelay = 3000;
    console.warn(`[Relay] Port ${PORT} in use — retrying in ${retryDelay}ms`);
    setTimeout(() => server.listen(PORT), retryDelay);
  } else {
    console.error('[Relay] Server error:', err);
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log(`[Relay] WebSocket relay on port ${PORT}`);
  startTelegramPollLoop();
  startOrefPollLoop();
  startUcdpSeedLoop();
});

wss.on('connection', (ws, req) => {
  if (!isAuthorizedWsRequest(req)) {
    ws.close(1008, 'Unauthorized');
    return;
  }

  const wsOrigin = req.headers.origin || '';
  if (wsOrigin && !getCorsOrigin(req)) {
    ws.close(1008, 'Origin not allowed');
    return;
  }

  if (clients.size >= MAX_WS_CLIENTS) {
    console.log(`[Relay] WS client rejected (max ${MAX_WS_CLIENTS})`);
    ws.close(1013, 'Max clients reached');
    return;
  }
  console.log(`[Relay] Client connected (${clients.size + 1}/${MAX_WS_CLIENTS})`);
  clients.add(ws);
  connectUpstream();

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
            if (subscribeClient(ws, ch)) {
              accepted.push(ch);
            }
          }
        }
        ws.send(JSON.stringify({ type: 'wm-subscribed', channels: accepted }));
        sendCachedPayloads(ws, accepted);
        return;
      }
      if (msg.type === 'wm-unsubscribe' && Array.isArray(msg.channels)) {
        for (const ch of msg.channels) {
          const subs = channelSubscribers.get(ch);
          if (subs && subs.has(ws)) {
            subs.delete(ws);
            const n = clientChannelCount.get(ws) ?? 0;
            if (n > 1) clientChannelCount.set(ws, n - 1);
            else clientChannelCount.delete(ws);
          }
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

  ws.on('error', (err) => {
    console.error('[Relay] Client error:', err.message);
    clients.delete(ws);
  });
});

// Memory / health monitor — log every 60s and force GC if available
setInterval(() => {
  const mem = process.memoryUsage();
  const rssGB = mem.rss / 1024 / 1024 / 1024;
  console.log(`[Monitor] rss=${(mem.rss / 1024 / 1024).toFixed(0)}MB heap=${(mem.heapUsed / 1024 / 1024).toFixed(0)}MB/${(mem.heapTotal / 1024 / 1024).toFixed(0)}MB external=${(mem.external / 1024 / 1024).toFixed(0)}MB vessels=${vessels.size} density=${densityGrid.size} candidates=${candidateReports.size} msgs=${messageCount} dropped=${droppedMessages}`);
  if (rssGB > MEMORY_CLEANUP_THRESHOLD_GB) {
    console.warn(`[Monitor] High memory (${rssGB.toFixed(2)}GB > ${MEMORY_CLEANUP_THRESHOLD_GB}GB) — forcing aggressive cleanup`);
    cleanupAggregates();
    openskyResponseCache.clear();
    openskyNegativeCache.clear();
    rssResponseCache.clear();
    polymarketCache.clear();
    worldbankCache.clear();
    if (global.gc) global.gc();
  }
}, 60 * 1000);

// Graceful shutdown — disconnect Telegram BEFORE container dies.
// Railway sends SIGTERM during deploys; without this, the old container keeps
// the Telegram session alive while the new container connects → AUTH_KEY_DUPLICATED.
async function gracefulShutdown(signal) {
  console.log(`[Relay] ${signal} received — shutting down`);
  if (telegramState.client) {
    console.log('[Relay] Disconnecting Telegram client...');
    try {
      await Promise.race([
        telegramState.client.disconnect(),
        new Promise(r => setTimeout(r, 3000)),
      ]);
    } catch {}
    telegramState.client = null;
  }
  if (upstreamSocket) {
    try { upstreamSocket.close(); } catch {}
  }
  for (const ws of clients) {
    try { ws.terminate(); } catch {}
  }
  clients.clear();
  redis.quit().catch(() => {});
  server.close(() => process.exit(0));
  server.closeAllConnections();
  setTimeout(() => process.exit(0), 5000);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
