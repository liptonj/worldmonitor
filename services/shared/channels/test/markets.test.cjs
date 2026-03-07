'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fetchMarkets = require('../markets.cjs');

test('fetchMarkets returns structured data', async () => {
  const mockConfig = {
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_ANON_KEY: 'test-anon-key',
  };
  const mockRedis = { get: async () => null, setex: async () => {} };
  const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  const mockHttp = {
    fetchJson: async (url, opts = {}) => {
      if (url.includes('get_market_symbols') || (url.includes('/rpc/') && url.includes('market'))) {
        return {
          stock: [],
          commodity: [],
          sector: [],
          crypto: [{ symbol: 'bitcoin', name: 'Bitcoin', display: 'BTC' }],
        };
      }
      if (url.includes('coingecko')) {
        return [
          {
            id: 'bitcoin',
            current_price: 50000,
            price_change_percentage_24h: 1.5,
            sparkline_in_7d: { price: [49000, 49500, 50000] },
          },
        ];
      }
      return [];
    },
  };

  const result = await fetchMarkets({
    config: mockConfig,
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.ok(Array.isArray(result.data));
  assert.ok(result.timestamp);
  assert.strictEqual(result.source, 'markets');
});
