'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fetchSpending = require('../spending.cjs');

const mockRedis = { get: async () => null, setex: async () => {} };
const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

test('fetchSpending returns worker-compatible format on success', async () => {
  const mockHttp = {
    fetchJson: async () => ({
      results: [
        {
          'Award ID': 'CONT-123',
          'Recipient Name': 'Acme Corp',
          'Award Amount': 5000000,
          'Awarding Agency': 'Department of Defense',
          'Description': 'IT services contract',
          'Start Date': '2026-03-01',
          'Award Type': 'A',
        },
      ],
    }),
  };

  const result = await fetchSpending({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'spending');
  assert.ok(result.timestamp);
  assert.ok(Array.isArray(result.data));
  assert.strictEqual(result.data.length, 1);
  assert.strictEqual(result.data[0].id, 'CONT-123');
  assert.strictEqual(result.data[0].recipientName, 'Acme Corp');
  assert.strictEqual(result.data[0].amount, 5000000);
  assert.strictEqual(result.data[0].agency, 'Department of Defense');
  assert.strictEqual(result.data[0].awardType, 'contract');
});

test('fetchSpending handles fetch error gracefully', async () => {
  const mockHttp = {
    fetchJson: async () => {
      throw new Error('USASpending HTTP 500');
    },
  };

  const result = await fetchSpending({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.source, 'spending');
  assert.ok(Array.isArray(result.data));
  assert.strictEqual(result.data.length, 0);
  assert.ok(result.errors);
});

test('fetchSpending handles invalid response (no results)', async () => {
  const mockHttp = {
    fetchJson: async () => ({}),
  };

  const result = await fetchSpending({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.ok(Array.isArray(result.data));
  assert.strictEqual(result.data.length, 0);
});

test('fetchSpending maps award types correctly', async () => {
  const mockHttp = {
    fetchJson: async () => ({
      results: [
        { 'Award ID': '1', 'Recipient Name': 'X', 'Award Amount': 100, 'Awarding Agency': 'Y', 'Description': '', 'Start Date': '', 'Award Type': '02' },
      ],
    }),
  };

  const result = await fetchSpending({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.data[0].awardType, 'grant');
});
