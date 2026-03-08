'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fetchStablecoins = require('../stablecoins.cjs');

const mockRedis = { get: async () => null, setex: async () => {} };
const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

test('fetchStablecoins returns worker format on success', async () => {
  const mockHttp = {
    fetchJson: async () => [
      {
        id: 'tether',
        symbol: 'usdt',
        name: 'Tether',
        current_price: 1.0,
        market_cap: 100000000000,
        total_volume: 50000000000,
        price_change_percentage_24h: 0,
        price_change_percentage_7d_in_currency: 0,
        image: 'https://example.com/usdt.png',
      },
    ],
  };

  const result = await fetchStablecoins({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'stablecoins');
  assert.ok(result.timestamp);
  assert.ok(Array.isArray(result.data));
  assert.strictEqual(result.data.length, 1);
  assert.strictEqual(result.data[0].symbol, 'USDT');
  assert.strictEqual(result.data[0].pegStatus, 'ON PEG');
  assert.ok(result.summary);
  assert.strictEqual(result.summary.coinCount, 1);
});

test('fetchStablecoins handles invalid response (non-array)', async () => {
  const mockHttp = {
    fetchJson: async () => ({ error: 'invalid' }),
  };

  const result = await fetchStablecoins({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.source, 'stablecoins');
  assert.ok(result.errors);
  assert.ok(result.errors.some((e) => e.includes('array') || e.includes('expected')));
  assert.ok(Array.isArray(result.data));
  assert.strictEqual(result.data.length, 0);
});

test('fetchStablecoins handles fetch error gracefully', async () => {
  const mockHttp = {
    fetchJson: async () => {
      throw new Error('CoinGecko HTTP 500');
    },
  };

  const result = await fetchStablecoins({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.source, 'stablecoins');
  assert.ok(result.errors);
  assert.ok(result.errors.length > 0);
  assert.ok(Array.isArray(result.data));
});

test('fetchStablecoins sets pegStatus for depegged coin', async () => {
  const mockHttp = {
    fetchJson: async () => [
      {
        id: 'test-coin',
        symbol: 'test',
        name: 'Test Coin',
        current_price: 0.95,
        market_cap: 1000000,
        total_volume: 100000,
        price_change_percentage_24h: -5,
        price_change_percentage_7d_in_currency: -5,
        image: '',
      },
    ],
  };

  const result = await fetchStablecoins({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.data[0].pegStatus, 'DEPEGGED');
  assert.ok(result.data[0].deviation > 0);
});
