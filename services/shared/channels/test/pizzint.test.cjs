'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fetchPizzint = require('../pizzint.cjs');

const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

test('fetchPizzint returns worker-compatible format on success', async () => {
  const mockHttp = {
    fetchJson: async (url) => {
      if (url.includes('dashboard-data')) {
        return {
          success: true,
          data: [
            {
              place_id: 'p1',
              name: 'Location A',
              current_popularity: 50,
              percentage_of_usual: 80,
              is_spike: false,
              data_freshness: 'fresh',
              is_closed_now: false,
            },
          ],
        };
      }
      if (url.includes('gdelt')) {
        return { usa_russia: [{ v: 0.5 }, { v: 0.6 }], usa_china: [{ v: 0.3 }] };
      }
      return null;
    },
  };

  const result = await fetchPizzint({
    config: {},
    redis: {},
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'pizzint');
  assert.ok(result.timestamp);
  assert.ok(result.data);
  assert.ok(result.data.pizzint);
  assert.strictEqual(result.data.pizzint.locationsMonitored, 1);
  assert.ok(Array.isArray(result.data.tensionPairs));
});

test('fetchPizzint returns error when API returns invalid response', async () => {
  const mockHttp = {
    fetchJson: async () => ({ success: false }),
  };

  const result = await fetchPizzint({
    config: {},
    redis: {},
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.source, 'pizzint');
  assert.ok(result.errors);
  assert.ok(result.errors.some((e) => e.includes('invalid') || e.includes('empty')));
});

test('fetchPizzint handles fetch error gracefully', async () => {
  const mockHttp = {
    fetchJson: async () => {
      throw new Error('PIZZINT HTTP 500');
    },
  };

  const result = await fetchPizzint({
    config: {},
    redis: {},
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.source, 'pizzint');
  assert.ok(result.errors);
  assert.ok(result.errors.length > 0);
});

test('fetchPizzint handles invalid data (non-array)', async () => {
  const mockHttp = {
    fetchJson: async (url) => {
      if (url.includes('dashboard-data')) {
        return { success: true, data: { not: 'array' } };
      }
      return {};
    },
  };

  const result = await fetchPizzint({
    config: {},
    redis: {},
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.source, 'pizzint');
  assert.ok(result.errors);
  assert.ok(result.errors.some((e) => e.includes('array')));
});
