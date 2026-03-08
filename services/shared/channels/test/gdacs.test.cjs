'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fetchGdacs = require('../gdacs.cjs');

const mockRedis = { get: async () => null, setex: async () => {} };
const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

test('fetchGdacs returns worker-compatible format on success', async () => {
  const mockHttp = {
    fetchJson: async () => ({
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [37.5, 48.0] },
          properties: {
            eventtype: 'EQ',
            eventid: '123',
            name: 'Earthquake 5.2',
            alertlevel: 'Orange',
            country: 'Ukraine',
            severitydata: { severitytext: 'Moderate' },
            url: { report: 'https://gdacs.org/event' },
            fromdate: '2026-03-08',
          },
        },
      ],
    }),
  };

  const result = await fetchGdacs({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'gdacs');
  assert.ok(result.timestamp);
  assert.ok(result.data);
  assert.ok(Array.isArray(result.data));
  assert.strictEqual(result.data.length, 1);
  assert.strictEqual(result.data[0].id, 'gdacs-EQ-123');
  assert.strictEqual(result.data[0].eventType, 'EQ');
  assert.strictEqual(result.data[0].alertLevel, 'Orange');
  assert.deepStrictEqual(result.data[0].coordinates, [37.5, 48.0]);
});

test('fetchGdacs filters out Green alert level', async () => {
  const mockHttp = {
    fetchJson: async () => ({
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [0, 0] },
          properties: {
            eventtype: 'FL',
            eventid: '1',
            name: 'Flood',
            alertlevel: 'Green',
            country: 'Test',
          },
        },
      ],
    }),
  };

  const result = await fetchGdacs({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.data.length, 0);
});

test('fetchGdacs handles fetch error gracefully', async () => {
  const mockHttp = {
    fetchJson: async () => {
      throw new Error('GDACS HTTP 500');
    },
  };

  const result = await fetchGdacs({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.source, 'gdacs');
  assert.ok(result.errors);
  assert.ok(result.errors.length > 0);
});

test('fetchGdacs handles invalid response structure', async () => {
  const mockHttp = {
    fetchJson: async () => ({ notFeatures: 'invalid' }),
  };

  const result = await fetchGdacs({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'gdacs');
  assert.ok(Array.isArray(result.data));
  assert.strictEqual(result.data.length, 0);
});
