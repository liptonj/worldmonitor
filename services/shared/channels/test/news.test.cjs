'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fetchNewsFull = require('../news-full.cjs');
const fetchNewsTech = require('../news-tech.cjs');
const fetchNewsFinance = require('../news-finance.cjs');
const fetchNewsHappy = require('../news-happy.cjs');

const mockConfig = {};
const mockRedis = { get: async () => null, setex: async () => {} };
const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const mockRssXml = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <item>
      <title>Test Article</title>
      <link>https://example.com/article</link>
      <pubDate>Mon, 07 Mar 2026 12:00:00 GMT</pubDate>
      <description>Test description</description>
    </item>
  </channel>
</rss>`;

// Single-feed mock: returns mock XML for first URL only, fails rest — yields exactly 1 article
function createSingleFeedMock(xml = mockRssXml) {
  let first = true;
  return {
    fetchText: async () => {
      if (first) {
        first = false;
        return xml;
      }
      throw new Error('Network error');
    },
  };
}

test('fetchNewsFull returns spec format with status and data', async () => {
  const result = await fetchNewsFull({
    config: mockConfig,
    redis: mockRedis,
    log: mockLog,
    http: createSingleFeedMock(),
  });

  assert.strictEqual(result.status, 'success');
  assert.ok(Array.isArray(result.data));
  assert.strictEqual(result.data.length, 1);
  assert.strictEqual(result.data[0].title, 'Test Article');
  assert.strictEqual(result.data[0].link, 'https://example.com/article');
  assert.ok(result.timestamp);
  assert.strictEqual(result.source, 'news:full');
});

test('fetchNewsTech returns spec format', async () => {
  const result = await fetchNewsTech({
    config: mockConfig,
    redis: mockRedis,
    log: mockLog,
    http: createSingleFeedMock(),
  });

  assert.strictEqual(result.status, 'success');
  assert.ok(Array.isArray(result.data));
  assert.strictEqual(result.data.length, 1);
  assert.strictEqual(result.data[0].title, 'Test Article');
  assert.strictEqual(result.source, 'news:tech');
});

test('fetchNewsFinance returns spec format', async () => {
  const result = await fetchNewsFinance({
    config: mockConfig,
    redis: mockRedis,
    log: mockLog,
    http: createSingleFeedMock(),
  });

  assert.strictEqual(result.status, 'success');
  assert.ok(Array.isArray(result.data));
  assert.strictEqual(result.data.length, 1);
  assert.strictEqual(result.data[0].title, 'Test Article');
  assert.strictEqual(result.source, 'news:finance');
});

test('fetchNewsHappy returns spec format', async () => {
  const result = await fetchNewsHappy({
    config: mockConfig,
    redis: mockRedis,
    log: mockLog,
    http: createSingleFeedMock(),
  });

  assert.strictEqual(result.status, 'success');
  assert.ok(Array.isArray(result.data));
  assert.strictEqual(result.data.length, 1);
  assert.strictEqual(result.data[0].title, 'Test Article');
  assert.strictEqual(result.source, 'news:happy');
});

test('fetchNewsFull handles malformed RSS gracefully', async () => {
  const badHttp = {
    fetchText: async () => 'not valid xml <<<',
  };

  const result = await fetchNewsFull({
    config: mockConfig,
    redis: mockRedis,
    log: mockLog,
    http: badHttp,
  });

  assert.ok(['success', 'error'].includes(result.status));
  assert.ok(Array.isArray(result.data));
  assert.ok(result.timestamp);
  assert.strictEqual(result.source, 'news:full');
});

test('fetchNewsFull handles feed fetch error gracefully', async () => {
  const errorHttp = {
    fetchText: async () => {
      throw new Error('Network error');
    },
  };

  const result = await fetchNewsFull({
    config: mockConfig,
    redis: mockRedis,
    log: mockLog,
    http: errorHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.ok(Array.isArray(result.data));
  assert.strictEqual(result.data.length, 0);
  assert.ok(Array.isArray(result.errors));
  assert.ok(result.errors.length > 0);
});

test('classifyNewsTitle sets isAlert for high-threat keywords', async () => {
  const warXml = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <item>
      <title>War breaks out in region</title>
      <link>https://example.com/war</link>
      <pubDate>Mon, 07 Mar 2026 12:00:00 GMT</pubDate>
      <description>Conflict</description>
    </item>
  </channel>
</rss>`;

  const result = await fetchNewsFull({
    config: mockConfig,
    redis: mockRedis,
    log: mockLog,
    http: createSingleFeedMock(warXml),
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.data.length, 1);
  assert.strictEqual(result.data[0].isAlert, true);
  assert.strictEqual(result.data[0].threat.level, 'high');
  assert.strictEqual(result.data[0].threat.category, 'conflict');
});
