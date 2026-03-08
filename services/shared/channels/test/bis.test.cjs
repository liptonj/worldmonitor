'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fetchBis = require('../bis.cjs');

const mockRedis = { get: async () => null, setex: async () => {} };
const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

test('fetchBis returns worker-compatible format on success', async () => {
  const csv = `REF_AREA,TIME_PERIOD,OBS_VALUE
US,2026-01,5.25
US,2025-12,5.25
GB,2026-01,5.25
`;
  const mockHttp = {
    fetchText: async () => csv,
  };

  const result = await fetchBis({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'bis');
  assert.ok(result.timestamp);
  assert.ok(Array.isArray(result.data));
  assert.ok(result.data.length >= 1);
  const us = result.data.find((r) => r.countryCode === 'US');
  assert.ok(us);
  assert.strictEqual(us.rate, 5.25);
  assert.strictEqual(us.countryName, 'United States');
  assert.strictEqual(us.centralBank, 'Federal Reserve');
});

test('fetchBis handles fetch error gracefully', async () => {
  const mockHttp = {
    fetchText: async () => {
      throw new Error('BIS HTTP 500');
    },
  };

  const result = await fetchBis({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.source, 'bis');
  assert.ok(Array.isArray(result.data));
  assert.strictEqual(result.data.length, 0);
  assert.ok(result.errors);
  assert.ok(result.errors.length > 0);
});

test('fetchBis handles invalid CSV response', async () => {
  const mockHttp = {
    fetchText: async () => 'not,csv\n',
  };

  const result = await fetchBis({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.ok(Array.isArray(result.data));
  assert.strictEqual(result.data.length, 0);
});

test('fetchBis parses alternative column names', async () => {
  const csv = `Reference area,Time period,Observation value
XM,2026-01,4.00
`;
  const mockHttp = {
    fetchText: async () => csv,
  };

  const result = await fetchBis({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  const xm = result.data.find((r) => r.countryCode === 'XM');
  assert.ok(xm);
  assert.strictEqual(xm.rate, 4);
  assert.strictEqual(xm.countryName, 'Euro Area');
});
