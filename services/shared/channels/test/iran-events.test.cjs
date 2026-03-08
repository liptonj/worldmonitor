'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fetchIranEvents = require('../iran-events.cjs');

const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

test('fetchIranEvents returns worker-compatible format on success', async () => {
  const mockRedis = {
    get: async () => ({
      events: [
        { id: '1', title: 'Event A', occurredAt: Date.now() },
        { id: '2', title: 'Event B', occurredAt: Date.now() },
      ],
      scrapedAt: '2026-03-08T12:00:00Z',
    }),
  };

  const result = await fetchIranEvents({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: {},
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'iran-events');
  assert.ok(result.timestamp);
  assert.ok(result.data);
  assert.ok(Array.isArray(result.data.events));
  assert.strictEqual(result.data.events.length, 2);
  assert.strictEqual(result.data.events[0].title, 'Event A');
  assert.strictEqual(result.data.scrapedAt, '2026-03-08T12:00:00Z');
});

test('fetchIranEvents returns empty events when Redis returns null', async () => {
  const mockRedis = { get: async () => null };

  const result = await fetchIranEvents({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: {},
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'iran-events');
  assert.ok(Array.isArray(result.data.events));
  assert.strictEqual(result.data.events.length, 0);
  assert.strictEqual(result.data.scrapedAt, '0');
});

test('fetchIranEvents returns error when Redis not configured', async () => {
  const result = await fetchIranEvents({
    config: {},
    redis: null,
    log: mockLog,
    http: {},
  });

  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.source, 'iran-events');
  assert.ok(result.errors);
  assert.ok(result.errors.some((e) => e.includes('Redis')));
});

test('fetchIranEvents handles invalid events structure', async () => {
  const mockRedis = {
    get: async () => ({ events: 'not-an-array', scrapedAt: '2026-03-08' }),
  };

  const result = await fetchIranEvents({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: {},
  });

  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.source, 'iran-events');
  assert.ok(result.data.events);
  assert.strictEqual(result.data.events.length, 0);
  assert.ok(result.errors);
  assert.ok(result.errors.some((e) => e.includes('array')));
});
