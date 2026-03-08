'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fetchConfigNewsSources = require('../config-news-sources.cjs');

const mockRedis = { get: async () => null, setex: async () => {} };
const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

test('fetchConfigNewsSources returns worker-compatible format on success', async () => {
  const mockConfig = {
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_ANON_KEY: 'test-anon-key',
  };
  const mockHttp = {
    fetchJson: async (url, opts = {}) => {
      if (!url.includes('get_public_news_sources')) return [];
      const body = opts.body ? JSON.parse(opts.body) : {};
      const variant = body.p_variant || 'full';
      if (variant === 'full') return [{ name: 'Reuters', url: 'https://reuters.com/rss' }];
      if (variant === 'tech') return [{ name: 'TechCrunch', url: 'https://techcrunch.com/feed' }];
      return [];
    },
  };

  const result = await fetchConfigNewsSources({
    config: mockConfig,
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'config:news-sources');
  assert.ok(result.timestamp);
  assert.ok(Array.isArray(result.data));
  assert.ok(result.data.length >= 1);
  const reuters = result.data.find((s) => s.name === 'Reuters');
  assert.ok(reuters);
  assert.strictEqual(reuters.url, 'https://reuters.com/rss');
});

test('fetchConfigNewsSources handles fetch error gracefully', async () => {
  const mockConfig = {
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_ANON_KEY: 'test-anon-key',
  };
  const mockHttp = {
    fetchJson: async () => {
      throw new Error('Supabase RPC 500');
    },
  };

  const result = await fetchConfigNewsSources({
    config: mockConfig,
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.source, 'config:news-sources');
  assert.ok(Array.isArray(result.data));
  assert.strictEqual(result.data.length, 0);
  assert.ok(result.errors);
  assert.ok(result.errors.length > 0);
  assert.ok(result.errors[0].includes('500'));
});

test('fetchConfigNewsSources handles invalid response structure', async () => {
  const mockConfig = {
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_ANON_KEY: 'test-anon-key',
  };
  const mockHttp = {
    fetchJson: async () => ({ notAnArray: true }),
  };

  const result = await fetchConfigNewsSources({
    config: mockConfig,
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'config:news-sources');
  assert.ok(Array.isArray(result.data));
  assert.strictEqual(result.data.length, 0);
});

test('fetchConfigNewsSources dedupes sources across variants', async () => {
  const mockConfig = {
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_ANON_KEY: 'test-anon-key',
  };
  const sameSource = { name: 'BBC', url: 'https://bbc.co.uk/feed' };
  const mockHttp = {
    fetchJson: async (url, opts = {}) => {
      if (!url.includes('get_public_news_sources')) return [];
      const body = opts.body ? JSON.parse(opts.body) : {};
      if (body.p_variant === 'full' || body.p_variant === 'tech') return [sameSource];
      return [];
    },
  };

  const result = await fetchConfigNewsSources({
    config: mockConfig,
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  const bbc = result.data.filter((s) => s.name === 'BBC');
  assert.strictEqual(bbc.length, 1, 'should dedupe BBC across full and tech variants');
});
