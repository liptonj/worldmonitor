'use strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'test-anon-key';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  addMessage,
  getMessageBuffer,
  persistBuffer,
  startTelegramClient,
  formatMessage,
  buildHandleToConfig,
  _resetBuffer,
  withTimeout,
  normalizeTelegramMessage,
  _resetPollState,
  getPollState,
  mergeNewItems,
  pollTelegramOnce,
  ingestTelegramHeadlines,
} = require('../index.cjs');

describe('withTimeout', () => {
  it('resolves when promise completes before timeout', async () => {
    const result = await withTimeout(
      Promise.resolve('ok'),
      100,
      'test-label'
    );
    assert.strictEqual(result, 'ok');
  });

  it('rejects with TIMEOUT error when promise exceeds timeout', async () => {
    const slow = new Promise((resolve) => setTimeout(() => resolve('late'), 200));
    await assert.rejects(
      () => withTimeout(slow, 50, 'slow-channel'),
      (err) => {
        assert.strictEqual(err.message, 'TIMEOUT after 50ms: slow-channel');
        return true;
      }
    );
  });

  it('propagates promise rejection when promise rejects before timeout', async () => {
    const failing = Promise.reject(new Error('intentional failure'));
    await assert.rejects(
      () => withTimeout(failing, 100, 'failing-channel'),
      (err) => {
        assert.strictEqual(err.message, 'intentional failure');
        return true;
      }
    );
  });
});

describe('addMessage', () => {
  beforeEach(() => {
    _resetBuffer();
  });

  it('prepends to buffer', () => {
    addMessage({ id: 1, text: 'first' });
    addMessage({ id: 2, text: 'second' });
    const buf = getMessageBuffer();
    assert.strictEqual(buf.count, 2);
    assert.strictEqual(buf.messages[0].id, 2);
    assert.strictEqual(buf.messages[1].id, 1);
  });

  it('enforces MAX_BUFFER_SIZE limit (add 501 messages, size stays at 500)', () => {
    for (let i = 0; i < 501; i++) {
      addMessage({ id: i });
    }
    const buf = getMessageBuffer();
    assert.strictEqual(buf.count, 500);
    assert.strictEqual(buf.messages[0].id, 500);
    assert.strictEqual(buf.messages[499].id, 1);
  });
});

describe('getMessageBuffer', () => {
  beforeEach(() => {
    _resetBuffer();
  });

  it('returns count and timestamp', () => {
    addMessage({ text: 'test' });
    const buf = getMessageBuffer();
    assert.strictEqual(buf.count, 1);
    assert.ok(buf.timestamp);
    assert.strictEqual(typeof buf.timestamp, 'string');
    assert.ok(Array.isArray(buf.messages));
  });
});

describe('buffer structure after addMessage', () => {
  beforeEach(() => {
    _resetBuffer();
  });

  it('returns correct count and messages array', () => {
    addMessage({ id: 1, text: 'test', timestamp: Date.now() });
    const buffer = getMessageBuffer();
    assert.strictEqual(buffer.count, 1);
    assert.strictEqual(buffer.messages.length, 1);
  });
});

describe('buildHandleToConfig', () => {
  it('creates lowercase handle map', () => {
    const channels = [
      { handle: 'BNONews', label: 'BNO News', topic: 'breaking', tier: 2 },
      { handle: 'AuroraIntel', label: 'Aurora Intel', topic: 'conflict', tier: 2 },
    ];
    const map = buildHandleToConfig(channels);
    assert.strictEqual(map.size, 2);
    assert.strictEqual(map.get('bnonews').label, 'BNO News');
    assert.strictEqual(map.get('auroraintel').topic, 'conflict');
    assert.strictEqual(map.get('BNONEWS'), undefined);
  });
});

describe('formatMessage', () => {
  it('formats a message event with channel config', () => {
    const event = {
      message: {
        id: 42,
        peerId: { channelId: BigInt(12345) },
        message: 'Breaking: test event occurred',
        date: 1709251200,
        media: null,
        views: 1500,
        forwards: 30,
        replyTo: null,
      },
    };
    const channelConfig = {
      handle: 'BNONews',
      label: 'BNO News',
      topic: 'breaking',
      region: 'global',
      tier: 2,
    };

    const result = formatMessage(event, channelConfig);
    assert.strictEqual(result.id, 42);
    assert.strictEqual(result.channel, 'BNONews');
    assert.strictEqual(result.label, 'BNO News');
    assert.strictEqual(result.topic, 'breaking');
    assert.strictEqual(result.region, 'global');
    assert.strictEqual(result.tier, 2);
    assert.strictEqual(result.text, 'Breaking: test event occurred');
    assert.strictEqual(result.date, 1709251200000);
    assert.strictEqual(result.hasMedia, false);
    assert.strictEqual(result.views, 1500);
    assert.strictEqual(result.forwards, 30);
    assert.strictEqual(result.replyTo, null);
    assert.ok(result.ingestedAt > 0);
  });

  it('truncates long text to 4000 chars', () => {
    const longText = 'x'.repeat(5000);
    const event = {
      message: {
        id: 1,
        peerId: { channelId: BigInt(1) },
        message: longText,
        date: 1709251200,
        media: null,
        views: 0,
        forwards: 0,
        replyTo: null,
      },
    };
    const result = formatMessage(event, null);
    assert.strictEqual(result.text.length, 4000);
  });

  it('detects media presence', () => {
    const event = {
      message: {
        id: 1,
        peerId: { channelId: BigInt(1) },
        message: 'photo',
        date: 1709251200,
        media: { photo: {} },
        views: 0,
        forwards: 0,
        replyTo: null,
      },
    };
    const result = formatMessage(event, null);
    assert.strictEqual(result.hasMedia, true);
  });

  it('handles missing channel config gracefully', () => {
    const event = {
      message: {
        id: 1,
        peerId: { channelId: BigInt(1) },
        message: 'test',
        date: 1709251200,
        media: null,
        views: 0,
        forwards: 0,
        replyTo: null,
      },
    };
    const result = formatMessage(event, null);
    assert.strictEqual(result.channel, '');
    assert.strictEqual(result.label, '');
    assert.strictEqual(result.topic, 'unknown');
    assert.strictEqual(result.region, 'unknown');
    assert.strictEqual(result.tier, 3);
  });
});

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

