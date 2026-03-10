'use strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'test-anon-key';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { getChannel, CHANNEL_REGISTRY } = require('@worldmonitor/shared/channels/index.cjs');
const { handleExecute, createGrpcBroadcast } = require('../index.cjs');

describe('channel registry', () => {
  it('getChannel("markets") returns a function', () => {
    const fn = getChannel('markets');
    assert.strictEqual(typeof fn, 'function');
  });

  it('getChannel("unknown") returns null', () => {
    const fn = getChannel('unknown');
    assert.strictEqual(fn, null);
  });
});

describe('worker Execute routing', () => {
  it('calls runWorker with correct triggerRequest when Execute RPC data comes in', (t, done) => {
    const captured = {};
    const mockRunWorker = (triggerRequest, opts) => {
      captured.triggerRequest = triggerRequest;
      captured.opts = opts;
      return Promise.resolve({
        status: 'ok',
        service_key: triggerRequest.service_key,
        trigger_id: triggerRequest.trigger_id,
        duration_ms: 1,
      });
    };

    const mockCall = {
      request: {
        service_key: 'markets',
        redis_key: 'market:dashboard:v1',
        ttl_seconds: 300,
        settings_json: '{}',
        trigger_id: 't-123',
        fetch_type: 'custom',
      },
    };

    const mockCallback = (err, res) => {
      assert.ifError(err);
      assert.strictEqual(res.status, 'ok');
      assert.strictEqual(res.service_key, 'markets');
      assert.strictEqual(res.trigger_id, 't-123');
      assert.strictEqual(captured.triggerRequest.service_key, 'markets');
      assert.strictEqual(captured.triggerRequest.redis_key, 'market:dashboard:v1');
      assert.strictEqual(captured.triggerRequest.ttl_seconds, 300);
      assert.strictEqual(captured.triggerRequest.trigger_id, 't-123');
      assert.strictEqual(captured.triggerRequest.fetch_type, 'custom');
      assert.strictEqual(typeof captured.opts.channelFn, 'function');
      assert.ok('redis' in captured.opts);
      assert.strictEqual(typeof captured.opts.grpcBroadcast, 'function');
      assert.ok('log' in captured.opts);
      done();
    };

    handleExecute(mockCall, mockCallback, {
      runWorker: mockRunWorker,
      getChannel,
      redis: { setex: async () => {} },
      createGrpcBroadcast: (host, port) => async () => {},
    });
  });
});

describe('HealthCheck', () => {
  it('returns { status: "ok" }', (t, done) => {
    const { handleHealthCheck } = require('../index.cjs');
    const mockCall = { request: {} };
    const mockCallback = (err, res) => {
      assert.ifError(err);
      assert.strictEqual(res.status, 'ok');
      done();
    };
    handleHealthCheck(mockCall, mockCallback);
  });
});
