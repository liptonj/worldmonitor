'use strict';

const test = require('node:test');
const assert = require('node:assert');
const generateArticleSummaries = require('../../generators/article-summaries.cjs');

function createMockSupabase(overrides = {}) {
  return {
    rpc: async (name, args) => {
      if (name === 'get_all_enabled_providers') {
        return {
          data: [{
            name: 'test',
            api_url: 'https://api.test.com/v1',
            default_model: 'test-model',
            api_key_secret_name: 'TEST_KEY',
          }],
          error: null,
        };
      }
      if (name === 'get_llm_function_config') {
        return {
          data: [{ function_key: 'news_summary', provider_chain: ['test'], max_retries: 1, timeout_ms: 30000 }],
          error: null,
        };
      }
      if (name === 'get_llm_prompt') {
        return { data: [], error: null };
      }
      if (name === 'get_vault_secret_value') {
        return { data: 'test-api-key', error: null };
      }
      if (overrides.rpc) return overrides.rpc(name, args);
      return { data: null, error: null };
    },
  };
}

test('generateArticleSummaries throws when supabase, redis, or http missing', async () => {
  const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

  await assert.rejects(
    async () => generateArticleSummaries({ redis: {}, log: mockLog, http: {} }),
    /supabase, redis, and http are required/
  );
  await assert.rejects(
    async () => generateArticleSummaries({ supabase: {}, log: mockLog, http: {} }),
    /supabase, redis, and http are required/
  );
  await assert.rejects(
    async () => generateArticleSummaries({ supabase: {}, redis: {}, log: mockLog }),
    /supabase, redis, and http are required/
  );
});

test('generateArticleSummaries returns summaries', async () => {
  const mockRedis = {
    get: async (key) => {
      if (key === 'news:digest:v1:full:en') {
        return {
          items: [
            { title: 'Test Article 1', url: 'https://example.com/1', description: 'Full text of article 1...' },
            { title: 'Test Article 2', url: 'https://example.com/2', description: 'Full text of article 2...' },
          ],
        };
      }
      return null;
    },
  };

  const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

  const mockHttp = {
    fetchJson: async () => ({
      choices: [{
        message: {
          content: JSON.stringify({
            summaries: [
              { url: 'https://example.com/1', title: 'Test Article 1', summary: 'Summary of article 1', keyPoints: ['Point 1', 'Point 2'] },
              { url: 'https://example.com/2', title: 'Test Article 2', summary: 'Summary of article 2', keyPoints: ['Point A', 'Point B'] },
            ],
          }),
        },
      }],
    }),
  };

  const result = await generateArticleSummaries({
    supabase: createMockSupabase(),
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.ok(result.data);
  assert.strictEqual(result.source, 'ai:article-summaries');

  assert.ok(!Array.isArray(result.data));
  assert.strictEqual(typeof result.data, 'object');
  const keys = Object.keys(result.data);
  assert.strictEqual(keys.length, 2);

  const entries = Object.values(result.data);
  assert.strictEqual(entries.length, 2);

  for (const entry of entries) {
    assert.strictEqual(typeof entry.text, 'string', 'entry has text field');
    assert.strictEqual(typeof entry.title, 'string', 'entry has title field');
    assert.strictEqual(typeof entry.generatedAt, 'string', 'entry has generatedAt field');
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(entry.generatedAt), 'generatedAt is YYYY-MM-DD');
  }

  const byTitle = Object.fromEntries(entries.map((e) => [e.title, e]));
  assert.strictEqual(byTitle['Test Article 1'].text, 'Summary of article 1');
  assert.strictEqual(byTitle['Test Article 2'].text, 'Summary of article 2');
});

test('generateArticleSummaries extracts JSON from markdown fences', async () => {
  const mockRedis = {
    get: async () => ({
      items: [{ title: 'Test', url: 'https://example.com', description: 'Text' }],
    }),
  };

  const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

  const jsonPayload = JSON.stringify({
    summaries: [
      { url: 'https://example.com', title: 'Test', summary: 'A test summary', keyPoints: ['point'] },
    ],
  });

  const mockHttp = {
    fetchJson: async () => ({
      choices: [{
        message: {
          content: `Here's the summary:\n\n\`\`\`json\n${jsonPayload}\n\`\`\``,
        },
      }],
    }),
  };

  const result = await generateArticleSummaries({
    supabase: createMockSupabase(),
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.ok(result.data);
  assert.strictEqual(Object.keys(result.data).length, 1);
  const entry = Object.values(result.data)[0];
  assert.strictEqual(entry.text, 'A test summary');
});

test('generateArticleSummaries returns empty summaries when no articles', async () => {
  const mockRedis = { get: async () => null };
  const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  const mockHttp = { fetchJson: async () => ({}) };

  const result = await generateArticleSummaries({
    supabase: createMockSupabase(),
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.ok(result.data);
  assert.strictEqual(typeof result.data, 'object');
  assert.strictEqual(Object.keys(result.data).length, 0);
  assert.deepStrictEqual(result.data, {});
});

test('generateArticleSummaries handles LLM API error', async () => {
  const mockRedis = {
    get: async () => ({ items: [{ title: 'Test', url: 'https://example.com', description: 'Text' }] }),
  };

  const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

  const mockHttp = {
    fetchJson: async () => ({ error: { message: 'Rate limit exceeded' } }),
  };

  const result = await generateArticleSummaries({
    supabase: createMockSupabase(),
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.data, null);
  assert.ok(result.error?.includes('Rate limit exceeded') || result.error?.includes('failed'));
});

test('generateArticleSummaries handles completely invalid LLM response', async () => {
  const mockRedis = {
    get: async () => ({ items: [{ title: 'Test', url: 'https://example.com', description: 'Text' }] }),
  };

  const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

  const mockHttp = {
    fetchJson: async () => ({
      choices: [{ message: { content: 'This is just plain text with no JSON at all' } }],
    }),
  };

  const result = await generateArticleSummaries({
    supabase: createMockSupabase(),
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.data, null);
  assert.ok(result.error?.includes('JSON') || result.error?.includes('failed'));
});
