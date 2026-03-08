'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fetchOref = require('../oref.cjs');

test('fetchOref returns alert data', async () => {
  const mockConfig = {
    OREF_PROXY_AUTH: 'user:pass@proxy:port',
  };
  const mockRedis = { get: async () => null, setex: async () => {} };
  const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  const mockHttp = {
    fetchJson: async (url) => {
      if (url.includes('alerts.json')) {
        return { id: '123', data: 'Test alert', time: Date.now() };
      }
      return [];
    },
  };

  const result = await fetchOref({
    config: mockConfig,
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.ok(result.data);
  assert.strictEqual(result.source, 'oref');
});

test('fetchOref returns error when OREF_PROXY_AUTH not configured', async () => {
  const mockConfig = {};
  const mockRedis = { get: async () => null, setex: async () => {} };
  const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  const mockHttp = { fetchJson: async () => ({}) };

  const result = await fetchOref({
    config: mockConfig,
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.source, 'oref');
  assert.ok(result.error?.includes('OREF_PROXY_AUTH'));
});

test('fetchOref handles fetch error gracefully', async () => {
  const mockConfig = { OREF_PROXY_AUTH: 'user:pass@proxy:port' };
  const mockRedis = { get: async () => null, setex: async () => {} };
  const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  const mockHttp = {
    fetchJson: async () => {
      throw new Error('Connection refused');
    },
  };

  const result = await fetchOref({
    config: mockConfig,
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.source, 'oref');
  assert.strictEqual(result.error, 'Connection refused');
});
