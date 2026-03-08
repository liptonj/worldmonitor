'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fetchFred = require('../fred.cjs');

const mockRedis = { get: async () => null, setex: async () => {} };
const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

test('fetchFred returns worker format on success', async () => {
  const mockHttp = {
    fetchJson: async (url) => {
      if (url.includes('observations')) {
        return {
          observations: [
            { date: '2026-01-01', value: '5.25' },
            { date: '2025-12-01', value: '5.00' },
          ],
        };
      }
      if (url.includes('series?')) {
        return { seriess: [{ title: 'Federal Funds Rate', units: 'Percent', frequency: 'Monthly' }] };
      }
      return null;
    },
  };

  const result = await fetchFred({
    config: { FRED_API_KEY: 'test-key' },
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'fred');
  assert.ok(result.timestamp);
  assert.ok(Array.isArray(result.data));
  assert.ok(result.data.length > 0);
  assert.ok(result.data[0].seriesId);
  assert.ok(Array.isArray(result.data[0].observations));
});

test('fetchFred returns error when FRED_API_KEY not set', async () => {
  const result = await fetchFred({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: { fetchJson: async () => ({}) },
  });

  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.source, 'fred');
  assert.ok(result.errors);
  assert.ok(result.errors.some((e) => e.includes('FRED') || e.includes('API')));
  assert.ok(Array.isArray(result.data));
  assert.strictEqual(result.data.length, 0);
});

test('fetchFred handles fetch error gracefully', async () => {
  const mockHttp = {
    fetchJson: async () => {
      throw new Error('FRED HTTP 500');
    },
  };

  const result = await fetchFred({
    config: { FRED_API_KEY: 'test-key' },
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.ok(['success', 'error'].includes(result.status));
  assert.strictEqual(result.source, 'fred');
  assert.ok(Array.isArray(result.data));
  if (result.status === 'error') assert.ok(result.errors && result.errors.length > 0);
});

test('fetchFred handles invalid response (non-array)', async () => {
  const mockHttp = {
    fetchJson: async () => {
      return { observations: null };
    },
  };

  const result = await fetchFred({
    config: { FRED_API_KEY: 'test-key' },
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.ok(['success', 'error'].includes(result.status));
  assert.strictEqual(result.source, 'fred');
  assert.ok(Array.isArray(result.data));
});
