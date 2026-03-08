'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fetchStrategicRisk = require('../strategic-risk.cjs');

const mockRedis = { get: async () => null, setex: async () => {} };
const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

test('fetchStrategicRisk returns worker-compatible format on success', async () => {
  const mockHttp = {
    fetchJson: async (url) => {
      if (url.includes('acleddata.com')) {
        return {
          data: [
            { country: 'Ukraine', event_type: 'Protests' },
            { country: 'Russia', event_type: 'Riots' },
          ],
        };
      }
      return { data: [] };
    },
  };

  const result = await fetchStrategicRisk({
    config: { ACLED_ACCESS_TOKEN: 'test-token' },
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'strategic-risk');
  assert.ok(result.timestamp);
  assert.ok(result.data);
  assert.ok(Array.isArray(result.data.ciiScores));
  assert.ok(Array.isArray(result.data.strategicRisks));
  assert.strictEqual(result.data.strategicRisks[0].region, 'global');
  assert.ok(['SEVERITY_LEVEL_HIGH', 'SEVERITY_LEVEL_MEDIUM', 'SEVERITY_LEVEL_LOW'].includes(result.data.strategicRisks[0].level));
});

test('fetchStrategicRisk returns error when ACLED_ACCESS_TOKEN not set', async () => {
  const result = await fetchStrategicRisk({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: { fetchJson: async () => ({ data: [] }) },
  });

  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.source, 'strategic-risk');
  assert.ok(result.timestamp);
  assert.ok(Array.isArray(result.errors));
  assert.ok(result.errors.some((e) => e.includes('ACLED') || e.includes('token')));
});

test('fetchStrategicRisk handles fetch error gracefully', async () => {
  const mockHttp = {
    fetchJson: async () => {
      throw new Error('ACLED HTTP 500');
    },
  };

  const result = await fetchStrategicRisk({
    config: { ACLED_ACCESS_TOKEN: 'test-token' },
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.source, 'strategic-risk');
  assert.ok(result.errors);
  assert.ok(result.errors.length > 0);
});

test('fetchStrategicRisk returns error when ACLED returns null or invalid response', async () => {
  const mockHttp = {
    fetchJson: async () => null,
  };

  const result = await fetchStrategicRisk({
    config: { ACLED_ACCESS_TOKEN: 'test-token' },
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.source, 'strategic-risk');
  assert.ok(Array.isArray(result.data.ciiScores));
  assert.strictEqual(result.data.ciiScores.length, 0);
  assert.ok(Array.isArray(result.errors));
  assert.ok(result.errors.includes('ACLED API returned invalid or empty response'));
});

test('fetchStrategicRisk returns error when ACLED returns data without array', async () => {
  const mockHttp = {
    fetchJson: async () => ({ data: null }),
  };

  const result = await fetchStrategicRisk({
    config: { ACLED_ACCESS_TOKEN: 'test-token' },
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.ok(result.errors.includes('ACLED API returned invalid or empty response'));
});
