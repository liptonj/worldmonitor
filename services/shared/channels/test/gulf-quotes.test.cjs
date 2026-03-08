'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fetchGulfQuotes = require('../gulf-quotes.cjs');

const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

test('fetchGulfQuotes returns worker-compatible format on success', async () => {
  const mockHttp = {
    fetchJson: async () => ({
      chart: {
        result: [
          {
            meta: { regularMarketPrice: 100 },
            indicators: { quote: [{ close: [98, 99, 100], volume: [1, 2, 3] }] },
          },
        ],
      },
    }),
  };

  const result = await fetchGulfQuotes({
    config: {},
    redis: {},
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'gulf-quotes');
  assert.ok(result.timestamp);
  assert.ok(result.data);
  assert.ok(Array.isArray(result.data.quotes));
  assert.ok(typeof result.data.rateLimited === 'boolean');
});

test('fetchGulfQuotes handles fetch error gracefully', async () => {
  const mockHttp = {
    fetchJson: async () => {
      throw new Error('Yahoo Finance timeout');
    },
  };

  const result = await fetchGulfQuotes({
    config: {},
    redis: {},
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'gulf-quotes');
  assert.ok(result.data);
  assert.ok(Array.isArray(result.data.quotes));
  assert.strictEqual(result.data.quotes.length, 0);
  assert.strictEqual(result.data.rateLimited, true);
});

test('fetchGulfQuotes returns empty quotes when Yahoo returns null', async () => {
  const mockHttp = {
    fetchJson: async () => null,
  };

  const result = await fetchGulfQuotes({
    config: {},
    redis: {},
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'gulf-quotes');
  assert.ok(Array.isArray(result.data.quotes));
  assert.ok(result.data.rateLimited !== undefined);
});
