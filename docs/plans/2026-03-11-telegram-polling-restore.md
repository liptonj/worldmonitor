# Telegram Polling Architecture Restore — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the broken event-based Telegram ingestion (`NewMessage` handler) with the proven polling architecture from `scripts/ais-relay.cjs`, restoring message reception for all 26 monitored channels.

**Architecture:** The current `services/ingest-telegram/index.cjs` uses GramJS's `client.addEventHandler(…, new NewMessage({}))` which silently fails for public channels — Telegram servers stop sending updates unless the client periodically "shows interest". The fix replaces this with an active polling loop (`client.getMessages()` per channel) with cursor-based pagination, per-channel rate limiting, deduplication, and headline ingestion to Redis. This mirrors the proven approach in `scripts/ais-relay.cjs` lines 1446–1748.

**Tech Stack:** Node.js (CJS), GramJS (`telegram` npm package), Redis (via `@worldmonitor/shared/redis.cjs`), gRPC broadcast (via `@worldmonitor/shared/grpc-client.cjs`)

**Root cause reference:** GramJS `NewMessage({})` event handler does not fire for public channels the client hasn't "subscribed to" via `getDialogs()` or similar. The old `ais-relay.cjs` used `client.getMessages(entity, { limit, minId })` in a polling loop, which works reliably.

---

## Context for the implementing engineer

### Files you'll be modifying

| File | Purpose |
|---|---|
| `services/ingest-telegram/index.cjs` | Main service — replace event handler with polling loop |
| `services/ingest-telegram/test/ingest-telegram.test.cjs` | Unit tests for the service |
| `services/docker-compose.yml` | Add new environment variables |
| `services/docker-compose.dev.yml` | Dev overrides for new env vars |

### Key reference files (read-only)

| File | Purpose |
|---|---|
| `scripts/ais-relay.cjs:1446–1748` | Original working polling implementation to port from |
| `services/shared/redis.cjs` | Redis wrapper (`get`, `setex`, `getClient`, `keys`) |
| `services/shared/grpc-client.cjs` | gRPC broadcast client |
| `services/shared/logger.cjs` | Structured JSON logger |
| `data/telegram-channels.json` | Channel config with `handle`, `label`, `topic`, `region`, `tier`, `maxMessages` |
| `src/data/intelligence-handler.ts:161–247` | Frontend handler for `telegram` channel — accepts `{ messages: [...], count, timestamp }` |

### How data flows

1. `ingest-telegram` polls Telegram channels via `client.getMessages()`
2. Messages are normalized and stored in an in-memory buffer
3. Buffer is persisted to Redis key `relay:telegram:v1` as `{ messages: [...], count, timestamp }`
4. Buffer is broadcast via gRPC to `gateway` on channel `telegram`
5. Gateway pushes to frontend WebSocket subscribers
6. Frontend `intelligence-handler.ts` `telegram` handler receives payload, maps to `TelegramFeedResponse`, renders in `TelegramIntelPanel`

### Message format the frontend expects

The frontend `telegram` handler (in `intelligence-handler.ts:161-247`) accepts an object with `messages` or `items` array, where each message has: `id`, `channel`, `label`/`channelTitle`, `text`, `date`/`ts`, `topic`, `tier`, `hasMedia`, `views`, `forwards`. It also accepts a legacy array format with: `id`, `source`, `channel`, `channelTitle`, `url`, `ts`, `text`, `topic`, `tags`, `earlySignal`.

### How to run tests

```bash
cd services && node --test ingest-telegram/test/ingest-telegram.test.cjs
```

### How to run the service locally

```bash
cd services && docker compose up ingest-telegram
```

---

## Task 1: Add `withTimeout` utility

**Files:**
- Modify: `services/ingest-telegram/index.cjs`
- Test: `services/ingest-telegram/test/ingest-telegram.test.cjs`

**Step 1: Write the failing test**

Add to `services/ingest-telegram/test/ingest-telegram.test.cjs`:

```javascript
const { withTimeout } = require('../index.cjs');

describe('withTimeout', () => {
  it('resolves when promise completes before timeout', async () => {
    const result = await withTimeout(Promise.resolve(42), 1000, 'test');
    assert.strictEqual(result, 42);
  });

  it('rejects with TIMEOUT error when promise exceeds timeout', async () => {
    const slow = new Promise((resolve) => setTimeout(() => resolve('late'), 5000));
    await assert.rejects(
      () => withTimeout(slow, 50, 'slow-op'),
      (err) => {
        assert.ok(err.message.includes('TIMEOUT'));
        assert.ok(err.message.includes('slow-op'));
        return true;
      }
    );
  });

  it('propagates rejection from the original promise', async () => {
    const failing = Promise.reject(new Error('original error'));
    await assert.rejects(
      () => withTimeout(failing, 1000, 'test'),
      (err) => {
        assert.strictEqual(err.message, 'original error');
        return true;
      }
    );
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd services && node --test ingest-telegram/test/ingest-telegram.test.cjs`
Expected: FAIL — `withTimeout` is not exported from `index.cjs`

**Step 3: Write minimal implementation**

Add to `services/ingest-telegram/index.cjs` (before `resolveChannelEntities`):

```javascript
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`TIMEOUT after ${ms}ms: ${label}`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}
```

Add `withTimeout` to `module.exports`.

**Step 4: Run test to verify it passes**

Run: `cd services && node --test ingest-telegram/test/ingest-telegram.test.cjs`
Expected: PASS

**Step 5: Commit**

```bash
git add services/ingest-telegram/index.cjs services/ingest-telegram/test/ingest-telegram.test.cjs
git commit -m "feat(ingest-telegram): add withTimeout utility for per-channel timeouts"
```

---

## Task 2: Add `normalizeTelegramMessage` function

The current `formatMessage` produces a format that works but doesn't include `url`, `source`, or `earlySignal` fields the frontend can use. Add a new `normalizeTelegramMessage` that produces the richer format from `ais-relay.cjs`, keep `formatMessage` for backward compat.

**Files:**
- Modify: `services/ingest-telegram/index.cjs`
- Test: `services/ingest-telegram/test/ingest-telegram.test.cjs`

**Step 1: Write the failing test**

```javascript
const { normalizeTelegramMessage } = require('../index.cjs');

describe('normalizeTelegramMessage', () => {
  it('normalizes a GramJS message with channel config', () => {
    const msg = {
      id: 42,
      message: 'Breaking: test event occurred',
      date: 1709251200,
      media: null,
    };
    const channel = {
      handle: 'BNONews',
      label: 'BNO News',
      topic: 'breaking',
      region: 'global',
      tier: 2,
      maxMessages: 25,
    };

    const result = normalizeTelegramMessage(msg, channel);
    assert.strictEqual(result.id, 'BNONews:42');
    assert.strictEqual(result.source, 'telegram');
    assert.strictEqual(result.channel, 'BNONews');
    assert.strictEqual(result.channelTitle, 'BNO News');
    assert.strictEqual(result.url, 'https://t.me/BNONews/42');
    assert.strictEqual(result.text, 'Breaking: test event occurred');
    assert.strictEqual(result.topic, 'breaking');
    assert.deepStrictEqual(result.tags, ['global']);
    assert.strictEqual(result.earlySignal, true);
    assert.ok(result.ts);
  });

  it('truncates text to configurable max chars', () => {
    const msg = { id: 1, message: 'x'.repeat(1000), date: 1709251200 };
    const channel = { handle: 'test', tier: 3 };
    const result = normalizeTelegramMessage(msg, channel);
    assert.strictEqual(result.text.length, 800);
  });

  it('handles missing channel config gracefully', () => {
    const msg = { id: 1, message: 'test', date: 1709251200 };
    const result = normalizeTelegramMessage(msg, null);
    assert.strictEqual(result.channel, 'unknown');
    assert.strictEqual(result.channelTitle, 'unknown');
    assert.strictEqual(result.topic, 'other');
    assert.deepStrictEqual(result.tags, []);
    assert.strictEqual(result.earlySignal, true);
  });

  it('marks earlySignal true for all items (all are early signals)', () => {
    const msg = { id: 1, message: 'test', date: 1709251200 };
    const channel = { handle: 'test', tier: 3 };
    const result = normalizeTelegramMessage(msg, channel);
    assert.strictEqual(result.earlySignal, true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd services && node --test ingest-telegram/test/ingest-telegram.test.cjs`
Expected: FAIL — `normalizeTelegramMessage` is not exported

**Step 3: Write minimal implementation**

Add to `services/ingest-telegram/index.cjs`:

