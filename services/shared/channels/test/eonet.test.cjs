'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fetchEonet = require('../eonet.cjs');

const mockRedis = { get: async () => null, setex: async () => {} };
const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

test('fetchEonet returns worker-compatible format on success', async () => {
  const mockHttp = {
    fetchJson: async () => ({
      events: [
        {
          id: 'EONET_123',
          title: 'Wildfire in California',
          categories: [{ id: 'wildfires', title: 'Wildfires' }],
          geometry: [
            { type: 'Point', coordinates: [-120, 37], date: new Date().toISOString() },
          ],
          sources: [{ id: 'nasa', url: 'https://example.com' }],
          closed: null,
        },
      ],
    }),
  };

  const result = await fetchEonet({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'eonet');
  assert.ok(result.timestamp);
  assert.ok(result.data);
  assert.ok(Array.isArray(result.data));
  assert.strictEqual(result.data.length, 1);
  assert.strictEqual(result.data[0].id, 'EONET_123');
  assert.strictEqual(result.data[0].category, 'wildfires');
  assert.strictEqual(result.data[0].lat, 37);
  assert.strictEqual(result.data[0].lon, -120);
});

test('fetchEonet excludes earthquakes', async () => {
  const mockHttp = {
    fetchJson: async () => ({
      events: [
        {
          id: 'EQ_1',
          title: 'Earthquake',
          categories: [{ id: 'earthquakes', title: 'Earthquakes' }],
          geometry: [{ type: 'Point', coordinates: [0, 0], date: new Date().toISOString() }],
          sources: [],
          closed: null,
        },
      ],
    }),
  };

  const result = await fetchEonet({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'eonet');
  assert.strictEqual(result.data.length, 0);
});

test('fetchEonet handles fetch error gracefully', async () => {
  const mockHttp = {
    fetchJson: async () => {
      throw new Error('EONET HTTP 503');
    },
  };

  const result = await fetchEonet({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.source, 'eonet');
  assert.ok(result.errors);
  assert.ok(result.errors.length > 0);
});

test('fetchEonet handles invalid response structure', async () => {
  const mockHttp = {
    fetchJson: async () => ({ notEvents: 'invalid' }),
  };

  const result = await fetchEonet({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'eonet');
  assert.ok(Array.isArray(result.data));
  assert.strictEqual(result.data.length, 0);
});
