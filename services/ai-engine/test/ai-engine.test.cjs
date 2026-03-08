'use strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'test-anon-key';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  GENERATOR_REGISTRY,
  handleExecute,
  handleHealthCheck,
} = require('../index.cjs');

describe('generator registry', () => {
  it('GENERATOR_REGISTRY["ai:intel-digest"] exists and is a function', () => {
    const fn = GENERATOR_REGISTRY['ai:intel-digest'];
    assert.ok(fn);
    assert.strictEqual(typeof fn, 'function');
  });
});

describe('Execute routing', () => {
  it('ai:intel-digest routes to intel-digest generator', (t, done) => {
    const prevRedis = process.__REDIS_TEST_CLIENT__;
    process.__REDIS_TEST_CLIENT__ = {
      setex: async () => {},
      get: async () => null,
    };

    const mockCall = {
      request: {
        service_key: 'ai:intel-digest',
        redis_key: 'relay:ai:intel-digest:v1',
        ttl_seconds: 600,
        settings_json: '{}',
        trigger_id: 't-ai-1',
        fetch_type: 'custom',
      },
    };

    const mockCallback = (err, res) => {
      process.__REDIS_TEST_CLIENT__ = prevRedis;
      assert.ifError(err);
      assert.strictEqual(res.service_key, 'ai:intel-digest');
      assert.ok(['ok', 'error'].includes(res.status));
      done();
    };

    handleExecute(mockCall, mockCallback);
  });
});

describe('HealthCheck', () => {
  it('returns { status: "ok" }', (t, done) => {
    const mockCall = { request: {} };
    const mockCallback = (err, res) => {
      assert.ifError(err);
      assert.strictEqual(res.status, 'ok');
      done();
    };
    handleHealthCheck(mockCall, mockCallback);
  });
});

describe('Unknown service_key', () => {
  it('returns error status (no crash)', (t, done) => {
    const mockCall = {
      request: {
        service_key: 'ai:unknown-generator',
        redis_key: 'relay:test:v1',
        ttl_seconds: 600,
        settings_json: '{}',
        trigger_id: 't-unknown',
        fetch_type: 'custom',
      },
    };

    const mockCallback = (err, res) => {
      assert.ifError(err);
      assert.strictEqual(res.status, 'error');
      assert.ok(res.error && res.error.includes('Unknown service_key'));
      done();
    };

    handleExecute(mockCall, mockCallback);
  });
});
