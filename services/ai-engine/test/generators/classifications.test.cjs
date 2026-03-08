'use strict';

const test = require('node:test');
const assert = require('node:assert');
const generateClassifications = require('../../generators/classifications.cjs');

test('generateClassifications returns event classifications', async () => {
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
      return { data: null, error: null };
    },
  };

  const mockRedis = {
    get: async (key) => {
      if (key === 'relay:telegram:v1') {
        return {
          data: {
            messages: [
              { id: 1, text: 'Breaking: Major cyberattack on infrastructure', timestamp: Date.now() },
              { id: 2, text: 'Economic sanctions announced', timestamp: Date.now() },
            ],
          },
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
              classifications: [
                { id: 1, type: 'cyber', severity: 'high', region: 'Global', confidence: 0.9 },
                { id: 2, type: 'political', severity: 'medium', region: 'Europe', confidence: 0.85 },
              ],
            }),
          },
        },
      ],
    }),
  };

  const result = await generateClassifications({
    supabase: mockSupabase,
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.ok(result.data);
  assert.ok(Array.isArray(result.data.classifications));
  assert.strictEqual(result.data.classifications.length, 2);
  assert.strictEqual(result.data.classifications[0].type, 'cyber');
});

test('generateClassifications handles empty input', async () => {
  const mockSupabase = {
    rpc: async (name) => {
      if (name === 'get_active_llm_provider') {
        return {
          data: [{ api_url: 'http://test', default_model: 'gpt-4', api_key_secret_name: 'KEY' }],
          error: null,
        };
      }
      if (name === 'get_vault_secret_value') {
        return { data: 'test-key', error: null };
      }
      return { data: null, error: null };
    },
  };
  const mockRedis = { get: async () => null };
  const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  const mockHttp = { fetchJson: async () => ({ choices: [{ message: { content: '{}' } }] }) };

  const result = await generateClassifications({
    supabase: mockSupabase,
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.ok(result.data);
  assert.ok(Array.isArray(result.data.classifications));
  assert.strictEqual(result.data.classifications.length, 0);
});

test('generateClassifications handles missing deps', async () => {
  const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

  await assert.rejects(
    async () => generateClassifications({ supabase: null, redis: null, log: mockLog, http: null }),
    /supabase, redis, and http are required/
  );
});

test('generateClassifications handles malformed LLM JSON', async () => {
  const mockSupabase = {
    rpc: async (name) => {
      if (name === 'get_active_llm_provider') {
        return {
          data: [{ api_url: 'http://test', default_model: 'gpt-4', api_key_secret_name: 'KEY' }],
          error: null,
        };
      }
      if (name === 'get_vault_secret_value') {
        return { data: 'test-key', error: null };
      }
      return { data: null, error: null };
    },
  };
  const mockRedis = {
    get: async () => ({ data: { messages: [{ id: 1, text: 'Test event' }] } }),
  };
  const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  const mockHttp = {
    fetchJson: async () => ({ choices: [{ message: { content: 'not valid json' } }] }),
  };

  const result = await generateClassifications({
    supabase: mockSupabase,
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.data, null);
  assert.ok(result.error?.includes('invalid JSON'));
});

test('generateClassifications handles LLM API error', async () => {
  const mockSupabase = {
    rpc: async (name) => {
      if (name === 'get_active_llm_provider') {
        return {
          data: [{ api_url: 'http://test', default_model: 'gpt-4', api_key_secret_name: 'KEY' }],
          error: null,
        };
      }
      if (name === 'get_vault_secret_value') {
        return { data: 'test-key', error: null };
      }
      return { data: null, error: null };
    },
  };
  const mockRedis = {
    get: async () => ({ data: { messages: [{ id: 1, text: 'Test event' }] } }),
  };
  const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  const mockHttp = {
    fetchJson: async () => ({ error: { message: 'Rate limit exceeded' } }),
  };

  const result = await generateClassifications({
    supabase: mockSupabase,
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.data, null);
  assert.ok(result.error?.includes('Rate limit exceeded'));
});
