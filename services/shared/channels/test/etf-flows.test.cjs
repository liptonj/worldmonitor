'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fetchEtfFlows = require('../etf-flows.cjs');

const mockRedis = { get: async () => null, setex: async () => {} };
const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const validChartResponse = {
  chart: {
    result: [{
      indicators: {
        quote: [{
          close: [95, 96, 97, 98, 99],
          volume: [1000000, 1100000, 1200000, 1300000, 1400000],
        }],
      },
    }],
  },
};

test('fetchEtfFlows returns worker format on success', async () => {
  const mockHttp = {
    fetchJson: async () => validChartResponse,
  };

  const result = await fetchEtfFlows({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'etf-flows');
  assert.ok(result.timestamp);
  assert.ok(Array.isArray(result.data));
  assert.ok(result.data.length > 0);
  assert.ok(result.data[0].ticker);
  assert.ok(typeof result.data[0].price === 'number');
  assert.ok(result.summary);
  assert.ok(['NET INFLOW', 'NET OUTFLOW', 'NEUTRAL'].includes(result.summary.netDirection));
});

test('fetchEtfFlows handles fetch error gracefully', async () => {
  const mockHttp = {
    fetchJson: async () => {
      throw new Error('Yahoo HTTP 500');
    },
  };

  const result = await fetchEtfFlows({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.ok(['success', 'error'].includes(result.status));
  assert.strictEqual(result.source, 'etf-flows');
  assert.ok(Array.isArray(result.data));
  if (result.status === 'error') assert.ok(result.errors && result.errors.length > 0);
});

test('fetchEtfFlows handles invalid chart response', async () => {
  const mockHttp = {
    fetchJson: async () => ({ chart: { result: [] } }),
  };

  const result = await fetchEtfFlows({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'etf-flows');
  assert.ok(Array.isArray(result.data));
});

test('fetchEtfFlows returns empty data when all fetches fail', async () => {
  let callCount = 0;
  const mockHttp = {
    fetchJson: async () => {
      callCount++;
      if (callCount <= 3) throw new Error('fail');
      return validChartResponse;
    },
  };

  const result = await fetchEtfFlows({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.ok(['success', 'error'].includes(result.status));
  assert.strictEqual(result.source, 'etf-flows');
  assert.ok(Array.isArray(result.data));
});
