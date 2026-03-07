'use strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'test-anon-key';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { runWorker } = require('../worker-runner.cjs');
const redis = require('../redis.cjs');
const { createLogger } = require('../logger.cjs');

const log = createLogger('worker-runner-test');

describe('runWorker', () => {
  const mockRedis = {
    _store: new Map(),
    async get() { return null; },
    async setex(key, ttl, value) {
      this._store.set(key, value);
    },
  };

  beforeEach(() => {
    mockRedis._store.clear();
  });

  it('success path with custom channelFn', async () => {
    const broadcasted = [];
    const channelFn = async () => ({ items: [1, 2, 3] });

    const result = await runWorker(
      {
        service_key: 'svc1',
        redis_key: 'rk1',
        ttl_seconds: 60,
        trigger_id: 't1',
        fetch_type: 'custom',
      },
      {
        channelFn,
        redis: mockRedis,
        grpcBroadcast: (ch, payload, tid) => broadcasted.push({ ch, payload, tid }),
        log,
      }
    );

    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.service_key, 'svc1');
    assert.strictEqual(result.trigger_id, 't1');
    assert.ok(result.duration_ms >= 0);
    assert.deepStrictEqual(mockRedis._store.get('rk1'), { items: [1, 2, 3] });
    assert.strictEqual(broadcasted.length, 1);
    assert.strictEqual(broadcasted[0].ch, 'svc1');
    assert.deepStrictEqual(broadcasted[0].payload, { items: [1, 2, 3] });
  });

  it('error path when channelFn throws', async () => {
    const channelFn = async () => {
      throw new Error('fetch failed');
    };

    const result = await runWorker(
      {
        service_key: 'svc2',
        redis_key: 'rk2',
        ttl_seconds: 60,
        trigger_id: 't2',
        fetch_type: 'custom',
      },
      { channelFn, redis: mockRedis, grpcBroadcast: () => {}, log }
    );

    assert.strictEqual(result.status, 'error');
    assert.strictEqual(result.error, 'fetch failed');
    assert.strictEqual(result.service_key, 'svc2');
    assert.strictEqual(mockRedis._store.size, 0);
  });

  it('simple_http path uses _simple-fetcher', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      return { status: 200, ok: true, json: () => ({ data: 'ok' }) };
    };

    const result = await runWorker(
      {
        service_key: 'svc3',
        redis_key: 'rk3',
        ttl_seconds: 60,
        trigger_id: 't3',
        fetch_type: 'simple_http',
        settings_json: JSON.stringify({ url: 'http://example.com' }),
      },
      { redis: mockRedis, grpcBroadcast: () => {}, log }
    );

    globalThis.fetch = origFetch;

    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.service_key, 'svc3');
    const stored = mockRedis._store.get('rk3');
    assert.ok(Array.isArray(stored));
    assert.deepStrictEqual(stored[0], { data: 'ok' });
  });
});
