'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fetchStrategicPosture = require('../strategic-posture.cjs');

const mockRedis = { get: async () => null, setex: async () => {} };
const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

test('fetchStrategicPosture returns worker-compatible format on success', async () => {
  const mockHttp = {
    fetchJson: async (url) => {
      if (url.includes('opensky') || url.includes('states')) {
        return {
          states: [
            ['AE1234', 'RCH123', null, null, null, 10, 50, 35000, false, 450, 90],
            ['AD5678', 'EVAC1', null, null, null, 12, 52, 30000, false, 400, 85],
          ],
        };
      }
      return { states: [] };
    },
  };

  const result = await fetchStrategicPosture({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'strategic-posture');
  assert.ok(result.timestamp);
  assert.ok(result.data);
  assert.ok(Array.isArray(result.data.theaters));
  assert.ok(result.data.theaters.length > 0);
  assert.ok(['critical', 'elevated', 'normal'].includes(result.data.theaters[0].postureLevel));
});

test('fetchStrategicPosture returns error when all region fetches fail', async () => {
  const mockHttp = {
    fetchJson: async () => {
      throw new Error('Network error');
    },
  };

  const result = await fetchStrategicPosture({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.source, 'strategic-posture');
  assert.ok(Array.isArray(result.data.theaters));
  assert.strictEqual(result.data.theaters.length, 0);
  assert.ok(Array.isArray(result.errors));
  assert.ok(result.errors.includes('All OpenSky region fetches failed'));
});

test('fetchStrategicPosture uses relay URL when WS_RELAY_URL configured', async () => {
  let capturedUrl = null;
  const mockHttp = {
    fetchJson: async (url) => {
      capturedUrl = url;
      return { states: [] };
    },
  };

  await fetchStrategicPosture({
    config: { WS_RELAY_URL: 'https://relay.example.com' },
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.ok(capturedUrl.includes('relay.example.com'));
  assert.ok(capturedUrl.includes('/opensky'));
});
