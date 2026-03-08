'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fetchTrade = require('../trade.cjs');

const mockRedis = { get: async () => null, setex: async () => {} };
const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

test('fetchTrade returns worker format on success', async () => {
  const mockHttp = {
    fetchJson: async () => ({
      Dataset: [
        { ReportingEconomyCode: '840', Year: '2025', Value: '12.5' },
        { ReportingEconomyCode: '156', Year: '2025', Value: '15.2' },
      ],
    }),
  };

  const result = await fetchTrade({
    config: { WTO_API_KEY: 'test-key' },
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'trade');
  assert.ok(result.timestamp);
  assert.ok(Array.isArray(result.data));
  assert.ok(result.data.length > 0);
  assert.ok(result.data[0].notifyingCountry);
  assert.ok(result.data[0].title);
});

test('fetchTrade returns error when WTO_API_KEY not set', async () => {
  const result = await fetchTrade({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: { fetchJson: async () => ({}) },
  });

  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.source, 'trade');
  assert.ok(result.errors);
  assert.ok(result.errors.some((e) => e.includes('WTO') || e.includes('API')));
  assert.ok(Array.isArray(result.data));
});

test('fetchTrade handles fetch error gracefully', async () => {
  const mockHttp = {
    fetchJson: async () => {
      throw new Error('WTO HTTP 500');
    },
  };

  const result = await fetchTrade({
    config: { WTO_API_KEY: 'test-key' },
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.ok(['success', 'error'].includes(result.status));
  assert.strictEqual(result.source, 'trade');
  assert.ok(Array.isArray(result.data));
  if (result.status === 'error') assert.ok(result.errors && result.errors.length > 0);
});

test('fetchTrade returns empty data when upstream unavailable', async () => {
  const mockHttp = {
    fetchJson: async () => null,
  };

  const result = await fetchTrade({
    config: { WTO_API_KEY: 'test-key' },
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'trade');
  assert.ok(Array.isArray(result.data));
  assert.strictEqual(result.data.length, 0);
  assert.strictEqual(result.upstreamUnavailable, true);
});
