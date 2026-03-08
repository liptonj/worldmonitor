'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fetchConflict = require('../conflict.cjs');

const mockRedis = { get: async () => null, setex: async () => {} };
const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

test('fetchConflict returns worker-compatible format on success', async () => {
  const mockHttp = {
    fetchJson: async (url) => {
      if (url.includes('acleddata.com')) {
        return {
          data: [
            {
              data_id: '123',
              event_id_cnty: 'UKR-001',
              event_type: 'Battles',
              sub_event_type: 'Armed conflict',
              country: 'Ukraine',
              admin1: 'Donetsk',
              latitude: 48.0,
              longitude: 37.5,
              event_date: '2026-03-08',
              fatalities: 0,
              actor1: 'Military',
              actor2: 'Rebels',
              source: 'ACLED',
            },
          ],
        };
      }
      return { data: [] };
    },
  };

  const result = await fetchConflict({
    config: { ACLED_ACCESS_TOKEN: 'test-token' },
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'conflict');
  assert.ok(result.timestamp);
  assert.ok(result.data);
  assert.ok(Array.isArray(result.data.events));
  assert.strictEqual(result.data.events.length, 1);
  assert.strictEqual(result.data.events[0].country, 'Ukraine');
  assert.strictEqual(result.data.events[0].eventType, 'battles');
  assert.ok(result.data.events[0].location);
  assert.strictEqual(result.data.events[0].location.latitude, 48);
  assert.strictEqual(result.data.events[0].location.longitude, 37.5);
});

test('fetchConflict returns error when ACLED_ACCESS_TOKEN not set', async () => {
  const result = await fetchConflict({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: { fetchJson: async () => ({ data: [] }) },
  });

  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.source, 'conflict');
  assert.ok(result.errors);
  assert.ok(result.errors.some((e) => e.includes('ACLED') || e.includes('token')));
});

test('fetchConflict handles fetch error gracefully', async () => {
  const mockHttp = {
    fetchJson: async () => {
      throw new Error('ACLED HTTP 500');
    },
  };

  const result = await fetchConflict({
    config: { ACLED_ACCESS_TOKEN: 'test-token' },
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.source, 'conflict');
  assert.ok(result.errors);
  assert.ok(result.errors.length > 0);
});
