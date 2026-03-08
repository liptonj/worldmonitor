'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fetchWeather = require('../weather.cjs');

const mockRedis = { get: async () => null, setex: async () => {} };
const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

test('fetchWeather returns worker-compatible format on success', async () => {
  const mockHttp = {
    fetchJson: async () => ({
      features: [
        {
          id: 'https://api.weather.gov/alerts/urn:oid:123',
          properties: {
            event: 'Tornado Warning',
            severity: 'Extreme',
            headline: 'Tornado Warning for County',
            description: 'A tornado has been spotted.',
            areaDesc: 'County, State',
            onset: '2026-03-08T12:00:00Z',
            expires: '2026-03-08T13:00:00Z',
          },
          geometry: {
            type: 'Polygon',
            coordinates: [[[-120, 37], [-119, 37], [-119, 38], [-120, 38], [-120, 37]]],
          },
        },
      ],
    }),
  };

  const result = await fetchWeather({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'weather');
  assert.ok(result.timestamp);
  assert.ok(result.data);
  assert.ok(Array.isArray(result.data));
  assert.strictEqual(result.data.length, 1);
  assert.strictEqual(result.data[0].event, 'Tornado Warning');
  assert.strictEqual(result.data[0].severity, 'Extreme');
  assert.ok(result.data[0].coordinates);
  assert.ok(result.data[0].centroid);
});

test('fetchWeather filters out Unknown severity', async () => {
  const mockHttp = {
    fetchJson: async () => ({
      features: [
        {
          id: 'alert-1',
          properties: { event: 'Test', severity: 'Unknown', headline: '', areaDesc: '', onset: new Date().toISOString(), expires: new Date().toISOString() },
          geometry: null,
        },
      ],
    }),
  };

  const result = await fetchWeather({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.data.length, 0);
});

test('fetchWeather handles fetch error gracefully', async () => {
  const mockHttp = {
    fetchJson: async () => {
      throw new Error('NWS HTTP 500');
    },
  };

  const result = await fetchWeather({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.source, 'weather');
  assert.ok(result.errors);
  assert.ok(result.errors.length > 0);
});

test('fetchWeather handles invalid response structure', async () => {
  const mockHttp = {
    fetchJson: async () => ({ notFeatures: 'invalid' }),
  };

  const result = await fetchWeather({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'weather');
  assert.ok(Array.isArray(result.data));
  assert.strictEqual(result.data.length, 0);
});
