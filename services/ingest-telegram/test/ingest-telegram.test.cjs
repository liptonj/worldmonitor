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
} = require('../index.cjs');

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
