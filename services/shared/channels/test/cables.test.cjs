'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fetchCables = require('../cables.cjs');

const mockRedis = { get: async () => null, setex: async () => {} };
const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

test('fetchCables returns worker-compatible format on success', async () => {
  const now = new Date();
  const recent = `${String(now.getUTCDate()).padStart(2, '0')}${String(now.getUTCHours()).padStart(2, '0')}${String(now.getUTCMinutes()).padStart(2, '0')}Z ${['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][now.getUTCMonth()]} ${now.getUTCFullYear()}`;
  const mockHttp = {
    fetchJson: async () => [
      {
        issueDate: recent,
        text: 'SUBMARINE CABLE MAREA FAULT. Cable repair operations in progress. Position 36-30N 075-45W.',
      },
    ],
  };

  const result = await fetchCables({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'cables');
  assert.ok(result.timestamp);
  assert.ok(Array.isArray(result.data));
  assert.ok(result.data.length >= 1);
  assert.strictEqual(result.data[0].id, 'marea');
  assert.ok(result.data[0].status);
  assert.ok(result.data[0].score !== undefined);
});

test('fetchCables handles fetch error gracefully', async () => {
  const mockHttp = {
    fetchJson: async () => {
      throw new Error('NGA HTTP 500');
    },
  };

  const result = await fetchCables({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.source, 'cables');
  assert.ok(result.errors);
  assert.ok(result.errors.length > 0);
  assert.ok(Array.isArray(result.data));
  assert.strictEqual(result.data.length, 0);
});

test('fetchCables handles empty/invalid NGA response', async () => {
  const mockHttp = {
    fetchJson: async () => ({}),
  };

  const result = await fetchCables({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.ok(Array.isArray(result.data));
  assert.strictEqual(result.data.length, 0);
});

test('fetchCables handles warnings array format', async () => {
  const now = new Date();
  const recent = `${String(now.getUTCDate()).padStart(2, '0')}${String(now.getUTCHours()).padStart(2, '0')}${String(now.getUTCMinutes()).padStart(2, '0')}Z ${['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][now.getUTCMonth()]} ${now.getUTCFullYear()}`;
  const mockHttp = {
    fetchJson: async () => ({
      warnings: [
        { issueDate: recent, text: 'CABLE LAYING operations near GRACE HOPPER. Navigate with caution.' },
      ],
    }),
  };

  const result = await fetchCables({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.ok(Array.isArray(result.data));
  assert.ok(result.data.some((c) => c.id === 'grace_hopper'));
});
