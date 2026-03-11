'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { getOpenSkyToken, _resetForTest } = require('../../opensky-auth.cjs');

const mockRedis = { get: async () => null, setex: async () => {} };
const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

async function cacheTestToken() {
  _resetForTest();
  const mockOAuthFetch = async () => ({
    ok: true,
    json: async () => ({ access_token: 'test-token', expires_in: 1800 }),
  });
  await getOpenSkyToken(
    { OPENSKY_CLIENT_ID: 'test', OPENSKY_CLIENT_SECRET: 'test' },
    mockOAuthFetch,
  );
}

test('fetchOpensky returns worker-compatible format on success', async () => {
  await cacheTestToken();
  const fetchOpensky = require('../opensky.cjs');
  const mockHttp = {
    fetchJson: async () => ({
      time: 1234567890,
      states: [
        ['a12345', 'UAL123', 'United States', 1234567890, 1234567890, -122.5, 37.5, 35000, false, 450, 90],
      ],
    }),
  };

  const result = await fetchOpensky({
    config: { OPENSKY_CLIENT_ID: 'test', OPENSKY_CLIENT_SECRET: 'test' },
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'opensky');
  assert.ok(result.data.states.length >= 1);
  assert.strictEqual(result.data.states[0].icao24, 'a12345');
});

test('fetchOpensky handles fetch error gracefully', async () => {
  await cacheTestToken();
  const fetchOpensky = require('../opensky.cjs');
  const mockHttp = {
    fetchJson: async () => { throw new Error('OpenSky HTTP 429'); },
  };

  const result = await fetchOpensky({
    config: { OPENSKY_CLIENT_ID: 'test', OPENSKY_CLIENT_SECRET: 'test' },
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.ok(result.errors.length > 0);
});

test('fetchOpensky uses custom bbox when configured', async () => {
  await cacheTestToken();
  const fetchOpensky = require('../opensky.cjs');
  let capturedUrl = null;
  const mockHttp = {
    fetchJson: async (url) => {
      capturedUrl = url;
      return { time: 0, states: [] };
    },
  };

  await fetchOpensky({
    config: { OPENSKY_BBOX: '47,5,48,6', OPENSKY_CLIENT_ID: 'test', OPENSKY_CLIENT_SECRET: 'test' },
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.ok(capturedUrl.includes('lamin=47'));
});

test('fetchOpensky includes Bearer token when credentials available', async () => {
  await cacheTestToken();
  const fetchOpensky = require('../opensky.cjs');
  let capturedHeaders = null;
  const mockHttp = {
    fetchJson: async (url, opts) => {
      capturedHeaders = opts?.headers;
      return { time: 0, states: [] };
    },
  };

  await fetchOpensky({
    config: { OPENSKY_CLIENT_ID: 'test', OPENSKY_CLIENT_SECRET: 'test' },
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.ok(capturedHeaders.Authorization, 'Authorization header must be set');
  assert.ok(capturedHeaders.Authorization.startsWith('Bearer '));
});

test('fetchOpensky still works without credentials (unauthenticated fallback)', async () => {
  _resetForTest();
  const fetchOpensky = require('../opensky.cjs');
  const mockHttp = {
    fetchJson: async () => ({ time: 0, states: [] }),
  };

  const result = await fetchOpensky({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
});
