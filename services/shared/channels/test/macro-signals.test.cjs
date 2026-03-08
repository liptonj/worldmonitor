'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fetchMacroSignals = require('../macro-signals.cjs');

const mockRedis = { get: async () => null, setex: async () => {} };
const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const validYahooChart = {
  chart: {
    result: [{
      indicators: { quote: [{ close: Array(365).fill(100).map((_, i) => 100 + i * 0.1), volume: Array(365).fill(1e9) }] },
    }],
  },
};

const validFearGreed = {
  data: [{ value: '55', value_classification: 'Greed', timestamp: String(Math.floor(Date.now() / 1000)) }],
};

test('fetchMacroSignals returns worker format on success', async () => {
  const mockHttp = {
    fetchJson: async (url) => {
      if (url.includes('yahoo')) return validYahooChart;
      if (url.includes('alternative.me')) return validFearGreed;
      if (url.includes('mempool')) return { hashrates: [{ avgHashrate: 500 }, { avgHashrate: 520 }] };
      return null;
    },
  };

  const result = await fetchMacroSignals({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'macro-signals');
  assert.ok(result.timestamp);
  assert.ok(Array.isArray(result.data));
  assert.ok(result.data.length > 0);
  assert.ok(['BUY', 'CASH', 'UNKNOWN'].includes(result.verdict));
  assert.ok(result.signals);
});

test('fetchMacroSignals handles fetch error gracefully', async () => {
  const mockHttp = {
    fetchJson: async () => {
      throw new Error('Yahoo HTTP 500');
    },
  };

  const result = await fetchMacroSignals({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.ok(['success', 'error'].includes(result.status));
  assert.strictEqual(result.source, 'macro-signals');
  assert.ok(Array.isArray(result.data));
  if (result.status === 'error') assert.ok(result.errors && result.errors.length > 0);
});

test('fetchMacroSignals returns data array with signal items', async () => {
  const mockHttp = {
    fetchJson: async (url) => {
      if (url.includes('yahoo')) return validYahooChart;
      if (url.includes('alternative.me')) return validFearGreed;
      if (url.includes('mempool')) return { hashrates: [] };
      return null;
    },
  };

  const result = await fetchMacroSignals({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.ok(Array.isArray(result.data));
  assert.ok(result.data.some((d) => d.id && d.status));
});

test('fetchMacroSignals handles partial upstream failure', async () => {
  let yahooCalls = 0;
  const mockHttp = {
    fetchJson: async (url) => {
      if (url.includes('yahoo')) {
        yahooCalls++;
        if (yahooCalls === 1) throw new Error('fail');
        return validYahooChart;
      }
      if (url.includes('alternative.me')) return validFearGreed;
      if (url.includes('mempool')) return null;
      return null;
    },
  };

  const result = await fetchMacroSignals({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.ok(['success', 'error'].includes(result.status));
  assert.strictEqual(result.source, 'macro-signals');
  assert.ok(Array.isArray(result.data));
});
