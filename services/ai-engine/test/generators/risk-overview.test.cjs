'use strict';

const test = require('node:test');
const assert = require('node:assert');
const generateRiskOverview = require('../../generators/risk-overview.cjs');

test('generateRiskOverview throws when supabase, redis, or http missing', async () => {
  const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

  await assert.rejects(
    async () => generateRiskOverview({ redis: {}, log: mockLog, http: {} }),
    /supabase, redis, and http are required/
  );
  await assert.rejects(
    async () => generateRiskOverview({ supabase: {}, log: mockLog, http: {} }),
    /supabase, redis, and http are required/
  );
  await assert.rejects(
    async () => generateRiskOverview({ supabase: {}, redis: {}, log: mockLog }),
    /supabase, redis, and http are required/
  );
});

test('generateRiskOverview returns overview, topRisks, interconnections', async () => {
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
      if (key === 'news:digest:v1:full:en') return { items: [{ title: 'Conflict news', source: 'Reuters' }] };
      if (key === 'relay:conflict:v1') return { data: [{ country: 'Ukraine', event_type: 'Armed conflict' }] };
      if (key === 'relay:cyber:v1') return { data: [{ summary: 'Ransomware', severity: 'high' }] };
      if (key === 'risk:scores:sebuf:v1') return { ciiScores: [{ country: 'UA', score: 80 }] };
      if (key === 'theater-posture:sebuf:v1') return { theaters: [{ name: 'Eastern Europe', postureLevel: 'elevated' }] };
      return null;
    },
  };

  const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

  const mockHttp = {
    fetchJson: async () => ({
      choices: [{
        message: {
          content: JSON.stringify({
            overview: 'Elevated risk across military and cyber domains.',
            topRisks: [
              { domain: 'military', risk: 'Eastern Europe posture', severity: 'high', trend: 'increasing' },
              { domain: 'cyber', risk: 'Ransomware', severity: 'high', trend: 'stable' },
            ],
            interconnections: ['Military escalation may trigger cyber retaliation'],
          }),
        },
      }],
    }),
  };

  const result = await generateRiskOverview({
    supabase: mockSupabase,
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.ok(result.data);
  assert.strictEqual(typeof result.data.overview, 'string');
  assert.ok(Array.isArray(result.data.topRisks));
  assert.strictEqual(result.data.topRisks.length, 2);
  assert.ok(Array.isArray(result.data.interconnections));
  assert.strictEqual(result.data.interconnections.length, 1);
  assert.strictEqual(result.source, 'ai:risk-overview');
});

test('generateRiskOverview returns empty when no input', async () => {
  const mockSupabase = { rpc: async () => ({ data: null, error: null }) };
  const mockRedis = { get: async () => null };
  const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  const mockHttp = { fetchJson: async () => ({}) };

  const result = await generateRiskOverview({
    supabase: mockSupabase,
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.data.overview, '');
  assert.deepStrictEqual(result.data.topRisks, []);
  assert.deepStrictEqual(result.data.interconnections, []);
});

test('generateRiskOverview handles LLM API error', async () => {
  const mockSupabase = {
    rpc: async (name) => {
      if (name === 'get_active_llm_provider' || name === 'get_all_enabled_providers') return { data: [{ api_url: 'https://x.com', default_model: 'gpt', api_key_secret_name: 'K' }], error: null };
      if (name === 'get_vault_secret_value') return { data: 'key', error: null };
      return { data: null, error: new Error('Unknown') };
    },
  };
  const mockRedis = { get: async (key) => (key && key.endsWith(':previous') ? null : { items: [{ title: 'Test' }] }) };
  const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  const mockHttp = { fetchJson: async () => ({ error: { message: 'Service unavailable' } }) };

  const result = await generateRiskOverview({
    supabase: mockSupabase,
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.data, null);
  assert.ok(result.error?.includes('Service unavailable'));
});

test('generateRiskOverview handles malformed LLM JSON', async () => {
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

  const result = await generateRiskOverview({
    supabase: mockSupabase,
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.data, null);
  assert.ok(result.error?.includes('JSON') || result.error?.includes('failed'));
});
