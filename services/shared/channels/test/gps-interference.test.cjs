'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fetchGpsInterference = require('../gps-interference.cjs');

const mockRedis = { get: async () => null, setex: async () => {} };
const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

test('fetchGpsInterference returns worker-compatible format on success', async () => {
  const mockHttp = {
    fetchText: async (url) => {
      if (url.includes('manifest.csv')) return '2026-01-01,foo\n2026-03-08,bar';
      if (url.includes('2026-03-08-h3_4.csv')) {
        return 'hex,good,bad\n891f1d48b9fffff,5,10\n891f1d48b8fffff,90,5';
      }
      return '';
    },
  };

  const result = await fetchGpsInterference({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'gps-interference');
  assert.ok(result.timestamp);
  assert.ok(Array.isArray(result.data));
  assert.ok(result.data.length >= 1);
  assert.strictEqual(result.data[0].level, 'high');
  assert.strictEqual(result.data[0].h3, '891f1d48b9fffff');
});

test('fetchGpsInterference handles fetch error gracefully', async () => {
  const mockHttp = {
    fetchText: async () => {
      throw new Error('gpsjam.org HTTP 500');
    },
  };

  const result = await fetchGpsInterference({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.source, 'gps-interference');
  assert.ok(result.errors);
  assert.ok(result.errors.length > 0);
  assert.ok(Array.isArray(result.data));
  assert.strictEqual(result.data.length, 0);
});

test('fetchGpsInterference handles invalid manifest (no date)', async () => {
  const mockHttp = {
    fetchText: async (url) => {
      if (url.includes('manifest.csv')) return '';
      return '';
    },
  };

  const result = await fetchGpsInterference({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.source, 'gps-interference');
  assert.ok(result.errors);
  assert.ok(result.errors.some((e) => e.includes('manifest') || e.includes('date')));
});

test('fetchGpsInterference returns empty array when no hexes meet threshold', async () => {
  const mockHttp = {
    fetchText: async (url) => {
      if (url.includes('manifest.csv')) return '2026-03-08,bar';
      if (url.includes('2026-03-08-h3_4.csv')) {
        return 'hex,good,bad\n891f1d48b9fffff,100,1';
      }
      return '';
    },
  };

  const result = await fetchGpsInterference({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.ok(Array.isArray(result.data));
  assert.strictEqual(result.data.length, 0);
});
