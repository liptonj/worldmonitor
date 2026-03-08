'use strict';

const test = require('node:test');
const assert = require('node:assert');
const generateArticleSummaries = require('../../generators/article-summaries.cjs');

test('generateArticleSummaries returns summaries', async () => {
  const mockSupabase = {
    rpc: async (name) => {
      if (name === 'get_active_llm_provider') {
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
      if (key === 'relay:news:full:v1') {
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
                { url: 'https://example.com/1', summary: 'Summary of article 1', keyPoints: ['Point 1', 'Point 2'] },
                { url: 'https://example.com/2', summary: 'Summary of article 2', keyPoints: ['Point A', 'Point B'] },
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
  assert.ok(Array.isArray(result.data.summaries));
  assert.strictEqual(result.data.summaries.length, 2);
  assert.strictEqual(result.data.summaries[0].summary, 'Summary of article 1');
  assert.ok(Array.isArray(result.data.summaries[0].keyPoints));
  assert.strictEqual(result.source, 'ai:article-summaries');
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
  assert.ok(Array.isArray(result.data.summaries));
  assert.strictEqual(result.data.summaries.length, 0);
});

test('generateArticleSummaries handles LLM API error', async () => {
  const mockSupabase = {
    rpc: async (name) => {
      if (name === 'get_active_llm_provider') {
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
      if (name === 'get_active_llm_provider') {
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
