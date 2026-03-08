'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fetchServiceStatus = require('../service-status.cjs');

const mockRedis = { get: async () => null, setex: async () => {} };
const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

test('fetchServiceStatus returns worker-compatible format on success', async () => {
  const mockHttp = {
    fetchJson: async (url) => {
      if (url.includes('cloudflarestatus.com')) {
        return { status: { indicator: 'operational', description: 'All Systems Operational' } };
      }
      if (url.includes('githubstatus.com')) {
        return { status: { indicator: 'none', description: 'All systems operational' } };
      }
      return { status: { indicator: 'minor', description: 'Minor outage' } };
    },
  };

  const result = await fetchServiceStatus({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'service-status');
  assert.ok(result.timestamp);
  assert.ok(result.data);
  assert.ok(Array.isArray(result.data.statuses));
  assert.ok(result.data.statuses.length >= 2);
  const cloudflare = result.data.statuses.find((s) => s.id === 'cloudflare');
  assert.ok(cloudflare);
  assert.strictEqual(cloudflare.status, 'SERVICE_OPERATIONAL_STATUS_OPERATIONAL');
  assert.ok(cloudflare.checkedAt);
  assert.ok(typeof cloudflare.latencyMs === 'number');
});

test('fetchServiceStatus handles fetch error gracefully', async () => {
  const mockHttp = {
    fetchJson: async () => {
      throw new Error('Cloudflare HTTP 500');
    },
  };

  const result = await fetchServiceStatus({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'service-status');
  assert.ok(Array.isArray(result.data.statuses));
  assert.ok(result.data.statuses.length >= 1);
  const failed = result.data.statuses.find((s) => s.description === 'Request failed');
  assert.ok(failed, 'should have fallback entry for failed fetch');
  assert.strictEqual(failed.status, 'SERVICE_OPERATIONAL_STATUS_UNSPECIFIED');
});

test('fetchServiceStatus handles invalid response structure', async () => {
  const mockHttp = {
    fetchJson: async () => {
      return { notStatus: 'invalid' };
    },
  };

  const result = await fetchServiceStatus({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'service-status');
  assert.ok(Array.isArray(result.data.statuses));
  assert.ok(result.data.statuses.length >= 1);
  const first = result.data.statuses[0];
  assert.ok(first.id);
  assert.ok(first.name);
  assert.ok(first.url);
  assert.ok(first.status);
  assert.ok(first.checkedAt);
});
