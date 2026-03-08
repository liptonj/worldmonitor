'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fetchGdelt = require('../gdelt.cjs');

const mockRedis = { get: async () => null, setex: async () => {} };
const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

test('fetchGdelt returns worker-compatible format on success', async () => {
  const mockHttp = {
    fetchJson: async (url) => {
      if (url.includes('gdeltproject.org')) {
        return {
          articles: [
            { title: 'Test Article', url: 'https://example.com/1', domain: 'example.com', seendate: '2026-03-08', socialimage: '', language: 'en', tone: 5 },
          ],
        };
      }
      return { articles: [] };
    },
  };

  const result = await fetchGdelt({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'gdelt');
  assert.ok(result.timestamp);
  assert.ok(result.data);
  assert.ok(Array.isArray(result.data.articles));
  assert.ok(result.data.articles.length >= 1);
  assert.strictEqual(result.data.articles[0].title, 'Test Article');
  assert.ok(result.data.query);
});

test('fetchGdelt handles fetch error gracefully', async () => {
  const mockHttp = {
    fetchJson: async () => {
      throw new Error('GDELT HTTP 500');
    },
  };

  const result = await fetchGdelt({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.source, 'gdelt');
  assert.ok(result.errors);
  assert.ok(result.errors.length > 0);
});

test('fetchGdelt uses custom query when configured', async () => {
  let capturedUrl = null;
  const mockHttp = {
    fetchJson: async (url) => {
      capturedUrl = url;
      return { articles: [] };
    },
  };

  await fetchGdelt({
    config: { GDELT_DEFAULT_QUERY: 'Ukraine conflict' },
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.ok(capturedUrl.includes('Ukraine%20conflict') || capturedUrl.includes('Ukraine+conflict'));
});
