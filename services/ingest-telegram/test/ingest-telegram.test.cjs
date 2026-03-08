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

describe('startTelegramClient cleanup', () => {
  const prevSession = process.env.TELEGRAM_SESSION;
  const prevChannels = process.env.TELEGRAM_CHANNELS;
  const prevRedis = process.__REDIS_TEST_CLIENT__;

  beforeEach(() => {
    process.env.TELEGRAM_SESSION = 'test-session';
    process.env.TELEGRAM_CHANNELS = 'test-channel';
    _resetBuffer();
  });

  afterEach(() => {
    process.env.TELEGRAM_SESSION = prevSession;
    process.env.TELEGRAM_CHANNELS = prevChannels;
    process.__REDIS_TEST_CLIENT__ = prevRedis;
  });

  it('returns cleanup function and clearing it stops the interval', async (t) => {
    const setexCalls = { count: 0 };
    const mockClient = {
      setex: async () => {
        setexCalls.count += 1;
      },
    };
    process.__REDIS_TEST_CLIENT__ = mockClient;

    t.mock.timers.enable(['setInterval']);

    const cleanup = await startTelegramClient(null);
    assert.strictEqual(typeof cleanup, 'function', 'startTelegramClient returns cleanup function');

    t.mock.timers.tick(65_000);
    await Promise.resolve();
    assert.strictEqual(setexCalls.count, 1, 'persistBuffer called once after 65s');

    cleanup();

    t.mock.timers.tick(65_000);
    await Promise.resolve();
    assert.strictEqual(setexCalls.count, 1, 'persistBuffer not called again after cleanup');

    t.mock.timers.reset();
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
