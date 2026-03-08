'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fetchCyber = require('../cyber.cjs');

const mockRedis = { get: async () => null, setex: async () => {} };
const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

test('fetchCyber returns worker-compatible format on success', async () => {
  const mockHttp = {
    fetchJson: async (url) => {
      if (url.includes('feodotracker.abuse.ch')) {
        return [
          {
            ip_address: '1.2.3.4',
            first_seen_utc: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
            last_seen_utc: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
            country: 'RU',
          },
        ];
      }
      if (url.includes('urlhaus-api.abuse.ch')) {
        return {
          urls: [
            {
              id: '123',
              url: 'https://malicious.example.com/path',
              date_added: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
            },
          ],
        };
      }
      return [];
    },
  };

  const result = await fetchCyber({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'cyber');
  assert.ok(result.timestamp);
  assert.ok(result.data);
  assert.ok(Array.isArray(result.data.threats));
  assert.ok(result.data.threats.length >= 1);
  const feodo = result.data.threats.find((t) => t.source === 'CYBER_THREAT_SOURCE_FEODO');
  const urlhaus = result.data.threats.find((t) => t.source === 'CYBER_THREAT_SOURCE_URLHAUS');
  assert.ok(feodo, 'should have Feodo threat');
  assert.ok(urlhaus, 'should have URLhaus threat');
  assert.strictEqual(feodo.indicator, '1.2.3.4');
  assert.strictEqual(urlhaus.indicator, 'https://malicious.example.com/path');
});

test('fetchCyber handles fetch error gracefully', async () => {
  const mockHttp = {
    fetchJson: async () => {
      throw new Error('Feodo HTTP 500');
    },
  };

  const result = await fetchCyber({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.source, 'cyber');
  assert.ok(result.errors);
  assert.ok(result.errors.length > 0);
  assert.ok(Array.isArray(result.data.threats));
  assert.strictEqual(result.data.threats.length, 0);
});

test('fetchCyber handles invalid Feodo response structure', async () => {
  const mockHttp = {
    fetchJson: async (url) => {
      if (url.includes('feodotracker.abuse.ch')) {
        return { error: 'not an array' };
      }
      if (url.includes('urlhaus-api.abuse.ch')) {
        return { urls: [] };
      }
      return [];
    },
  };

  const result = await fetchCyber({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'cyber');
  assert.ok(Array.isArray(result.data.threats));
  assert.strictEqual(result.data.threats.length, 0);
});

test('fetchCyber handles invalid URLhaus response structure', async () => {
  const mockHttp = {
    fetchJson: async (url) => {
      if (url.includes('feodotracker.abuse.ch')) {
        return [];
      }
      if (url.includes('urlhaus-api.abuse.ch')) {
        return { urls: 'not-an-array' };
      }
      return [];
    },
  };

  const result = await fetchCyber({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'cyber');
  assert.ok(Array.isArray(result.data.threats));
});
