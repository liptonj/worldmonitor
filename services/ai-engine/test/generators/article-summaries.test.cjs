'use strict';

const test = require('node:test');
const assert = require('node:assert');
const generateArticleSummaries = require('../../generators/article-summaries.cjs');

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
  const mockSupabase = {
    rpc: async (name) => {
      if (name === 'get_active_llm_provider' || name === 'get_all_enabled_providers') {
        return {
          data: [
            {
              name: 'test',
              api_url: 'https://api.openai.com/v1',
              default_model: 'gpt-4',
              api_key_secret_name: 'TEST_KEY',
            },
          ],
          error: null,
        };
      }
      if (name === 'get_vault_secret_value') {
        return { data: 'test-api-key', error: null };
      }
      return { data: null, error: new Error('Unknown RPC') };
    },
  };

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
      choices: [
        {
          message: {
            content: JSON.stringify({
              summaries: [
                { url: 'https://example.com/1', title: 'Test Article 1', summary: 'Summary of article 1', keyPoints: ['Point 1', 'Point 2'] },
                { url: 'https://example.com/2', title: 'Test Article 2', summary: 'Summary of article 2', keyPoints: ['Point A', 'Point B'] },
              ],
            }),
          },
        },
      ],
    }),
  };

  const result = await generateArticleSummaries({
    supabase: mockSupabase,
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.ok(result.data);
  assert.strictEqual(result.source, 'ai:article-summaries');

  // Output must be hash-map keyed by FNV-1a hash of title (not { summaries: [...] })
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

test('generateArticleSummaries returns empty summaries when no articles', async () => {
  const mockSupabase = {
    rpc: async () => ({ data: null, error: null }),
  };

  const mockRedis = {
    get: async () => null,
  };

  const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  const mockHttp = { fetchJson: async () => ({}) };

  const result = await generateArticleSummaries({
    supabase: mockSupabase,
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
  const mockSupabase = {
    rpc: async (name) => {
      if (name === 'get_active_llm_provider' || name === 'get_all_enabled_providers') {
        return {
          data: [
            {
              name: 'test',
              api_url: 'https://api.openai.com/v1',
              default_model: 'gpt-4',
              api_key_secret_name: 'TEST_KEY',
            },
          ],
          error: null,
        };
      }
      if (name === 'get_vault_secret_value') {
        return { data: 'test-key', error: null };
      }
      return { data: null, error: new Error('Unknown RPC') };
    },
  };

  const mockRedis = {
    get: async () => ({ items: [{ title: 'Test', url: 'https://example.com', description: 'Text' }] }),
  };

  const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

  const mockHttp = {
    fetchJson: async () => ({ error: { message: 'Rate limit exceeded' } }),
  };

  const result = await generateArticleSummaries({
    supabase: mockSupabase,
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.data, null);
  assert.ok(result.error?.includes('Rate limit exceeded'));
});

test('generateArticleSummaries handles malformed LLM JSON', async () => {
  const mockSupabase = {
    rpc: async (name) => {
      if (name === 'get_active_llm_provider' || name === 'get_all_enabled_providers') {
        return {
          data: [
            {
              name: 'test',
              api_url: 'https://api.openai.com/v1',
              default_model: 'gpt-4',
              api_key_secret_name: 'TEST_KEY',
            },
          ],
          error: null,
        };
      }
      if (name === 'get_vault_secret_value') {
        return { data: 'test-key', error: null };
      }
      return { data: null, error: new Error('Unknown RPC') };
    },
  };

  const mockRedis = {
    get: async () => ({ items: [{ title: 'Test', url: 'https://example.com', description: 'Text' }] }),
  };

  const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

  const mockHttp = {
    fetchJson: async () => ({
      choices: [{ message: { content: 'not valid json' } }],
    }),
  };

  const result = await generateArticleSummaries({
    supabase: mockSupabase,
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.data, null);
  assert.ok(result.error?.includes('invalid JSON'));
});
