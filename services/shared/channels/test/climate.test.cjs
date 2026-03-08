'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fetchClimate = require('../climate.cjs');

const mockRedis = { get: async () => null, setex: async () => {} };
const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

test('fetchClimate returns worker-compatible format on success', async () => {
  const mockHttp = {
    fetchJson: async () => ({
      data: {
        '2023': '1.15',
        '2022': '0.89',
        '2021': '0.84',
      },
    }),
  };

  const result = await fetchClimate({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'climate');
  assert.ok(result.timestamp);
  assert.ok(Array.isArray(result.data));
  assert.ok(result.data.length >= 1);
  const warm = result.data.find((a) => a.period === '2023');
  assert.ok(warm);
  assert.strictEqual(warm.tempDelta, 1.15);
  assert.strictEqual(warm.severity, 'ANOMALY_SEVERITY_EXTREME');
  assert.strictEqual(warm.type, 'ANOMALY_TYPE_WARM');
});

test('fetchClimate handles fetch error gracefully', async () => {
  const mockHttp = {
    fetchJson: async () => {
      throw new Error('NOAA HTTP 500');
    },
  };

  const result = await fetchClimate({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.source, 'climate');
  assert.ok(Array.isArray(result.data));
  assert.strictEqual(result.data.length, 0);
  assert.ok(result.errors);
});

test('fetchClimate handles invalid response (no data)', async () => {
  const mockHttp = {
    fetchJson: async () => ({}),
  };

  const result = await fetchClimate({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.ok(Array.isArray(result.data));
  assert.strictEqual(result.data.length, 0);
});

test('fetchClimate filters moderate anomalies', async () => {
  const mockHttp = {
    fetchJson: async () => ({
      data: {
        '2023': '0.6',
        '2022': '-0.55',
      },
    }),
  };

  const result = await fetchClimate({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.ok(result.data.length >= 1);
  const cold = result.data.find((a) => a.tempDelta < 0);
  assert.ok(cold);
  assert.strictEqual(cold.type, 'ANOMALY_TYPE_COLD');
});
