'use strict';

const test = require('node:test');
const assert = require('node:assert');
const generateIntelDigest = require('../../generators/intel-digest.cjs');

test('generateIntelDigest returns structured summary', async () => {
  const mockSupabase = {
    rpc: async (name, args) => {
      if (name === 'get_active_llm_provider') {
        return {
          data: [
            {
              name: 'test',
              api_url: 'https://api.openai.com/v1/chat/completions',
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
    get: async (key) => {
      if (key.includes('news')) {
        return { data: [{ title: 'Test News', description: 'Test' }] };
      }
      return null;
    },
  };

  const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

  const mockHttp = {
    fetchJson: async (url, options) => {
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: 'Test intel digest summary',
                highlights: ['Event 1', 'Event 2'],
                regions: ['Middle East', 'Asia'],
              }),
            },
          },
        ],
      };
    },
  };

  const result = await generateIntelDigest({
    supabase: mockSupabase,
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.ok(result.data);
  assert.strictEqual(result.data.summary, 'Test intel digest summary');
  assert.ok(Array.isArray(result.data.highlights));
  assert.ok(result.data.digest, 'digest field required by frontend');
  assert.ok(result.data.digest.includes('Test intel digest summary'));
  assert.strictEqual(result.data.model, 'gpt-4');
  assert.strictEqual(result.data.provider, 'openai');
  assert.ok(result.data.generatedAt);
});

test('generateIntelDigest handles LLM API error payload', async () => {
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

  const mockRedis = { get: async () => null };
  const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

  const mockHttp = {
    fetchJson: async () => ({ error: { message: 'Rate limit exceeded' } }),
  };

  const result = await generateIntelDigest({
    supabase: mockSupabase,
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.ok(result.error?.includes('Rate limit exceeded'));
});

test('generateIntelDigest handles LLM empty response', async () => {
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

  const mockRedis = { get: async () => null };
  const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

  const mockHttp = {
    fetchJson: async () => ({ choices: [] }),
  };

  const result = await generateIntelDigest({
    supabase: mockSupabase,
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.ok(result.error?.includes('empty or invalid'));
});
