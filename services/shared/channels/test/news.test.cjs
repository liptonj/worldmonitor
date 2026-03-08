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

const mockHttp = {
  fetchText: async () => mockRssXml,
};

test('fetchNewsFull returns ListFeedDigestResponse format', async () => {
  const result = await fetchNewsFull({
    config: mockConfig,
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.ok(result.categories, 'has categories');
  assert.ok(result.feedStatuses, 'has feedStatuses');
  assert.ok(result.generatedAt, 'has generatedAt');
  assert.strictEqual(typeof result.categories, 'object');
  assert.strictEqual(typeof result.feedStatuses, 'object');

  const allItems = [];
  for (const cat of Object.values(result.categories)) {
    if (cat?.items) allItems.push(...cat.items);
  }
  assert.ok(allItems.length >= 1, 'has at least one article');
  const first = allItems[0];
  assert.strictEqual(first.title, 'Test Article');
  assert.strictEqual(first.link, 'https://example.com/article');
  assert.ok(first.source);
  assert.ok(typeof first.publishedAt === 'number');
});

test('fetchNewsTech returns ListFeedDigestResponse format', async () => {
  const result = await fetchNewsTech({
    config: mockConfig,
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.ok(result.categories);
  assert.ok(result.feedStatuses);
  assert.ok(result.generatedAt);
  const allItems = [];
  for (const cat of Object.values(result.categories)) {
    if (cat?.items) allItems.push(...cat.items);
  }
  assert.ok(allItems.length >= 1);
  assert.strictEqual(allItems[0].title, 'Test Article');
});

test('fetchNewsFinance returns ListFeedDigestResponse format', async () => {
  const result = await fetchNewsFinance({
    config: mockConfig,
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.ok(result.categories);
  assert.ok(result.feedStatuses);
  assert.ok(result.generatedAt);
  const allItems = [];
  for (const cat of Object.values(result.categories)) {
    if (cat?.items) allItems.push(...cat.items);
  }
  assert.ok(allItems.length >= 1);
  assert.strictEqual(allItems[0].title, 'Test Article');
});

test('fetchNewsHappy returns ListFeedDigestResponse format', async () => {
  const result = await fetchNewsHappy({
    config: mockConfig,
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.ok(result.categories);
  assert.ok(result.feedStatuses);
  assert.ok(result.generatedAt);
  const allItems = [];
  for (const cat of Object.values(result.categories)) {
    if (cat?.items) allItems.push(...cat.items);
  }
  assert.ok(allItems.length >= 1);
  assert.strictEqual(allItems[0].title, 'Test Article');
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

  assert.ok(result.categories);
  assert.ok(result.feedStatuses);
  assert.ok(result.generatedAt);
  assert.strictEqual(typeof result.categories, 'object');
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

  assert.ok(result.categories);
  assert.ok(result.feedStatuses);
  assert.ok(result.generatedAt);
  const allItems = [];
  for (const cat of Object.values(result.categories)) {
    if (cat?.items) allItems.push(...cat.items);
  }
  assert.strictEqual(allItems.length, 0);
});
