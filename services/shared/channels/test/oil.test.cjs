'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fetchOil = require('../oil.cjs');

const mockRedis = { get: async () => null, setex: async () => {} };
const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

test('fetchOil returns worker format on success', async () => {
  const mockHttp = {
    fetchJson: async () => ({
      response: {
        data: [
          { period: '2026-01-06', value: 72.5 },
          { period: '2025-12-30', value: 71.0 },
        ],
      },
    }),
  };

  const result = await fetchOil({
    config: { EIA_API_KEY: 'test-key' },
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'oil');
  assert.ok(result.timestamp);
  assert.ok(Array.isArray(result.data));
  assert.ok(result.data.length > 0);
  assert.ok(typeof result.data[0].price === 'number');
  assert.ok(typeof result.data[0].change === 'number');
});

test('fetchOil returns error when EIA_API_KEY not set', async () => {
  const result = await fetchOil({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: { fetchJson: async () => ({}) },
  });

  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.source, 'oil');
  assert.ok(result.errors);
  assert.ok(result.errors.some((e) => e.includes('EIA') || e.includes('API')));
  assert.ok(Array.isArray(result.data));
});

test('fetchOil handles fetch error gracefully', async () => {
  const mockHttp = {
    fetchJson: async () => {
      throw new Error('EIA HTTP 500');
    },
  };

  const result = await fetchOil({
    config: { EIA_API_KEY: 'test-key' },
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.source, 'oil');
  assert.ok(result.errors);
  assert.ok(result.errors.length > 0);
  assert.ok(Array.isArray(result.data));
});

test('fetchOil handles invalid response (empty data)', async () => {
  const mockHttp = {
    fetchJson: async () => ({
      response: { data: [] },
    }),
  };

  const result = await fetchOil({
    config: { EIA_API_KEY: 'test-key' },
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'oil');
  assert.ok(Array.isArray(result.data));
  assert.strictEqual(result.data.length, 0);
});
