'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fetchConfigFeatureFlags = require('../config-feature-flags.cjs');

const mockRedis = { get: async () => null, setex: async () => {} };
const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

test('fetchConfigFeatureFlags returns worker-compatible format on success', async () => {
  const mockConfig = {
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_ANON_KEY: 'test-anon-key',
  };
  const mockHttp = {
    fetchJson: async (url) => {
      if (!url.includes('get_public_feature_flags')) return [];
      return [
        { key: 'enable_new_ui', value: true },
        { key: 'max_items', value: 100 },
      ];
    },
  };

  const result = await fetchConfigFeatureFlags({
    config: mockConfig,
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'config:feature-flags');
  assert.ok(result.timestamp);
  assert.ok(result.data && typeof result.data === 'object');
  assert.strictEqual(result.data.enable_new_ui, true);
  assert.strictEqual(result.data.max_items, 100);
});

test('fetchConfigFeatureFlags handles fetch error gracefully', async () => {
  const mockConfig = {
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_ANON_KEY: 'test-anon-key',
  };
  const mockHttp = {
    fetchJson: async () => {
      throw new Error('Supabase connection refused');
    },
  };

  const result = await fetchConfigFeatureFlags({
    config: mockConfig,
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.source, 'config:feature-flags');
  assert.deepStrictEqual(result.data, {});
  assert.ok(result.errors);
  assert.ok(result.errors.length > 0);
});

test('fetchConfigFeatureFlags handles invalid response structure', async () => {
  const mockConfig = {
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_ANON_KEY: 'test-anon-key',
  };
  const mockHttp = {
    fetchJson: async () => 'not an array',
  };

  const result = await fetchConfigFeatureFlags({
    config: mockConfig,
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'config:feature-flags');
  assert.deepStrictEqual(result.data, {});
});

test('fetchConfigFeatureFlags rejects missing Supabase config', async () => {
  const mockHttp = {
    fetchJson: async () => [],
  };

  const result = await fetchConfigFeatureFlags({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.ok(result.errors);
  assert.ok(result.errors.some((e) => e.includes('not configured')));
});
