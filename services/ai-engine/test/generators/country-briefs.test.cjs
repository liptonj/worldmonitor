'use strict';

const test = require('node:test');
const assert = require('node:assert');
const generateCountryBriefs = require('../../generators/country-briefs.cjs');

test('generateCountryBriefs throws when supabase, redis, or http missing', async () => {
  const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

  await assert.rejects(
    async () => generateCountryBriefs({ redis: {}, log: mockLog, http: {} }),
    /supabase, redis, and http are required/
  );
  await assert.rejects(
    async () => generateCountryBriefs({ supabase: {}, log: mockLog, http: {} }),
    /supabase, redis, and http are required/
  );
  await assert.rejects(
    async () => generateCountryBriefs({ supabase: {}, redis: {}, log: mockLog }),
    /supabase, redis, and http are required/
  );
});

test('generateCountryBriefs returns briefs keyed by country code', async () => {
  const mockSupabase = {
    rpc: async (name) => {
      if (name === 'get_active_llm_provider' || name === 'get_all_enabled_providers') {
        return {
          data: [{ name: 'test', api_url: 'https://api.example.com/v1', default_model: 'gpt-4', api_key_secret_name: 'KEY' }],
          error: null,
        };
      }
      if (name === 'get_vault_secret_value') return { data: 'test-key', error: null };
      return { data: null, error: new Error('Unknown RPC') };
    },
  };

  const mockRedis = {
    get: async (key) => {
      if (key === 'news:digest:v1:full:en') {
        return { items: [{ title: 'Ukraine conflict', description: 'Ongoing developments', source: 'Reuters' }] };
      }
      if (key === 'risk:scores:sebuf:v1') return { ciiScores: [] };
      if (key === 'relay:conflict:v1') {
        return { data: [{ country: 'Ukraine', event_type: 'Armed conflict', actor1: 'UA' }] };
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
            briefs: [
              { country: 'Ukraine', code: 'UA', summary: 'Ongoing conflict.', developments: ['Military activity'], riskLevel: 'high' },
              { country: 'Russia', code: 'RU', summary: 'Military posture elevated.', developments: ['Deployments'], riskLevel: 'elevated' },
            ],
          }),
        },
      }],
    }),
  };

  const result = await generateCountryBriefs({
    supabase: mockSupabase,
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.ok(result.data);
  assert.strictEqual(result.source, 'ai:country-briefs');
  assert.ok(result.data.UA);
  assert.ok(result.data.RU);
  assert.strictEqual(typeof result.data.UA.brief, 'string');
  assert.ok(result.data.UA.brief.includes('Ongoing conflict'));
});

test('generateCountryBriefs returns empty when no input data', async () => {
  const mockSupabase = { rpc: async () => ({ data: null, error: null }) };
  const mockRedis = { get: async () => null };
  const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  const mockHttp = { fetchJson: async () => ({}) };

  const result = await generateCountryBriefs({
    supabase: mockSupabase,
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.deepStrictEqual(result.data, {});
});

test('generateCountryBriefs handles LLM API error', async () => {
  const mockSupabase = {
    rpc: async (name) => {
      if (name === 'get_active_llm_provider' || name === 'get_all_enabled_providers') return { data: [{ api_url: 'https://x.com', default_model: 'gpt', api_key_secret_name: 'K' }], error: null };
      if (name === 'get_vault_secret_value') return { data: 'key', error: null };
      return { data: null, error: new Error('Unknown') };
    },
  };
  const mockRedis = { get: async (key) => (key && key.endsWith(':previous') ? null : { items: [{ title: 'Test' }] }) };
  const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  const mockHttp = { fetchJson: async () => ({ error: { message: 'Rate limit' } }) };

  const result = await generateCountryBriefs({
    supabase: mockSupabase,
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.data, null);
  assert.ok(result.error?.includes('Rate limit'));
});

test('generateCountryBriefs handles malformed LLM JSON', async () => {
  const mockSupabase = {
    rpc: async (name) => {
      if (name === 'get_active_llm_provider' || name === 'get_all_enabled_providers') return { data: [{ api_url: 'https://x.com', default_model: 'gpt', api_key_secret_name: 'K' }], error: null };
      if (name === 'get_vault_secret_value') return { data: 'key', error: null };
      return { data: null, error: new Error('Unknown') };
    },
  };
  const mockRedis = { get: async (key) => (key && key.endsWith(':previous') ? null : { items: [{ title: 'Test' }] }) };
  const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  const mockHttp = { fetchJson: async () => ({ choices: [{ message: { content: 'not json' } }] }) };

  const result = await generateCountryBriefs({
    supabase: mockSupabase,
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.data, null);
  assert.ok(result.error?.includes('JSON') || result.error?.includes('failed'));
});
