'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fetchNatural = require('../natural.cjs');

const mockRedis = { get: async () => null, setex: async () => {} };
const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

test('fetchNatural returns worker-compatible format on success', async () => {
  const mockHttp = {
    fetchText: async (url) => {
      if (url.includes('firms.modaps.eosdis.nasa.gov')) {
        return 'latitude,longitude,bright_ti4,frp,confidence,satellite,acq_date,acq_time,daynight\n48.1,37.5,320.5,5.2,n,VIIRS_SNPP,2026-03-08,1234,Day';
      }
      return '';
    },
  };

  const result = await fetchNatural({
    config: { NASA_FIRMS_API_KEY: 'test-key' },
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'natural');
  assert.ok(result.timestamp);
  assert.ok(result.data);
  assert.ok(Array.isArray(result.data.fireDetections));
  assert.ok(result.data.fireDetections.length > 0);
  assert.ok(result.data.fireDetections[0].location);
  assert.ok(result.data.fireDetections[0].brightness !== undefined);
  assert.ok(result.data.fireDetections[0].region);
});

test('fetchNatural returns error when NASA_FIRMS_API_KEY not set', async () => {
  const result = await fetchNatural({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: { fetchText: async () => '' },
  });

  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.source, 'natural');
  assert.ok(result.timestamp);
  assert.ok(Array.isArray(result.errors));
  assert.ok(result.errors.some((e) => e.includes('NASA_FIRMS') || e.includes('FIRMS')));
});

test('fetchNatural handles fetch error gracefully', async () => {
  const mockHttp = {
    fetchText: async () => {
      throw new Error('FIRMS HTTP 500');
    },
  };

  const result = await fetchNatural({
    config: { NASA_FIRMS_API_KEY: 'test-key' },
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.source, 'natural');
  assert.ok(result.errors);
  assert.ok(result.errors.length > 0);
});

test('fetchNatural handles invalid CSV response', async () => {
  const mockHttp = {
    fetchText: async () => 'not valid csv',
  };

  const result = await fetchNatural({
    config: { NASA_FIRMS_API_KEY: 'test-key' },
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'natural');
  assert.ok(Array.isArray(result.data.fireDetections));
  assert.strictEqual(result.data.fireDetections.length, 0);
});
