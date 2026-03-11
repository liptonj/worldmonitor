'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { getOpenSkyToken, _resetForTest } = require('../../opensky-auth.cjs');

const mockRedis = { get: async () => null, setex: async () => {} };
const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const CREDENTIALS = { OPENSKY_CLIENT_ID: 'test', OPENSKY_CLIENT_SECRET: 'test' };
const mockOAuthFetch = async () => ({
  ok: true,
  json: async () => ({ access_token: 'test-token', expires_in: 1800 }),
});

async function cacheTestToken() {
  _resetForTest();
  await getOpenSkyToken(CREDENTIALS, mockOAuthFetch);
}

test('fetchStrategicPosture returns success with military flights', async () => {
  await cacheTestToken();
  const fetchStrategicPosture = require('../strategic-posture.cjs');
  const mockHttp = {
    fetchJson: async () => ({
      states: [
        ['AE1234', 'RCH123', null, null, null, 10, 50, 35000, false, 450, 90],
        ['AD5678', 'EVAC1', null, null, null, 12, 52, 30000, false, 400, 85],
      ],
    }),
  };

  const result = await fetchStrategicPosture({
    config: CREDENTIALS,
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'strategic-posture');
  assert.ok(result.timestamp);
  assert.ok(Array.isArray(result.data.theaters));
  assert.ok(result.data.theaters.length > 0);
});

test('fetchStrategicPosture returns error when all region fetches fail', async () => {
  await cacheTestToken();
  const fetchStrategicPosture = require('../strategic-posture.cjs');
  const mockHttp = {
    fetchJson: async () => {
      throw new Error('Network error');
    },
  };

  const result = await fetchStrategicPosture({
    config: CREDENTIALS,
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.ok(result.errors.includes('All OpenSky region fetches failed'));
});

test('fetchStrategicPosture returns error when no credentials configured', async () => {
  _resetForTest();
  const fetchStrategicPosture = require('../strategic-posture.cjs');
  const mockHttp = {
    fetchJson: async () => {
      throw new Error('should not be called');
    },
  };

  const result = await fetchStrategicPosture({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.ok(result.errors[0].includes('OpenSky credentials not configured'));
});

test('fetchStrategicPosture does NOT use WS_RELAY_URL', async () => {
  await cacheTestToken();
  const fetchStrategicPosture = require('../strategic-posture.cjs');
  let capturedUrl = null;
  const mockHttp = {
    fetchJson: async (url) => {
      capturedUrl = url;
      return { states: [] };
    },
  };

  await fetchStrategicPosture({
    config: {
      ...CREDENTIALS,
      WS_RELAY_URL: 'https://should-not-be-used.example.com',
    },
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.ok(capturedUrl, 'fetchJson should have been called');
  assert.ok(capturedUrl.includes('opensky-network.org'), `URL should be direct OpenSky, got: ${capturedUrl}`);
  assert.ok(!capturedUrl.includes('should-not-be-used'), 'Should NOT use relay URL');
});

test('fetchStrategicPosture includes Bearer token in headers', async () => {
  await cacheTestToken();
  const fetchStrategicPosture = require('../strategic-posture.cjs');
  let capturedHeaders = null;
  const mockHttp = {
    fetchJson: async (url, opts) => {
      capturedHeaders = opts?.headers;
      return { states: [] };
    },
  };

  await fetchStrategicPosture({
    config: CREDENTIALS,
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.ok(capturedHeaders, 'Headers should be provided');
  assert.ok(capturedHeaders.Authorization, 'Authorization header must be set');
  assert.ok(capturedHeaders.Authorization.startsWith('Bearer '), 'Must use Bearer token');
});
