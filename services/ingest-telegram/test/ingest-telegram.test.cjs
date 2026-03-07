'use strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'test-anon-key';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  addMessage,
  getMessageBuffer,
  persistBuffer,
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

describe('periodic persistence', () => {
  it('periodic persistence is set up', () => {
    _resetBuffer();
    addMessage({ id: 1, text: 'test', timestamp: Date.now() });
    const buffer = getMessageBuffer();
    assert.strictEqual(buffer.count, 1);
    assert.strictEqual(buffer.messages.length, 1);
    _resetBuffer();
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
