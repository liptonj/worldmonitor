'use strict';

const test = require('node:test');
const assert = require('node:assert');
const generatePanelSummary = require('../../generators/panel-summary.cjs');

test('generatePanelSummary returns structured summary', async () => {
  const mockSupabase = {
    rpc: async (name) => {
      if (name === 'get_active_llm_provider' || name === 'get_all_enabled_providers') {
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
      if (key && key.endsWith(':previous')) return null;
      if (key === 'news:digest:v1:full:en') {
        return { data: [{ title: 'Test News', description: 'Test' }] };
      }
      if (key === 'relay:telegram:v1') {
        return { items: [{ channel: 'OSINT', text: 'Test message' }] };
      }
      if (key === 'market:dashboard:v1') {
        return { indices: [{ symbol: 'SPX', price: 5000 }] };
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
              summary: 'Executive summary of global intelligence panels.',
              keyEvents: ['Event A', 'Event B'],
              riskLevel: 'medium',
            }),
          },
        },
      ],
    }),
  };

  const result = await generatePanelSummary({
    supabase: mockSupabase,
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.ok(result.data);
  assert.strictEqual(typeof result.data.summary, 'string');
  assert.ok(result.data.summary.length > 0);
  assert.ok(Array.isArray(result.data.keyEvents));
  const validRiskLevels = ['low', 'medium', 'high', 'critical'];
  assert.ok(
    validRiskLevels.includes(result.data.riskLevel),
    `riskLevel must be one of ${validRiskLevels.join(', ')}, got: ${result.data.riskLevel}`
  );
  assert.ok(result.data.generatedAt);
  assert.strictEqual(typeof result.data.contextSources, 'number');
  assert.strictEqual(result.source, 'ai:panel-summary');
});

test('generatePanelSummary handles LLM API error', async () => {
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

  const mockRedis = { get: async () => null };
  const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

  const mockHttp = {
    fetchJson: async () => ({ error: { message: 'Rate limit exceeded' } }),
  };

  const result = await generatePanelSummary({
    supabase: mockSupabase,
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.data, null);
  assert.ok(result.error?.includes('Rate limit exceeded'));
  assert.strictEqual(result.source, 'ai:panel-summary');
});
