'use strict';

const test = require('node:test');
const assert = require('node:assert');
const generateInstabilityAnalysis = require('../../generators/instability-analysis.cjs');

test('generateInstabilityAnalysis throws when supabase, redis, or http missing', async () => {
  const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

  await assert.rejects(
    async () => generateInstabilityAnalysis({ redis: {}, log: mockLog, http: {} }),
    /supabase, redis, and http are required/
  );
  await assert.rejects(
    async () => generateInstabilityAnalysis({ supabase: {}, log: mockLog, http: {} }),
    /supabase, redis, and http are required/
  );
  await assert.rejects(
    async () => generateInstabilityAnalysis({ supabase: {}, redis: {}, log: mockLog }),
    /supabase, redis, and http are required/
  );
});

test('generateInstabilityAnalysis returns regions', async () => {
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
      if (key && key.endsWith(':previous')) return null;
      if (key === 'relay:conflict:v1') {
        return { data: [{ country: 'Ukraine', event_type: 'Armed conflict', actor1: 'UA' }] };
      }
      if (key === 'risk:scores:sebuf:v1') return { ciiScores: [{ country: 'UA', score: 75 }] };
      if (key === 'news:digest:v1:full:en') return { items: [{ title: 'Conflict escalates', source: 'Reuters' }] };
      return null;
    },
  };

  const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

  const mockHttp = {
    fetchJson: async () => ({
      choices: [{
        message: {
          content: JSON.stringify({
            regions: [
              { region: 'Eastern Europe', level: 'high', drivers: ['Armed conflict'], countries: ['Ukraine', 'Russia'], trajectory: 'increasing' },
            ],
          }),
        },
      }],
    }),
  };

  const result = await generateInstabilityAnalysis({
    supabase: mockSupabase,
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.ok(result.data);
  assert.ok(Array.isArray(result.data.regions));
  assert.strictEqual(result.data.regions.length, 1);
  assert.strictEqual(result.data.regions[0].region, 'Eastern Europe');
  assert.strictEqual(result.data.regions[0].level, 'high');
  assert.strictEqual(result.source, 'ai:instability-analysis');
});

test('generateInstabilityAnalysis returns empty regions when no input', async () => {
  const mockSupabase = { rpc: async () => ({ data: null, error: null }) };
  const mockRedis = { get: async () => null };
  const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  const mockHttp = { fetchJson: async () => ({}) };

  const result = await generateInstabilityAnalysis({
    supabase: mockSupabase,
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.deepStrictEqual(result.data, { regions: [] });
});

test('generateInstabilityAnalysis handles LLM API error', async () => {
  const mockSupabase = {
    rpc: async (name) => {
      if (name === 'get_active_llm_provider' || name === 'get_all_enabled_providers') return { data: [{ api_url: 'https://x.com', default_model: 'gpt', api_key_secret_name: 'K' }], error: null };
      if (name === 'get_vault_secret_value') return { data: 'key', error: null };
      return { data: null, error: new Error('Unknown') };
    },
  };
  const mockRedis = { get: async (key) => (key && key.endsWith(':previous') ? null : { data: [{ country: 'UA' }] }) };
  const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  const mockHttp = { fetchJson: async () => ({ error: { message: 'Timeout' } }) };

  const result = await generateInstabilityAnalysis({
    supabase: mockSupabase,
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.data, null);
  assert.ok(result.error?.includes('Timeout'));
});

test('generateInstabilityAnalysis handles malformed LLM JSON', async () => {
  const mockSupabase = {
    rpc: async (name) => {
      if (name === 'get_active_llm_provider' || name === 'get_all_enabled_providers') return { data: [{ api_url: 'https://x.com', default_model: 'gpt', api_key_secret_name: 'K' }], error: null };
      if (name === 'get_vault_secret_value') return { data: 'key', error: null };
      return { data: null, error: new Error('Unknown') };
    },
  };
  const mockRedis = { get: async (key) => (key && key.endsWith(':previous') ? null : { data: [{ country: 'UA' }] }) };
  const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  const mockHttp = { fetchJson: async () => ({ choices: [{ message: { content: 'not json' } }] }) };

  const result = await generateInstabilityAnalysis({
    supabase: mockSupabase,
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.data, null);
  assert.ok(result.error?.includes('invalid JSON'));
});