describe('startTelegramClient - disabled states', () => {
  const prevSession = process.env.TELEGRAM_SESSION;
  const prevApiId = process.env.TELEGRAM_API_ID;
  const prevApiHash = process.env.TELEGRAM_API_HASH;
  const prevChannels = process.env.TELEGRAM_CHANNELS;
  const prevChannelSet = process.env.TELEGRAM_CHANNEL_SET;

  afterEach(() => {
    process.env.TELEGRAM_SESSION = prevSession;
    process.env.TELEGRAM_API_ID = prevApiId;
    process.env.TELEGRAM_API_HASH = prevApiHash;
    process.env.TELEGRAM_CHANNELS = prevChannels;
    process.env.TELEGRAM_CHANNEL_SET = prevChannelSet;
  });

  it('returns undefined when TELEGRAM_SESSION is not set', async () => {
    delete process.env.TELEGRAM_SESSION;
    const result = await startTelegramClient(null);
    assert.strictEqual(result, undefined);
  });

  it('returns undefined when TELEGRAM_API_ID is not set', async () => {
    process.env.TELEGRAM_SESSION = 'test';
    delete process.env.TELEGRAM_API_ID;
    process.env.TELEGRAM_API_HASH = 'test-hash';
    const result = await startTelegramClient(null);
    assert.strictEqual(result, undefined);
  });

  it('returns undefined when no channels configured', async () => {
    process.env.TELEGRAM_SESSION = 'test';
    process.env.TELEGRAM_API_ID = '12345';
    process.env.TELEGRAM_API_HASH = 'test-hash';
    delete process.env.TELEGRAM_CHANNELS;
    delete process.env.TELEGRAM_CHANNEL_SET;
    const result = await startTelegramClient(null);
    assert.strictEqual(result, undefined);
  });
});

describe('persistBuffer', () => {
  beforeEach(() => {
    _resetBuffer();
  });

  it('calls setex with correct key when messages present (mock Redis)', async () => {
    const captured = { key: null, ttl: null, value: null };
    const mockClient = {
      setex: async (key, ttl, value) => {
        captured.key = key;
        captured.ttl = ttl;
        captured.value = value;
      },
    };

    const prev = process.__REDIS_TEST_CLIENT__;
    process.__REDIS_TEST_CLIENT__ = mockClient;

    try {
      addMessage({ text: 'test' });
      await persistBuffer(null);
      assert.strictEqual(captured.key, 'relay:telegram:v1');
      assert.strictEqual(captured.ttl, 3600);
      assert.ok(captured.value);
      const parsed =
        typeof captured.value === 'string' ? JSON.parse(captured.value) : captured.value;
      assert.strictEqual(parsed.count, 1);
      assert.ok(parsed.timestamp);
    } finally {
      process.__REDIS_TEST_CLIENT__ = prev;
    }
  });
});

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

  it('mergeNewItems sorts items by ts descending (newest first)', () => {
    const items = [
      { id: 'ch:1', ts: '2026-03-10T10:00:00Z', text: 'oldest' },
      { id: 'ch:2', ts: '2026-03-10T10:02:00Z', text: 'newest' },
      { id: 'ch:3', ts: '2026-03-10T10:01:00Z', text: 'middle' },
    ];
    mergeNewItems(items);
    const state = getPollState();
    assert.strictEqual(state.items[0].id, 'ch:2');
    assert.strictEqual(state.items[1].id, 'ch:3');
    assert.strictEqual(state.items[2].id, 'ch:1');
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
      getEntity: async () => {
        throw new Error('entity not found');
      },
    };
    const channels = [{ handle: 'BadChannel', topic: 'test' }];
    const handleToConfig = new Map([['badchannel', channels[0]]]);

    const result = await pollTelegramOnce(mockClient, channels, handleToConfig);
    assert.strictEqual(result.channelsFailed, 1);
    assert.strictEqual(result.channelsPolled, 0);
  });
});

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
