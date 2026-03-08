'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fetchUcdpEvents = require('../ucdp-events.cjs');

const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

test('fetchUcdpEvents returns worker-compatible format on success', async () => {
  const page0Payload = {
    Result: [
      {
        id: 123,
        date_start: '2026-03-08',
        date_end: '2026-03-08',
        latitude: 35.0,
        longitude: 51.0,
        country: 'Iran',
        side_a: 'Gov',
        side_b: 'Rebels',
        best: 5,
        type_of_violence: 1,
      },
    ],
    TotalPages: 1,
  };
  const mockHttp = {
    fetchJson: async (url) => {
      if (url.includes('gedevents') && url.includes('page=0')) return page0Payload;
      if (url.includes('gedevents')) return { Result: [], TotalPages: 1 };
      return { Result: [], TotalPages: 1 };
    },
  };

  const result = await fetchUcdpEvents({
    config: {},
    redis: {},
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'ucdp-events');
  assert.ok(result.timestamp);
  assert.ok(result.data);
  assert.ok(Array.isArray(result.data.events));
  assert.ok(result.data.events.length >= 1);
  assert.strictEqual(result.data.events[0].country, 'Iran');
  assert.strictEqual(result.data.events[0].deaths_best, 5);
  assert.ok(result.data.version);
});

test('fetchUcdpEvents handles fetch error gracefully', async () => {
  const mockHttp = {
    fetchJson: async () => {
      throw new Error('UCDP API 500');
    },
  };

  const result = await fetchUcdpEvents({
    config: {},
    redis: {},
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.source, 'ucdp-events');
  assert.ok(result.data);
  assert.ok(Array.isArray(result.data.events));
  assert.strictEqual(result.data.events.length, 0);
  assert.ok(result.errors);
});

test('fetchUcdpEvents handles invalid Result (non-array)', async () => {
  const mockHttp = {
    fetchJson: async (url) => {
      if (url.includes('25.1') || url.includes('24.1')) {
        return { Result: [{ id: 1, date_start: '2026-01-01', country: 'X' }], TotalPages: 1 };
      }
      return { Result: 'invalid', TotalPages: 1 };
    },
  };

  const result = await fetchUcdpEvents({
    config: {},
    redis: {},
    log: mockLog,
    http: mockHttp,
  });

  assert.ok(['success', 'error'].includes(result.status));
  assert.strictEqual(result.source, 'ucdp-events');
  assert.ok(Array.isArray(result.data.events));
});