```javascript
const TELEGRAM_MAX_TEXT_CHARS = Math.max(200, Number(process.env.TELEGRAM_MAX_TEXT_CHARS || 800));

function normalizeTelegramMessage(msg, channel) {
  const handle = channel?.handle || 'unknown';
  const textRaw = String(msg?.message || '');
  const text = textRaw.slice(0, TELEGRAM_MAX_TEXT_CHARS);
  const ts = msg?.date ? new Date(msg.date * 1000).toISOString() : new Date().toISOString();
  return {
    id: `${handle}:${msg.id}`,
    source: 'telegram',
    channel: handle,
    channelTitle: channel?.label || handle,
    url: `https://t.me/${handle}/${msg.id}`,
    ts,
    text,
    topic: channel?.topic || 'other',
    tags: [channel?.region].filter(Boolean),
    earlySignal: true,
  };
}
```

Add `normalizeTelegramMessage` to `module.exports`.

**Step 4: Run test to verify it passes**

Run: `cd services && node --test ingest-telegram/test/ingest-telegram.test.cjs`
Expected: PASS

**Step 5: Commit**

```bash
git add services/ingest-telegram/index.cjs services/ingest-telegram/test/ingest-telegram.test.cjs
git commit -m "feat(ingest-telegram): add normalizeTelegramMessage for polling output format"
```

---

## Task 3: Add polling state management

Add cursor tracking, deduplication, and feed state management. This replaces the simple in-memory buffer with a state object matching `ais-relay.cjs`'s `telegramState`.

**Files:**
- Modify: `services/ingest-telegram/index.cjs`
- Test: `services/ingest-telegram/test/ingest-telegram.test.cjs`

**Step 1: Write the failing test**

```javascript
const {
  _resetPollState,
  getPollState,
  mergeNewItems,
} = require('../index.cjs');

