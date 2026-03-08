'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fetchOpensky = require('../opensky.cjs');

const mockRedis = { get: async () => null, setex: async () => {} };
const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

test('fetchOpensky returns worker-compatible format on success', async () => {
  const mockHttp = {
    fetchJson: async (url) => {
      if (url.includes('opensky-network.org') || url.includes('states')) {
        return {
          time: 1234567890,
          states: [
            ['a12345', 'UAL123', 'United States', 1234567890, 1234567890, -122.5, 37.5, 35000, false, 450, 90],
          ],
        };
      }
      return { states: [] };
    },
  };

  const result = await fetchOpensky({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'opensky');
  assert.ok(result.timestamp);
  assert.ok(result.data);
  assert.ok(Array.isArray(result.data.states));
  assert.ok(result.data.states.length >= 1);
  assert.strictEqual(result.data.states[0].icao24, 'a12345');
  assert.strictEqual(result.data.states[0].callsign, 'UAL123');
});

test('fetchOpensky handles fetch error gracefully', async () => {
  const mockHttp = {
    fetchJson: async () => {
      throw new Error('OpenSky HTTP 429');
    },
  };

  const result = await fetchOpensky({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.source, 'opensky');
  assert.ok(result.errors);
  assert.ok(result.errors.length > 0);
});

test('fetchOpensky uses custom bbox when configured', async () => {
  let capturedUrl = null;
  const mockHttp = {
    fetchJson: async (url) => {
      capturedUrl = url;
      return { time: 0, states: [] };
    },
  };

  await fetchOpensky({
    config: { OPENSKY_BBOX: '47,5,48,6' },
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.ok(capturedUrl.includes('lamin=47'));
  assert.ok(capturedUrl.includes('lomin=5'));
  assert.ok(capturedUrl.includes('lamax=48'));
  assert.ok(capturedUrl.includes('lomax=6'));
});
