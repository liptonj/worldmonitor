'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fetchPredictions = require('../predictions.cjs');

const mockRedis = { get: async () => null, setex: async () => {} };
const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

test('fetchPredictions returns worker-compatible format on success', async () => {
  const mockHttp = {
    fetchJson: async () => [
      {
        slug: 'will-fed-cut-march',
        question: 'Will the Fed cut rates in March?',
        outcomePrices: '[0.65, 0.35]',
        volumeNum: 1000000,
        endDate: '2026-03-15T23:59:59Z',
      },
    ],
  };

  const result = await fetchPredictions({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'predictions');
  assert.ok(result.timestamp);
  assert.ok(Array.isArray(result.data));
  assert.strictEqual(result.data.length, 1);
  assert.strictEqual(result.data[0].id, 'will-fed-cut-march');
  assert.strictEqual(result.data[0].title, 'Will the Fed cut rates in March?');
  assert.strictEqual(result.data[0].yesPrice, 0.65);
  assert.strictEqual(result.data[0].volume, 1000000);
});

test('fetchPredictions handles fetch error gracefully', async () => {
  const mockHttp = {
    fetchJson: async () => {
      throw new Error('Polymarket HTTP 500');
    },
  };

  const result = await fetchPredictions({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.source, 'predictions');
  assert.ok(Array.isArray(result.data));
  assert.strictEqual(result.data.length, 0);
  assert.ok(result.errors);
  assert.ok(result.errors.length > 0);
});

test('fetchPredictions handles invalid response (non-array)', async () => {
  const mockHttp = {
    fetchJson: async () => ({ notMarkets: 'invalid' }),
  };

  const result = await fetchPredictions({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.ok(Array.isArray(result.data));
  assert.strictEqual(result.data.length, 0);
});

test('fetchPredictions parses outcomePrices JSON', async () => {
  const mockHttp = {
    fetchJson: async () => [
      {
        slug: 'test-market',
        question: 'Test?',
        outcomePrices: '[0.72]',
        volume: '50000',
        endDate: null,
      },
    ],
  };

  const result = await fetchPredictions({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.data[0].yesPrice, 0.72);
  assert.strictEqual(result.data[0].volume, 50000);
});