describe('polling state management', () => {
  beforeEach(() => {
    _resetPollState();
  });

  it('starts with empty state', () => {
    const state = getPollState();
    assert.strictEqual(state.items.length, 0);
    assert.strictEqual(state.lastPollAt, 0);
    assert.strictEqual(state.lastError, null);
  });

  it('mergeNewItems adds and deduplicates items', () => {
    const items1 = [
      { id: 'ch:1', ts: '2026-03-10T10:00:00Z', text: 'first' },
      { id: 'ch:2', ts: '2026-03-10T10:01:00Z', text: 'second' },
    ];
    mergeNewItems(items1);
    const state1 = getPollState();
    assert.strictEqual(state1.items.length, 2);

    const items2 = [
      { id: 'ch:2', ts: '2026-03-10T10:01:00Z', text: 'second-dup' },
      { id: 'ch:3', ts: '2026-03-10T10:02:00Z', text: 'third' },
    ];
    mergeNewItems(items2);
    const state2 = getPollState();
    assert.strictEqual(state2.items.length, 3);
    assert.strictEqual(state2.items[0].id, 'ch:3');
  });

  it('mergeNewItems caps at max feed size', () => {
    const items = [];
    for (let i = 0; i < 250; i++) {
      items.push({ id: `ch:${i}`, ts: new Date(Date.now() + i * 1000).toISOString(), text: `msg ${i}` });
    }
    mergeNewItems(items);
    const state = getPollState();
    assert.ok(state.items.length <= 200);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd services && node --test ingest-telegram/test/ingest-telegram.test.cjs`
Expected: FAIL — `_resetPollState`, `getPollState`, `mergeNewItems` not exported

**Step 3: Write minimal implementation**

Add to `services/ingest-telegram/index.cjs`:

```javascript
const TELEGRAM_MAX_FEED_ITEMS = Math.max(50, Number(process.env.TELEGRAM_MAX_FEED_ITEMS || 200));

const pollState = {
  cursorByHandle: Object.create(null),
  items: [],
  lastPollAt: 0,
  lastError: null,
};

function _resetPollState() {
  pollState.cursorByHandle = Object.create(null);
  pollState.items = [];
  pollState.lastPollAt = 0;
  pollState.lastError = null;
}

function getPollState() {
  return {
    items: [...pollState.items],
    lastPollAt: pollState.lastPollAt,
    lastError: pollState.lastError,
  };
}

function mergeNewItems(newItems) {
  if (!newItems.length) return;
  const seen = new Set();
  pollState.items = [...newItems, ...pollState.items]
    .filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    .sort((a, b) => (b.ts || '').localeCompare(a.ts || ''))
    .slice(0, TELEGRAM_MAX_FEED_ITEMS);
}
```

Add `_resetPollState`, `getPollState`, `mergeNewItems` to `module.exports`.

**Step 4: Run test to verify it passes**

Run: `cd services && node --test ingest-telegram/test/ingest-telegram.test.cjs`
Expected: PASS

**Step 5: Commit**

```bash
git add services/ingest-telegram/index.cjs services/ingest-telegram/test/ingest-telegram.test.cjs
git commit -m "feat(ingest-telegram): add polling state management with cursor tracking and dedup"
```

---

## Task 4: Implement `pollTelegramOnce`

The core polling function: iterates channels, calls `client.getMessages()` with cursor-based pagination, normalizes messages, handles timeouts, rate limits, `FLOOD_WAIT`, `AUTH_KEY_DUPLICATED`.

**Files:**
- Modify: `services/ingest-telegram/index.cjs`
- Test: `services/ingest-telegram/test/ingest-telegram.test.cjs`

**Step 1: Write the failing test**

```javascript
const { pollTelegramOnce, _resetPollState, getPollState } = require('../index.cjs');

describe('pollTelegramOnce', () => {
  beforeEach(() => {
    _resetPollState();
  });

  it('returns early when client is null', async () => {
    const result = await pollTelegramOnce(null, [], new Map());
    assert.strictEqual(result.channelsPolled, 0);
    assert.strictEqual(result.newItemCount, 0);
  });

  it('polls channels and collects messages from mock client', async () => {
    const mockClient = {
      getEntity: async (handle) => ({ id: BigInt(123) }),
      getMessages: async (entity, opts) => [
        { id: 10, message: 'test message 1', date: 1709251200 },
        { id: 11, message: 'test message 2', date: 1709251201 },
      ],
    };
    const channels = [
      { handle: 'TestChannel', label: 'Test Channel', topic: 'breaking', region: 'global', tier: 2, maxMessages: 25 },
    ];
    const handleToConfig = new Map([['testchannel', channels[0]]]);

    const result = await pollTelegramOnce(mockClient, channels, handleToConfig);
    assert.strictEqual(result.channelsPolled, 1);
    assert.strictEqual(result.newItemCount, 2);
    assert.strictEqual(result.channelsFailed, 0);

    const state = getPollState();
    assert.strictEqual(state.items.length, 2);
  });

  it('skips media-only messages (no text)', async () => {
    const mockClient = {
      getEntity: async () => ({ id: BigInt(123) }),
      getMessages: async () => [
        { id: 10, message: '', date: 1709251200, media: { photo: {} } },
        { id: 11, message: 'has text', date: 1709251201 },
      ],
    };
    const channels = [{ handle: 'TestChannel', topic: 'test' }];
    const handleToConfig = new Map([['testchannel', channels[0]]]);

    const result = await pollTelegramOnce(mockClient, channels, handleToConfig);
    assert.strictEqual(result.newItemCount, 1);
    assert.strictEqual(result.mediaSkipped, 1);
  });

  it('tracks cursor per handle for pagination', async () => {
    let callCount = 0;
    const mockClient = {
      getEntity: async () => ({ id: BigInt(123) }),
      getMessages: async (entity, opts) => {
        callCount++;
        if (callCount === 1) {
          return [{ id: 10, message: 'first poll', date: 1709251200 }];
        }
        assert.strictEqual(opts.minId, 10);
        return [{ id: 11, message: 'second poll', date: 1709251201 }];
      },
    };
    const channels = [{ handle: 'TestChannel', topic: 'test', maxMessages: 25 }];
    const handleToConfig = new Map([['testchannel', channels[0]]]);

    await pollTelegramOnce(mockClient, channels, handleToConfig);
    await pollTelegramOnce(mockClient, channels, handleToConfig);

    const state = getPollState();
    assert.strictEqual(state.items.length, 2);
  });

  it('handles getEntity failure gracefully', async () => {
    const mockClient = {
      getEntity: async () => { throw new Error('entity not found'); },
    };
    const channels = [{ handle: 'BadChannel', topic: 'test' }];
    const handleToConfig = new Map([['badchannel', channels[0]]]);

    const result = await pollTelegramOnce(mockClient, channels, handleToConfig);
    assert.strictEqual(result.channelsFailed, 1);
    assert.strictEqual(result.channelsPolled, 0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd services && node --test ingest-telegram/test/ingest-telegram.test.cjs`
Expected: FAIL — `pollTelegramOnce` signature changed or not exported with new params

**Step 3: Write minimal implementation**

Replace the existing event-handler-based approach. Add this to `services/ingest-telegram/index.cjs`:

```javascript
const TELEGRAM_POLL_INTERVAL_MS = Math.max(15_000, Number(process.env.TELEGRAM_POLL_INTERVAL_MS || 60_000));
const TELEGRAM_CHANNEL_TIMEOUT_MS = 15_000;
const TELEGRAM_POLL_CYCLE_TIMEOUT_MS = 180_000;
const TELEGRAM_RATE_LIMIT_MS = Math.max(300, Number(process.env.TELEGRAM_RATE_LIMIT_MS || 800));

async function pollTelegramOnce(client, channels, handleToConfig) {
  const result = { channelsPolled: 0, channelsFailed: 0, newItemCount: 0, mediaSkipped: 0 };
  if (!client || !channels.length) return result;

  const pollStart = Date.now();
  const newItems = [];

  for (const channel of channels) {
    if (Date.now() - pollStart > TELEGRAM_POLL_CYCLE_TIMEOUT_MS) {
      log.warn('Poll cycle timeout', {
        timeoutMs: TELEGRAM_POLL_CYCLE_TIMEOUT_MS,
        polled: result.channelsPolled,
        total: channels.length,
      });
      break;
    }

    const handle = channel.handle;
    const minId = pollState.cursorByHandle[handle] || 0;

    try {
      const entity = await withTimeout(
        client.getEntity(handle),
        TELEGRAM_CHANNEL_TIMEOUT_MS,
        `getEntity(${handle})`
      );
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
        if (!msg.message) { result.mediaSkipped++; continue; }
        const item = normalizeTelegramMessage(msg, channel);
        newItems.push(item);
        if (!pollState.cursorByHandle[handle] || msg.id > pollState.cursorByHandle[handle]) {
          pollState.cursorByHandle[handle] = msg.id;
        }
      }

      result.channelsPolled++;
      await new Promise((r) => setTimeout(r, TELEGRAM_RATE_LIMIT_MS));
    } catch (e) {
      const em = e?.message || String(e);
      result.channelsFailed++;
      pollState.lastError = `poll ${handle} failed: ${em}`;
      log.warn('Telegram poll error', { handle, error: em });

      if (/AUTH_KEY_DUPLICATED/.test(em)) {
        pollState.lastError = 'session invalidated (AUTH_KEY_DUPLICATED)';
        log.error('Telegram session permanently invalidated', { handle });
        result.permanentlyDisabled = true;
        break;
      }
      if (/FLOOD_WAIT/.test(em)) {
        const wait = parseInt(em.match(/(\d+)/)?.[1] || '60', 10);
        log.warn('Telegram FLOOD_WAIT — stopping poll cycle early', { waitSeconds: wait });
        break;
      }
    }
  }

  if (newItems.length) {
    mergeNewItems(newItems);
  }

  pollState.lastPollAt = Date.now();
  result.newItemCount = newItems.length;

  const elapsed = ((Date.now() - pollStart) / 1000).toFixed(1);
  log.info('Telegram poll complete', {
    channelsPolled: result.channelsPolled,
    totalChannels: channels.length,
    newMessages: result.newItemCount,
    totalItems: pollState.items.length,
    errors: result.channelsFailed,
    mediaSkipped: result.mediaSkipped,
    elapsedSeconds: elapsed,
  });

  return result;
}
```

Add `pollTelegramOnce` to `module.exports`.

**Step 4: Run test to verify it passes**

Run: `cd services && node --test ingest-telegram/test/ingest-telegram.test.cjs`
Expected: PASS

**Step 5: Commit**

```bash
git add services/ingest-telegram/index.cjs services/ingest-telegram/test/ingest-telegram.test.cjs
git commit -m "feat(ingest-telegram): implement pollTelegramOnce with cursor-based channel polling"
```

---

## Task 5: Implement headline ingestion to Redis

Port `ingestTelegramHeadlines` from `ais-relay.cjs` so Telegram messages feed into the shared headline system (`wm:headlines:*` Redis keys).

**Files:**
- Modify: `services/ingest-telegram/index.cjs`
- Test: `services/ingest-telegram/test/ingest-telegram.test.cjs`

**Step 1: Write the failing test**

```javascript
const { ingestTelegramHeadlines } = require('../index.cjs');

describe('ingestTelegramHeadlines', () => {
  it('ingests headlines into Redis scoped keys', async () => {
    const ops = [];
    const mockRedis = {
      status: 'ready',
      lpush: async (key, value) => { ops.push({ op: 'lpush', key, value }); },
      ltrim: async (key, start, stop) => { ops.push({ op: 'ltrim', key, start, stop }); },
      expire: async (key, ttl) => { ops.push({ op: 'expire', key, ttl }); },
    };

    const messages = [
      { text: 'Breaking news from test', ts: '2026-03-10T10:00:00Z', topic: 'breaking' },
      { text: 'Another update', ts: '2026-03-10T10:01:00Z', topic: 'conflict' },
    ];

    await ingestTelegramHeadlines(messages, mockRedis);

    const lpushOps = ops.filter((o) => o.op === 'lpush');
    assert.ok(lpushOps.length > 0, 'should have lpush operations');

    const globalPushes = lpushOps.filter((o) => o.key === 'wm:headlines:global');
    assert.strictEqual(globalPushes.length, 2, 'both messages go to global scope');

    const telegramPushes = lpushOps.filter((o) => o.key === 'wm:headlines:telegram');
    assert.strictEqual(telegramPushes.length, 2, 'both messages go to telegram scope');
  });

  it('skips messages with empty text', async () => {
    const ops = [];
    const mockRedis = {
      status: 'ready',
      lpush: async (key, value) => { ops.push({ op: 'lpush', key, value }); },
      ltrim: async () => {},
      expire: async () => {},
    };

    const messages = [
      { text: '', ts: '2026-03-10T10:00:00Z', topic: 'breaking' },
      { text: '   ', ts: '2026-03-10T10:00:00Z', topic: 'breaking' },
      { text: 'valid message', ts: '2026-03-10T10:00:00Z', topic: 'breaking' },
    ];

    await ingestTelegramHeadlines(messages, mockRedis);
    const lpushOps = ops.filter((o) => o.op === 'lpush');
    assert.ok(lpushOps.length >= 1, 'only valid messages are ingested');
  });

  it('returns early when redis is not ready', async () => {
    const mockRedis = { status: 'connecting' };
    await ingestTelegramHeadlines([{ text: 'test' }], mockRedis);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd services && node --test ingest-telegram/test/ingest-telegram.test.cjs`
Expected: FAIL — `ingestTelegramHeadlines` not exported

**Step 3: Write minimal implementation**

```javascript
async function ingestTelegramHeadlines(messages, redisClient) {
  if (!redisClient || redisClient.status !== 'ready' || !messages || messages.length === 0) return;

  const headlines = messages
    .filter((m) => m.text && m.text.trim())
    .map((m) => ({
      title: m.text.trim().slice(0, 500),
      pubDate: m.ts ? Math.floor(new Date(m.ts).getTime() / 1000) : Math.floor(Date.now() / 1000),
      scopes: [...new Set([m.topic || 'global', 'global', 'telegram'])],
    }));

  if (headlines.length === 0) return;

  let ingested = 0;
  for (const h of headlines) {
    const item = JSON.stringify({ title: h.title, pubDate: h.pubDate });
    for (const scope of h.scopes) {
      if (!scope) continue;
      try {
        const key = `wm:headlines:${scope}`;
        await redisClient.lpush(key, item);
        await redisClient.ltrim(key, 0, 99);
        await redisClient.expire(key, 86400);
      } catch { /* swallow per-scope errors */ }
    }
    ingested++;
  }
  if (ingested > 0) log.info('Ingested telegram headlines', { count: ingested });
}
```

Add `ingestTelegramHeadlines` to `module.exports`.

**Step 4: Run test to verify it passes**

Run: `cd services && node --test ingest-telegram/test/ingest-telegram.test.cjs`
Expected: PASS

**Step 5: Commit**

```bash
git add services/ingest-telegram/index.cjs services/ingest-telegram/test/ingest-telegram.test.cjs
git commit -m "feat(ingest-telegram): add headline ingestion to Redis scoped keys"
```

---

## Task 6: Implement guarded poll wrapper

Prevents concurrent polls and handles stuck-poll detection, matching `ais-relay.cjs` `guardedTelegramPoll`.

**Files:**
- Modify: `services/ingest-telegram/index.cjs`
- Test: `services/ingest-telegram/test/ingest-telegram.test.cjs`

**Step 1: Write the failing test**

```javascript
const { createGuardedPoll, _resetPollState } = require('../index.cjs');

describe('createGuardedPoll', () => {
  beforeEach(() => {
    _resetPollState();
  });

  it('executes poll function and prevents concurrent calls', async () => {
    let callCount = 0;
    const slowPoll = async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 100));
      return { channelsPolled: 1, newItemCount: 1, channelsFailed: 0, mediaSkipped: 0 };
    };

    const guarded = createGuardedPoll(slowPoll);

    const p1 = guarded();
    const p2 = guarded();
    await Promise.all([p1, p2]);

    assert.strictEqual(callCount, 1, 'second call should be skipped while first is in-flight');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd services && node --test ingest-telegram/test/ingest-telegram.test.cjs`
Expected: FAIL — `createGuardedPoll` not exported

**Step 3: Write minimal implementation**

```javascript
function createGuardedPoll(pollFn) {
  let inFlight = false;
  let startedAt = 0;

  return async function guardedPoll() {
    if (inFlight) {
      const stuck = Date.now() - startedAt;
      if (stuck > TELEGRAM_POLL_CYCLE_TIMEOUT_MS + 30_000) {
        log.warn('Poll stuck — force-clearing in-flight flag', { stuckMs: stuck });
        inFlight = false;
      } else {
        return;
      }
    }
    inFlight = true;
    startedAt = Date.now();
    try {
      return await pollFn();
    } catch (e) {
      log.warn('Guarded poll error', { error: e?.message || String(e) });
    } finally {
      inFlight = false;
    }
  };
}
```

Add `createGuardedPoll` to `module.exports`.

**Step 4: Run test to verify it passes**

Run: `cd services && node --test ingest-telegram/test/ingest-telegram.test.cjs`
Expected: PASS

**Step 5: Commit**

```bash
git add services/ingest-telegram/index.cjs services/ingest-telegram/test/ingest-telegram.test.cjs
git commit -m "feat(ingest-telegram): add guarded poll wrapper to prevent concurrent polls"
```

---

## Task 7: Rewrite `startTelegramClient` to use polling loop

This is the core integration task. Replace the event handler approach in `startTelegramClient` with the polling loop. Also add startup delay support.

**Files:**
- Modify: `services/ingest-telegram/index.cjs`

**Step 1: Rewrite `startTelegramClient`**

Replace the entire `startTelegramClient` function body. Key changes:

1. **Remove** the `client.addEventHandler(…, new NewMessage({}))` block (lines 216-240)
2. **Remove** the `client._handleUpdate` monkey-patch (lines 242-250)
3. **Remove** the `persistInterval` that persists the old event-based buffer (lines 254-262)
4. **Add** startup delay before first connection
5. **Add** polling loop using `setInterval` + `createGuardedPoll`
6. **Update** persist to use `pollState.items` instead of `messageBuffer`

Here is the full replacement for `startTelegramClient`:

```javascript
const TELEGRAM_STARTUP_DELAY_MS = Math.max(0, Number(process.env.TELEGRAM_STARTUP_DELAY_MS || 60_000));

async function startTelegramClient(gatewayClient) {
  const sessionString = process.env.TELEGRAM_SESSION;
  const apiId = parseInt(process.env.TELEGRAM_API_ID || '0', 10);
  const apiHash = process.env.TELEGRAM_API_HASH || '';
  const channelSet = process.env.TELEGRAM_CHANNEL_SET;
  const channelsEnv = process.env.TELEGRAM_CHANNELS;

  if (!sessionString) {
    log.warn('TELEGRAM_SESSION not set — Telegram ingest disabled');
    return;
  }
  if (!apiId || !apiHash) {
    log.warn('TELEGRAM_API_ID or TELEGRAM_API_HASH not set — Telegram ingest disabled');
    return;
  }

  let channels = [];
  if (channelSet) {
    channels = loadChannelsFromSet(channelSet);
  } else if (channelsEnv) {
    channels = channelsEnv.split(',').map((h) => ({ handle: h.trim(), enabled: true }));
  }

  if (channels.length === 0) {
    log.warn('No channels configured — set TELEGRAM_CHANNEL_SET or TELEGRAM_CHANNELS');
    return;
  }

  const handleToConfig = buildHandleToConfig(channels);
  const handles = channels.map((c) => c.handle);
  log.info('Starting Telegram client', { channelCount: channels.length, handles });

  if (TELEGRAM_STARTUP_DELAY_MS > 0) {
    log.info('Startup delay — waiting for old container to disconnect', { delayMs: TELEGRAM_STARTUP_DELAY_MS });
    await new Promise((r) => setTimeout(r, TELEGRAM_STARTUP_DELAY_MS));
  }

  const normalised = sessionString[0] === '1' ? sessionString : '1' + sessionString;
  const session = new StringSession(normalised);
  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 3,
    retryDelay: 2000,
    autoReconnect: true,
  });

  let connected = false;
  let permanentlyDisabled = false;

  async function connectClient() {
    try {
      await client.connect();
      connected = true;
      log.info('Connected to Telegram');
    } catch (err) {
      connected = false;
      const em = err?.message || String(err);
      if (/AUTH_KEY_DUPLICATED/.test(em)) {
        permanentlyDisabled = true;
        log.error('Telegram session permanently invalidated (AUTH_KEY_DUPLICATED)');
        return;
      }
      log.error('Failed to connect to Telegram', { error: em });
      throw err;
    }
  }

  await connectClient();
  if (permanentlyDisabled) return;

  async function doPoll() {
    if (!connected || permanentlyDisabled) return { channelsPolled: 0, newItemCount: 0, channelsFailed: 0, mediaSkipped: 0 };

    const result = await pollTelegramOnce(client, channels, handleToConfig);

    if (result.permanentlyDisabled) {
      permanentlyDisabled = true;
      try { client.disconnect(); } catch { /* ignore */ }
      return result;
    }

    await persistPollBuffer(gatewayClient);
    return result;
  }

  const guardedPoll = createGuardedPoll(doPoll);

  guardedPoll();
  const pollInterval = setInterval(guardedPoll, TELEGRAM_POLL_INTERVAL_MS);
  log.info('Telegram poll loop started', { intervalMs: TELEGRAM_POLL_INTERVAL_MS });

  const statsInterval = setInterval(() => {
    log.info('Telegram stats', {
      connected,
      permanentlyDisabled,
      totalItems: pollState.items.length,
      lastPollAt: pollState.lastPollAt ? new Date(pollState.lastPollAt).toISOString() : 'never',
      lastError: pollState.lastError,
      targetChannels: handles.length,
    });
  }, 60_000);

  return () => {
    clearInterval(pollInterval);
    clearInterval(statsInterval);
    try { client.disconnect(); } catch { /* ignore */ }
  };
}
```

**Step 2: Add `persistPollBuffer` function**

Replace or supplement the existing `persistBuffer` with one that uses `pollState.items`:

```javascript
async function persistPollBuffer(gatewayClient) {
  const data = {
    messages: pollState.items,
    count: pollState.items.length,
    timestamp: new Date().toISOString(),
  };

  try {
    await redisSetex(REDIS_KEY, BUFFER_TTL, data);
    log.debug('Telegram poll buffer persisted', { count: data.count });
  } catch (err) {
    log.warn('Failed to persist Telegram poll buffer', { error: err.message });
  }

  if (gatewayClient && data.count > 0) {
    try {
      await broadcast(gatewayClient, {
        channel: 'telegram',
        payload: Buffer.from(JSON.stringify(data)),
        timestampMs: Date.now(),
        triggerId: 'ingest-telegram',
      });
    } catch (err) {
      log.warn('Failed to broadcast Telegram poll buffer', { error: err.message });
    }
  }

  try {
    const redisClient = require('@worldmonitor/shared/redis.cjs').getClient();
    if (redisClient) {
      await ingestTelegramHeadlines(
        pollState.items.filter((i) => i._newThisCycle),
        redisClient,
      );
    }
  } catch (err) {
    log.warn('Failed to ingest headlines', { error: err.message });
  }
}
```

**Step 3: Run existing tests to verify nothing broke**

Run: `cd services && node --test ingest-telegram/test/ingest-telegram.test.cjs`
Expected: PASS (existing tests for `addMessage`, `getMessageBuffer`, `persistBuffer`, `formatMessage`, `buildHandleToConfig`, `startTelegramClient` disabled states should still pass)

Note: The old `addMessage`/`getMessageBuffer`/`persistBuffer` functions and their tests can remain for backward compatibility — they aren't called by the new polling path but their exports are harmless.

**Step 4: Commit**

```bash
git add services/ingest-telegram/index.cjs
git commit -m "feat(ingest-telegram): replace event handler with polling loop architecture"
```

---

## Task 8: Update Docker environment configuration

Add new environment variables to Docker Compose files.

**Files:**
- Modify: `services/docker-compose.yml`
- Modify: `services/docker-compose.dev.yml`

**Step 1: Update `services/docker-compose.yml`**

Add these env vars to the `ingest-telegram` service (after `LOG_LEVEL=info`):

```yaml
      - TELEGRAM_POLL_INTERVAL_MS=${TELEGRAM_POLL_INTERVAL_MS:-60000}
      - TELEGRAM_STARTUP_DELAY_MS=${TELEGRAM_STARTUP_DELAY_MS:-60000}
      - TELEGRAM_RATE_LIMIT_MS=${TELEGRAM_RATE_LIMIT_MS:-800}
      - TELEGRAM_MAX_TEXT_CHARS=${TELEGRAM_MAX_TEXT_CHARS:-800}
      - TELEGRAM_MAX_FEED_ITEMS=${TELEGRAM_MAX_FEED_ITEMS:-200}
```

**Step 2: Update `services/docker-compose.dev.yml`**

Add faster poll interval for dev:

```yaml
  ingest-telegram:
    environment:
      - LOG_LEVEL=debug
      - NODE_ENV=development
      - TELEGRAM_POLL_INTERVAL_MS=30000
      - TELEGRAM_STARTUP_DELAY_MS=5000
```

**Step 3: Commit**

```bash
git add services/docker-compose.yml services/docker-compose.dev.yml
git commit -m "chore(docker): add polling environment variables for ingest-telegram"
```

---

## Task 9: Update and verify all tests pass

Run the full test suite and fix any broken tests. The old `messageBuffer`-based tests can remain since those functions still exist but are no longer called by the polling path.

**Files:**
- Modify: `services/ingest-telegram/test/ingest-telegram.test.cjs` (if needed)

**Step 1: Run all tests**

Run: `cd services && node --test ingest-telegram/test/ingest-telegram.test.cjs`
Expected: All tests PASS

**Step 2: If any test fails, fix it**

Common fixes:
- If `startTelegramClient` tests fail, check that the "disabled states" tests still work with the new function signature
- If `persistBuffer` tests fail, ensure the old function still uses `messageBuffer` (it should remain untouched for backward compat)

**Step 3: Commit if fixes were needed**

```bash
git add services/ingest-telegram/test/ingest-telegram.test.cjs
git commit -m "test(ingest-telegram): fix tests after polling architecture migration"
```

---

## Task 10: Manual integration test

**Step 1: Rebuild and run the service**

```bash
cd services && docker compose build ingest-telegram && docker compose up -d ingest-telegram
```

**Step 2: Watch logs for polling activity**

```bash
docker compose logs -f ingest-telegram
```

Expected log sequence:
1. `Starting ingest-telegram`
2. `Loaded channels from set` (count: 26)
3. `Starting Telegram client` (channelCount: 26)
4. `Startup delay — waiting for old container to disconnect`
5. `Connected to Telegram`
6. `Telegram poll loop started`
7. `Telegram poll complete` (channelsPolled: 26, newMessages: > 0)
8. `Telegram poll buffer persisted` (count: > 0)
9. Repeated every 60s: `Telegram poll complete`

**Step 3: Verify Redis data**

```bash
docker compose exec redis redis-cli GET relay:telegram:v1 | head -c 500
```

Expected: JSON with `{ "messages": [...], "count": N, "timestamp": "..." }` where `count > 0` and messages have `id`, `source`, `channel`, `channelTitle`, `url`, `ts`, `text`, `topic`, `tags`, `earlySignal` fields.

**Step 4: Verify frontend receives data**

Open the WorldMonitor dashboard and check the Telegram Intel panel. It should show messages instead of "no available messages".

**Step 5: Commit final state**

```bash
git add -A
git commit -m "feat(ingest-telegram): restore polling architecture — Telegram messages working"
```

---

9---

# Phase 2: Telegram AI Summarization

> Tasks 11–18 add an AI-powered summarization layer on top of the restored polling data.
> Every 5 minutes, a new `ai:telegram-summary` generator reads the polled Telegram messages,
> produces per-channel detailed summaries, a cross-channel situational digest with early-warning
> detection, and a delta comparison against the previous summary highlighting changes.
> Prompts are stored in Supabase (`wm_admin.llm_prompts`) following the existing pattern.
> LLM model: `qwen3.5-9b` via Ollama.

### Phase 2 data flow

```
relay:telegram:v1 (polled messages)
        │
        ▼
┌─────────────────────────────────────┐
│ ai-engine: telegram-summary.cjs     │
│                                     │
│  1. Read messages from Redis        │
│  2. Read previous summary (:prev)   │
│  3. Group by channel                │
│  4. LLM call 1: per-channel summary │
│  5. LLM call 2: cross-channel +     │
│     early warning + delta analysis  │
└─────────────────────────────────────┘
        │
        ▼
ai:telegram-summary:v1 (Redis)
        │
        ├─► gRPC broadcast → gateway → WebSocket → frontend
        │
        ▼
TelegramSummaryPanel (new panel)
```

### Output shape stored at `ai:telegram-summary:v1`

```json
{
  "timestamp": "2026-03-11T01:00:00Z",
  "source": "ai:telegram-summary",
  "status": "success",
  "data": {
    "channelSummaries": [
      {
        "channel": "BNONews",
        "channelTitle": "BNO News",
        "summary": "...",
        "themes": ["earthquake", "casualties"],
        "sentiment": "alarming",
        "messageCount": 12
      }
    ],
    "crossChannelDigest": "...",
    "earlyWarnings": [
      { "event": "...", "reportedBy": ["BNONews", "AuroraIntel"], "confidence": "high" }
    ],
    "changes": [
      { "type": "new", "description": "..." },
      { "type": "escalation", "description": "..." },
      { "type": "resolved", "description": "..." }
    ],
    "previousSummaryComparison": "Compared to 5 minutes ago: 2 new developments, 1 escalation...",
    "model": "qwen3.5-9b",
    "provider": "ollama",
    "generatedAt": "2026-03-11T01:00:00Z"
  }
}
```

---

## Task 11: Create Supabase migration for Telegram summary prompts and config

Seed the prompts, function config, and service config into Supabase.

**Files:**
- Create: `supabase/migrations/20260311000001_add_telegram_summary_ai.sql`

**Step 1: Write the migration**

```sql
-- Migration: Seed AI prompts + function config + service config for Telegram channel summarization

-- 1. Prompts
insert into wm_admin.llm_prompts (prompt_key, variant, mode, model_name, system_prompt, user_prompt)
values
  ('telegram_channel_summary', null, null, null,
   'You are an OSINT analyst specializing in Telegram channel monitoring. Current date: {date}.

Analyze the following messages from monitored Telegram channels grouped by channel. For each channel that has messages, produce a detailed summary including:
- Key themes and topics being discussed
- Notable or significant messages (quote briefly)
- Overall sentiment (e.g. alarming, routine, escalatory, de-escalatory)
- Message count

You MUST respond with ONLY valid JSON, no prose, no markdown fences. Use this exact structure:
{
  "channelSummaries": [
    {
      "channel": "handle",
      "channelTitle": "Display Name",
      "summary": "2-4 sentence summary",
      "themes": ["theme1", "theme2"],
      "sentiment": "alarming|routine|escalatory|de-escalatory|mixed",
      "messageCount": 12
    }
  ]
}

Only include channels that have messages. Order by significance (most noteworthy first).',

   'Here are the latest messages from {channelCount} monitored Telegram OSINT channels, grouped by channel:

{channelMessages}

Produce detailed per-channel summaries.'),

  ('telegram_cross_channel', null, null, null,
   'You are a senior intelligence analyst. Current date: {date}.

You are given per-channel summaries from {channelCount} Telegram OSINT channels, plus the previous cross-channel digest from ~5 minutes ago.

Your tasks:
1. SITUATIONAL OVERVIEW: Synthesize a 3-5 sentence cross-channel situational awareness digest. What are the key developments right now?
2. EARLY WARNINGS: Identify events or developments being reported by 2+ channels simultaneously. These are higher-confidence signals. Rate confidence as high (3+ channels), medium (2 channels).
3. CHANGES SINCE LAST SUMMARY: Compare against the previous summary and call out:
   - "new": Developments not present in the previous summary
   - "escalation": Situations that have intensified
   - "de-escalation": Situations that have calmed
   - "resolved": Events from the previous summary no longer being reported
4. COMPARISON: One sentence summarizing what changed overall.

You MUST respond with ONLY valid JSON, no prose, no markdown fences. Use this exact structure:
{
  "crossChannelDigest": "3-5 sentence overview",
  "earlyWarnings": [
    { "event": "description", "reportedBy": ["Channel1", "Channel2"], "confidence": "high|medium" }
  ],
  "changes": [
    { "type": "new|escalation|de-escalation|resolved", "description": "what changed" }
  ],
  "previousSummaryComparison": "one sentence comparing to 5 minutes ago"
}

If there is no previous summary, treat everything as "new".',

   'Per-channel summaries:
{channelSummaries}

Previous cross-channel digest (from ~5 minutes ago):
{previousSummary}

Produce the cross-channel digest, early warnings, and change analysis.')
on conflict (prompt_key, variant, mode, model_name) do nothing;

-- 2. Function config (provider chain)
insert into wm_admin.llm_function_config (function_key, provider_chain, timeout_ms, description)
values
  ('telegram_channel_summary', '{ollama}', 120000, 'Per-channel Telegram summaries'),
  ('telegram_cross_channel',   '{ollama}', 120000, 'Cross-channel Telegram digest with delta')
on conflict (function_key) do nothing;

-- 3. Service config (orchestrator schedule — every 5 minutes, offset by 2 min)
insert into wm_admin.service_config (service_key, cron_schedule, redis_key, ttl_seconds, fetch_type, description, settings)
values
  ('ai:telegram-summary', '2-59/5 * * * *', 'ai:telegram-summary:v1', 300, 'custom', 'AI Telegram channel summaries with cross-channel digest', '{}')
on conflict (service_key) do nothing;
```

**Step 2: Apply the migration locally**

Run: `npx supabase db push` (or apply via your local Supabase workflow)

**Step 3: Verify prompts are accessible**

Run against local Supabase:
```sql
select prompt_key, length(system_prompt) as sys_len, length(user_prompt) as usr_len
from wm_admin.llm_prompts
where prompt_key like 'telegram_%';
```
Expected: 2 rows (`telegram_channel_summary`, `telegram_cross_channel`)

**Step 4: Commit**

```bash
git add supabase/migrations/20260311000001_add_telegram_summary_ai.sql
git commit -m "feat(db): add Telegram AI summary prompts, function config, and service schedule"
```

---

## Task 12: Create the `telegram-summary` generator

The core AI generator that reads polled Telegram messages, calls the LLM twice (per-channel then cross-channel+delta), and returns the combined result.

**Files:**
- Create: `services/ai-engine/generators/telegram-summary.cjs`
- Test: `services/ai-engine/test/generators/telegram-summary.test.cjs`

**Step 1: Write the failing test**

Create `services/ai-engine/test/generators/telegram-summary.test.cjs`:

```javascript
'use strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'test-anon-key';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const generateTelegramSummary = require('../../generators/telegram-summary.cjs');

describe('generateTelegramSummary', () => {
  it('returns error when supabase is missing', async () => {
    const result = await generateTelegramSummary({
      supabase: null,
      redis: { get: async () => null },
      log: { debug() {}, info() {}, warn() {}, error() {} },
      http: {},
    });
    assert.strictEqual(result.status, 'error');
    assert.ok(result.error.includes('supabase'));
  });

  it('returns early with no-data status when telegram buffer is empty', async () => {
    const result = await generateTelegramSummary({
      supabase: {},
      redis: { get: async () => null },
      log: { debug() {}, info() {}, warn() {}, error() {} },
      http: {},
    });
    assert.strictEqual(result.status, 'skipped');
    assert.ok(result.error.includes('No telegram'));
  });

  it('returns early when telegram buffer has zero messages', async () => {
    const result = await generateTelegramSummary({
      supabase: {},
      redis: { get: async (key) => {
        if (key === 'relay:telegram:v1') return { messages: [], count: 0, timestamp: new Date().toISOString() };
        return null;
      }},
      log: { debug() {}, info() {}, warn() {}, error() {} },
      http: {},
    });
    assert.strictEqual(result.status, 'skipped');
  });

  it('groups messages by channel correctly', async () => {
    const { groupMessagesByChannel } = require('../../generators/telegram-summary.cjs');
    const messages = [
      { channel: 'BNONews', text: 'msg1' },
      { channel: 'AuroraIntel', text: 'msg2' },
      { channel: 'BNONews', text: 'msg3' },
    ];
    const grouped = groupMessagesByChannel(messages);
    assert.strictEqual(Object.keys(grouped).length, 2);
    assert.strictEqual(grouped['BNONews'].length, 2);
    assert.strictEqual(grouped['AuroraIntel'].length, 1);
  });

  it('builds per-channel context string with character limit', async () => {
    const { buildChannelContext } = require('../../generators/telegram-summary.cjs');
    const grouped = {
      'TestChannel': [
        { channel: 'TestChannel', channelTitle: 'Test Channel', text: 'Hello world', ts: '2026-03-11T00:00:00Z' },
      ],
    };
    const context = buildChannelContext(grouped, 5000);
    assert.ok(context.includes('TestChannel'));
    assert.ok(context.includes('Hello world'));
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd services && node --test ai-engine/test/generators/telegram-summary.test.cjs`
Expected: FAIL — module not found

**Step 3: Write the generator implementation**

Create `services/ai-engine/generators/telegram-summary.cjs`:

```javascript
'use strict';

const { callLLMForFunction, extractJson } = require('@worldmonitor/shared/llm.cjs');

const MAX_CONTEXT_CHARS = 12_000;
const MAX_CHANNEL_MSGS = 30;

function groupMessagesByChannel(messages) {
  const grouped = Object.create(null);
  for (const msg of messages) {
    const ch = msg.channel || msg.channelTitle || 'unknown';
    if (!grouped[ch]) grouped[ch] = [];
    grouped[ch].push(msg);
  }
  return grouped;
}

function buildChannelContext(grouped, maxChars) {
  const sections = [];
  for (const [channel, msgs] of Object.entries(grouped)) {
    const title = msgs[0]?.channelTitle || channel;
    const lines = msgs.slice(0, MAX_CHANNEL_MSGS).map((m) => {
      const ts = m.ts || (typeof m.date === 'number' ? new Date(m.date).toISOString() : '');
      return `[${ts}] ${String(m.text || '').slice(0, 400)}`;
    });
    sections.push(`### ${title} (@${channel}) — ${msgs.length} messages\n${lines.join('\n')}`);
  }
  let result = sections.join('\n\n');
  if (result.length > maxChars) {
    result = result.slice(0, maxChars) + '\n[truncated]';
  }
  return result;
}

const FALLBACK_CHANNEL_SYSTEM = 'You are an OSINT analyst. Summarize the following Telegram channel messages grouped by channel. For each channel produce: summary (2-4 sentences), themes (array), sentiment (one word), messageCount. Respond with ONLY valid JSON: { "channelSummaries": [...] }';
const FALLBACK_CROSS_SYSTEM = 'You are a senior intelligence analyst. Given per-channel Telegram summaries and the previous digest, produce: crossChannelDigest (3-5 sentences), earlyWarnings (events from 2+ channels), changes (new/escalation/de-escalation/resolved vs previous), previousSummaryComparison (one sentence). Respond with ONLY valid JSON.';

module.exports = async function generateTelegramSummary({ supabase, redis, log, http }) {
  log.debug('generateTelegramSummary executing');

  try {
    if (!supabase || !http) {
      throw new Error('supabase and http are required');
    }

    const [telegramData, previousSummaryRaw] = await Promise.all([
      redis.get('relay:telegram:v1'),
      redis.get('ai:telegram-summary:v1'),
    ]);

    const messages = telegramData?.messages || telegramData?.items || [];
    if (!Array.isArray(messages) || messages.length === 0) {
      log.info('No telegram messages available for summarization');
      return {
        timestamp: new Date().toISOString(),
        source: 'ai:telegram-summary',
        data: null,
        status: 'skipped',
        error: 'No telegram messages available',
      };
    }

    const textMessages = messages.filter((m) => m.text && String(m.text).trim().length > 10);
    if (textMessages.length === 0) {
      log.info('No text messages to summarize (all media-only or too short)');
      return {
        timestamp: new Date().toISOString(),
        source: 'ai:telegram-summary',
        data: null,
        status: 'skipped',
        error: 'No text messages to summarize',
      };
    }

    let previousSummary = null;
    let previousCrossDigest = null;
    if (previousSummaryRaw) {
      try {
        const prev = typeof previousSummaryRaw === 'string' ? JSON.parse(previousSummaryRaw) : previousSummaryRaw;
        const prevData = prev?.data ?? prev;
        previousCrossDigest = prevData?.crossChannelDigest || null;
        previousSummary = prevData;
      } catch (_) { /* ignore parse errors */ }
    }

    const grouped = groupMessagesByChannel(textMessages);
    const channelCount = Object.keys(grouped).length;
    const channelContext = buildChannelContext(grouped, MAX_CONTEXT_CHARS);
    const dateStr = new Date().toISOString().slice(0, 10);

    log.info('Telegram summary: starting per-channel LLM call', {
      channelCount,
      messageCount: textMessages.length,
    });

    // --- LLM Call 1: Per-channel summaries ---
    const channelResult = await callLLMForFunction(
      supabase,
      'telegram_channel_summary',
      'telegram_channel_summary',
      { date: dateStr, channelCount: String(channelCount), channelMessages: channelContext },
      http,
      {
        jsonMode: false,
        fallbackSystemPrompt: FALLBACK_CHANNEL_SYSTEM,
        fallbackUserPrompt: `Summarize these ${channelCount} Telegram channels:\n\n${channelContext}`,
      },
    );

    let channelSummaries = [];
    let channelParsed = channelResult.parsed;
    if (!channelParsed) {
      try { channelParsed = extractJson(channelResult.content); } catch (_) { /* fallback */ }
    }
    if (channelParsed?.channelSummaries && Array.isArray(channelParsed.channelSummaries)) {
      channelSummaries = channelParsed.channelSummaries;
    }

    log.info('Telegram summary: per-channel complete', {
      summaryCount: channelSummaries.length,
      provider: channelResult.provider_name,
      model: channelResult.model_name,
    });

    // --- LLM Call 2: Cross-channel + delta ---
    const channelSummariesStr = JSON.stringify(channelSummaries, null, 2);
    const prevSummaryStr = previousCrossDigest || 'No previous summary available (first run).';

    const crossResult = await callLLMForFunction(
      supabase,
      'telegram_cross_channel',
      'telegram_cross_channel',
      {
        date: dateStr,
        channelCount: String(channelCount),
        channelSummaries: channelSummariesStr,
        previousSummary: prevSummaryStr,
      },
      http,
      {
        jsonMode: false,
        fallbackSystemPrompt: FALLBACK_CROSS_SYSTEM,
        fallbackUserPrompt: `Per-channel summaries:\n${channelSummariesStr}\n\nPrevious digest:\n${prevSummaryStr}\n\nProduce cross-channel digest, early warnings, and change analysis.`,
      },
    );

    let crossChannelDigest = '';
    let earlyWarnings = [];
    let changes = [];
    let previousSummaryComparison = '';

    let crossParsed = crossResult.parsed;
    if (!crossParsed) {
      try { crossParsed = extractJson(crossResult.content); } catch (_) { /* fallback */ }
    }
    if (crossParsed && typeof crossParsed === 'object') {
      crossChannelDigest = crossParsed.crossChannelDigest || crossResult.content;
      earlyWarnings = Array.isArray(crossParsed.earlyWarnings) ? crossParsed.earlyWarnings : [];
      changes = Array.isArray(crossParsed.changes) ? crossParsed.changes : [];
      previousSummaryComparison = crossParsed.previousSummaryComparison || '';
    } else {
      crossChannelDigest = crossResult.content;
    }

    log.info('Telegram summary: cross-channel complete', {
      earlyWarningCount: earlyWarnings.length,
      changeCount: changes.length,
      provider: crossResult.provider_name,
      model: crossResult.model_name,
    });

    return {
      timestamp: new Date().toISOString(),
      source: 'ai:telegram-summary',
      data: {
        channelSummaries,
        crossChannelDigest,
        earlyWarnings,
        changes,
        previousSummaryComparison,
        messageCount: textMessages.length,
        channelCount,
        model: crossResult.model_name,
        provider: crossResult.provider_name,
        generatedAt: new Date().toISOString(),
      },
      status: 'success',
    };
  } catch (err) {
    log.error('generateTelegramSummary error', { error: err.message });
    return {
      timestamp: new Date().toISOString(),
      source: 'ai:telegram-summary',
      data: null,
      status: 'error',
      error: err.message,
    };
  }
};

module.exports.groupMessagesByChannel = groupMessagesByChannel;
module.exports.buildChannelContext = buildChannelContext;
```

**Step 4: Run test to verify it passes**

Run: `cd services && node --test ai-engine/test/generators/telegram-summary.test.cjs`
Expected: PASS

**Step 5: Commit**

```bash
git add services/ai-engine/generators/telegram-summary.cjs services/ai-engine/test/generators/telegram-summary.test.cjs
git commit -m "feat(ai-engine): add telegram-summary generator with per-channel and cross-channel analysis"
```

---

## Task 13: Register the generator in the AI engine

**Files:**
- Modify: `services/ai-engine/index.cjs:14-23`

**Step 1: Add to `GENERATOR_REGISTRY`**

Add this line to the `GENERATOR_REGISTRY` object in `services/ai-engine/index.cjs`:

```javascript
'ai:telegram-summary': require('./generators/telegram-summary.cjs'),
```

After the existing `'ai:risk-overview'` entry.

**Step 2: Run existing AI engine tests to verify nothing broke**

Run: `cd services && node --test ai-engine/test/generators/*.test.cjs`
Expected: All PASS

**Step 3: Commit**

```bash
git add services/ai-engine/index.cjs
git commit -m "feat(ai-engine): register telegram-summary generator"
```

---

## Task 14: Add gateway channel key

**Files:**
- Modify: `services/gateway/channel-keys.json`

**Step 1: Add the channel key**

Add to the `channelKeys` object in `services/gateway/channel-keys.json`:

```json
"ai:telegram-summary": "ai:telegram-summary:v1"
```

After the existing `"ai:risk-overview"` entry.

**Step 2: Commit**

```bash
git add services/gateway/channel-keys.json
git commit -m "feat(gateway): add ai:telegram-summary channel key"
```

---

## Task 15: Add channel registry entry (frontend)

**Files:**
- Modify: `src/config/channel-registry.ts`

**Step 1: Add the channel definition**

Add after the `'ai:risk-overview'` entry in `CHANNEL_REGISTRY`:

```typescript
'ai:telegram-summary': {
  key: 'ai:telegram-summary',
  redisKey: 'ai:telegram-summary:v1',
  panels: ['telegram-summary'],
  domain: 'ai',
  staleAfterMs: 10 * 60_000,
  timeoutMs: 30_000,
  required: false,
},
```

**Step 2: Commit**

```bash
git add src/config/channel-registry.ts
git commit -m "feat(channel-registry): add ai:telegram-summary channel definition"
```

---

## Task 16: Add AI handler for `ai:telegram-summary`

**Files:**
- Modify: `src/data/ai-handler.ts`

**Step 1: Add handler**

Add to the return object in `createAiHandlers`, after the `'ai:risk-overview'` handler:

```typescript
'ai:telegram-summary': (payload: unknown) => {
  if (!payload) { console.warn('[wm:ai:telegram-summary] null/undefined payload'); return; }
  aiPayloadBuffer.set('ai:telegram-summary', payload);
  const panel = ctx.panels['telegram-summary'] as { applyTelegramSummary?: (p: unknown) => void } | undefined;
  if (!panel?.applyTelegramSummary) {
    console.debug('[wm:ai:telegram-summary] panel not yet mounted — payload buffered');
    return;
  }
  panel.applyTelegramSummary(payload);
},
```

**Step 2: Commit**

```bash
git add src/data/ai-handler.ts
git commit -m "feat(ai-handler): add ai:telegram-summary handler with panel forwarding"
```

---

## Task 17: Create `TelegramSummaryPanel` component

**Files:**
- Create: `src/components/TelegramSummaryPanel.ts`

**Step 1: Implement the panel**

Create `src/components/TelegramSummaryPanel.ts`. Follow the same pattern as `GlobalDigestPanel` — extend `Panel`, use `marked` + `DOMPurify` for rendering markdown, and buffer AI payloads.

```typescript
import { Panel } from './Panel';
import { getBufferedAiPayload } from '@/data/ai-handler';
import { h, replaceChildren } from '@/utils/dom';
import { escapeHtml } from '@/utils/escape';
import DOMPurify from 'dompurify';

interface ChannelSummary {
  channel: string;
  channelTitle: string;
  summary: string;
  themes: string[];
  sentiment: string;
  messageCount: number;
}

interface EarlyWarning {
  event: string;
  reportedBy: string[];
  confidence: 'high' | 'medium';
}

interface Change {
  type: 'new' | 'escalation' | 'de-escalation' | 'resolved';
  description: string;
}

interface TelegramSummaryData {
  channelSummaries: ChannelSummary[];
  crossChannelDigest: string;
  earlyWarnings: EarlyWarning[];
  changes: Change[];
  previousSummaryComparison: string;
  messageCount: number;
  channelCount: number;
  model: string;
  provider: string;
  generatedAt: string;
}

export class TelegramSummaryPanel extends Panel {
  override readonly channelKeys = ['ai:telegram-summary'];

  private contentEl!: HTMLElement;
  private footerEl!: HTMLElement;

  override onMount(): void {
    this.contentEl = h('div', { className: 'telegram-summary-content' });
    this.footerEl = h('div', { className: 'telegram-summary-footer' });
    replaceChildren(this.body, this.contentEl, this.footerEl);

    const buffered = getBufferedAiPayload('ai:telegram-summary');
    if (buffered) this.applyTelegramSummary(buffered);
  }

  applyTelegramSummary(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const raw = payload as Record<string, unknown>;
    const data = (raw.data ?? raw) as TelegramSummaryData;

    if (!data.channelSummaries && !data.crossChannelDigest) {
      replaceChildren(this.contentEl, h('div', { className: 'summary-empty' }, 'Waiting for Telegram summary...'));
      return;
    }

    const sections: HTMLElement[] = [];

    if (data.earlyWarnings?.length) {
      const warningItems = data.earlyWarnings.map((w) =>
        h('li', { className: `warning-item warning-${w.confidence}` },
          h('span', { className: 'warning-event' }, escapeHtml(w.event)),
          h('span', { className: 'warning-sources' }, ` (${w.reportedBy.join(', ')} — ${w.confidence} confidence)`),
        ),
      );
      sections.push(
        h('div', { className: 'summary-section early-warnings' },
          h('h4', {}, 'Early Warnings'),
          h('ul', {}, ...warningItems),
        ),
      );
    }

    if (data.crossChannelDigest) {
      const digestDiv = document.createElement('div');
      digestDiv.className = 'cross-channel-digest';
      digestDiv.innerHTML = DOMPurify.sanitize(escapeHtml(data.crossChannelDigest));
      sections.push(
        h('div', { className: 'summary-section' },
          h('h4', {}, 'Situational Overview'),
          digestDiv,
        ),
      );
    }

    if (data.changes?.length) {
      const changeItems = data.changes.map((c) =>
        h('li', { className: `change-item change-${c.type}` },
          h('span', { className: 'change-badge' }, c.type.toUpperCase()),
          h('span', {}, ` ${escapeHtml(c.description)}`),
        ),
      );
      sections.push(
        h('div', { className: 'summary-section changes' },
          h('h4', {}, 'Changes Since Last Update'),
          data.previousSummaryComparison
            ? h('p', { className: 'change-comparison' }, escapeHtml(data.previousSummaryComparison))
            : h('span'),
          h('ul', {}, ...changeItems),
        ),
      );
    }

    if (data.channelSummaries?.length) {
      const channelCards = data.channelSummaries.map((cs) =>
        h('details', { className: 'channel-card' },
          h('summary', { className: 'channel-card-header' },
            h('span', { className: 'channel-name' }, escapeHtml(cs.channelTitle || cs.channel)),
            h('span', { className: `channel-sentiment sentiment-${cs.sentiment}` }, cs.sentiment),
            h('span', { className: 'channel-count' }, `${cs.messageCount} msgs`),
          ),
          h('div', { className: 'channel-card-body' },
            h('p', {}, escapeHtml(cs.summary)),
            cs.themes?.length
              ? h('div', { className: 'channel-themes' }, ...cs.themes.map((t) => h('span', { className: 'theme-tag' }, escapeHtml(t))))
              : h('span'),
          ),
        ),
      );
      sections.push(
        h('div', { className: 'summary-section channel-summaries' },
          h('h4', {}, `Channel Summaries (${data.channelCount})`),
          ...channelCards,
        ),
      );
    }

    replaceChildren(this.contentEl, ...sections);

    if (data.generatedAt) {
      const ts = new Date(data.generatedAt).toLocaleString();
      const meta = `Generated ${ts} · ${data.model || 'unknown'} · ${data.messageCount} messages across ${data.channelCount} channels`;
      replaceChildren(this.footerEl, h('span', { className: 'summary-meta' }, meta));
    }

    this.setDataBadge('live');
  }
}
```

Note: This is a reference implementation. Adjust imports (`Panel`, `h`, `replaceChildren`, `escapeHtml`) to match the actual utility locations in your codebase. Check how `GlobalDigestPanel` and `StrategicPosturePanel` import these utilities and follow the same pattern.

**Step 2: Register the panel**

Register `TelegramSummaryPanel` in the panel creation logic (check `src/App.ts` or `src/config/panels.ts` for where panels are instantiated and add `'telegram-summary'` pointing to `TelegramSummaryPanel`).

**Step 3: Commit**

```bash
git add src/components/TelegramSummaryPanel.ts
git commit -m "feat(frontend): add TelegramSummaryPanel with per-channel, cross-channel, early warning, and delta views"
```

---

## Task 18: End-to-end verification

**Step 1: Ensure polling is working (Tasks 1-10 complete)**

Verify `relay:telegram:v1` has data:
```bash
docker compose exec redis redis-cli GET relay:telegram:v1 | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'count={d[\"count\"]}')"
```
Expected: `count > 0`

**Step 2: Trigger the summary generator manually**

Use the orchestrator or gRPC directly:
```bash
docker compose exec ai-engine node -e "
  const gen = require('./generators/telegram-summary.cjs');
  // ... or trigger via gRPC Execute call
"
```

Or wait for the cron (`*/5` schedule) and watch logs:
```bash
docker compose logs -f ai-engine | grep telegram-summary
```

Expected logs:
1. `generateTelegramSummary executing`
2. `Telegram summary: starting per-channel LLM call` (channelCount > 0)
3. `Telegram summary: per-channel complete` (summaryCount > 0, model: qwen3.5-9b)
4. `Telegram summary: cross-channel complete` (earlyWarningCount >= 0, changeCount >= 0)

**Step 3: Verify Redis output**

```bash
docker compose exec redis redis-cli GET ai:telegram-summary:v1 | python3 -c "
import sys,json
d=json.load(sys.stdin)
data = d.get('data', d)
print(f'status={d.get(\"status\")}')
print(f'channels={len(data.get(\"channelSummaries\",[]))}')
print(f'warnings={len(data.get(\"earlyWarnings\",[]))}')
print(f'changes={len(data.get(\"changes\",[]))}')
print(f'digest_preview={str(data.get(\"crossChannelDigest\",\"\"))[:100]}')
"
```

**Step 4: Verify the panel renders in the frontend**

Open the WorldMonitor dashboard. The new "Telegram Summary" panel should show:
- Early warnings (if any) at the top
- Cross-channel situational overview
- Changes since last update
- Collapsible per-channel summary cards

**Step 5: Verify delta works on second run**

Wait 5 minutes for the second run. Check that the `changes` array and `previousSummaryComparison` contain meaningful delta information.

**Step 6: Commit**

```bash
git add -A
git commit -m "feat: Telegram AI summarization — end-to-end verified"
```

---

## Summary of changes

| What changed | Why |
|---|---|
| `NewMessage` event handler removed | Does not fire for public channels without "interest" signaling |
| `pollTelegramOnce()` added | Active polling via `client.getMessages()` — proven reliable |
| Cursor tracking (`cursorByHandle`) added | Only fetch new messages since last poll (efficiency) |
| `withTimeout` added | Prevent individual channel polls from hanging |
| Per-channel rate limit added | Avoid Telegram `FLOOD_WAIT` bans |
| `AUTH_KEY_DUPLICATED` handling added | Gracefully disable on session invalidation |
| `FLOOD_WAIT` handling added | Stop poll cycle early when rate-limited |
| Guarded poll wrapper added | Prevent concurrent poll cycles |
| Startup delay added | Prevent `AUTH_KEY_DUPLICATED` during rolling deploys |
| `normalizeTelegramMessage` added | Richer message format with `url`, `earlySignal`, `tags` |
| `ingestTelegramHeadlines` added | Feed Telegram data into shared headline system |
| Deduplication added | Prevent duplicate messages in the feed |
| Docker env vars updated | Configurable poll interval, rate limits, startup delay |
| `telegram-summary.cjs` generator added | Two-pass LLM: per-channel summaries + cross-channel digest with delta |
| Supabase prompts seeded | `telegram_channel_summary` and `telegram_cross_channel` in `wm_admin.llm_prompts` |
| `llm_function_config` seeded | Provider chain (`{ollama}`) for both Telegram summary functions |
| `service_config` seeded | `ai:telegram-summary` scheduled every 5 minutes |
| `TelegramSummaryPanel` created | Dedicated panel with early warnings, situational overview, changes, per-channel cards |
| Gateway + channel registry updated | `ai:telegram-summary` → `ai:telegram-summary:v1` wired end-to-end |
| AI handler updated | Buffers and forwards `ai:telegram-summary` payload to panel |
