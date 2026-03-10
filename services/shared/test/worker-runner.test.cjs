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

  it('stores previous snapshot before overwrite when current data exists', async () => {
    const prevData = { items: [0, 0] };
    const redisWithGet = {
      _store: mockRedis._store,
      async get(key) {
        return this._store.get(key) ?? null;
      },
      async setex(key, ttl, value) {
        this._store.set(key, value);
      },
    };
    redisWithGet._store.set('rk1', prevData);

    const channelFn = async () => ({ items: [1, 2, 3] });
    const result = await runWorker(
      {
        service_key: 'svc1',
        redis_key: 'rk1',
        ttl_seconds: 60,
        trigger_id: 't1',
        fetch_type: 'custom',
      },
      { channelFn, redis: redisWithGet, grpcBroadcast: () => {}, log }
    );

    assert.strictEqual(result.status, 'ok');
    assert.deepStrictEqual(redisWithGet._store.get('rk1'), { items: [1, 2, 3] });
    assert.deepStrictEqual(redisWithGet._store.get('rk1:previous'), prevData);
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

  it('returns error for invalid/malformed settings_json', async () => {
    const result = await runWorker(
      {
        service_key: 'svc1',
        redis_key: 'rk1',
        ttl_seconds: 60,
        trigger_id: 't1',
        fetch_type: 'simple_http',
        settings_json: 'not valid json {{{',
      },
      { redis: mockRedis, grpcBroadcast: () => {}, log }
    );

    assert.strictEqual(result.status, 'error');
    assert.ok(result.error.includes('Invalid settings_json'));
    assert.strictEqual(result.service_key, 'svc1');
    assert.strictEqual(mockRedis._store.size, 0);
  });

  it('returns error for missing required field service_key', async () => {
    const result = await runWorker(
      {
        redis_key: 'rk1',
        ttl_seconds: 60,
        trigger_id: 't1',
        fetch_type: 'simple_http',
        settings_json: JSON.stringify({ url: 'http://example.com' }),
      },
      { redis: mockRedis, grpcBroadcast: () => {}, log }
    );

    assert.strictEqual(result.status, 'error');
    assert.ok(result.error.includes('Missing required fields'));
    assert.strictEqual(mockRedis._store.size, 0);
  });

  it('returns error for unknown fetch_type', async () => {
    const result = await runWorker(
      {
        service_key: 'svc1',
        redis_key: 'rk1',
        ttl_seconds: 60,
        trigger_id: 't1',
        fetch_type: 'unknown_type',
      },
      { redis: mockRedis, grpcBroadcast: () => {}, log }
    );

    assert.strictEqual(result.status, 'error');
    assert.ok(result.error.includes('Unknown fetch_type'));
    assert.strictEqual(result.service_key, 'svc1');
    assert.strictEqual(mockRedis._store.size, 0);
  });

  it('simple_rss path uses _simple-fetcher and parses RSS', async () => {
    const rssBody = `<?xml version="1.0"?><rss><channel><item><title>T1</title><link>http://a.com</link><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate><description>Desc1</description></item></channel></rss>`;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      status: 200,
      ok: true,
      text: () => rssBody,
    });

    const result = await runWorker(
      {
        service_key: 'svc4',
        redis_key: 'rk4',
        ttl_seconds: 60,
        trigger_id: 't4',
        fetch_type: 'simple_rss',
        settings_json: JSON.stringify({ url: 'http://example.com/feed.xml' }),
      },
      { redis: mockRedis, grpcBroadcast: () => {}, log }
    );

    globalThis.fetch = origFetch;

    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.service_key, 'svc4');
    const stored = mockRedis._store.get('rk4');
    assert.ok(Array.isArray(stored));
    assert.strictEqual(stored.length, 1);
    assert.strictEqual(stored[0].title, 'T1');
    assert.strictEqual(stored[0].link, 'http://a.com');
    assert.strictEqual(stored[0].description, 'Desc1');
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
