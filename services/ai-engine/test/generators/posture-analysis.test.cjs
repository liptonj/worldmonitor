'use strict';

const test = require('node:test');
const assert = require('node:assert');
const generatePostureAnalysis = require('../../generators/posture-analysis.cjs');

test('generatePostureAnalysis throws when supabase, redis, or http missing', async () => {
  const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

  await assert.rejects(
    async () => generatePostureAnalysis({ redis: {}, log: mockLog, http: {} }),
    /supabase, redis, and http are required/
  );
  await assert.rejects(
    async () => generatePostureAnalysis({ supabase: {}, log: mockLog, http: {} }),
    /supabase, redis, and http are required/
  );
  await assert.rejects(
    async () => generatePostureAnalysis({ supabase: {}, redis: {}, log: mockLog }),
    /supabase, redis, and http are required/
  );
});

test('generatePostureAnalysis returns analyses', async () => {
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
      if (key === 'theater-posture:sebuf:v1') {
        return { theaters: [{ name: 'Eastern Europe', postureLevel: 'elevated', totalAircraft: 12, totalVessels: 5 }] };
      }
      if (key === 'relay:conflict:v1') return { data: [{ country: 'Ukraine', event_type: 'Armed conflict' }] };
      if (key === 'relay:ais-snapshot:v1') return { flights: [{ origin_country: 'RU', callsign: 'RFF' }] };
      return null;
    },
  };

  const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

  const mockHttp = {
    fetchJson: async () => ({
      choices: [{
        message: {
          content: JSON.stringify({
            analyses: [
              { actor: 'Russia', posture: 'elevated', capabilities: 'Air and naval', intentions: 'Deterrence', locations: 'Eastern Europe' },
            ],
          }),
        },
      }],
    }),
  };

  const result = await generatePostureAnalysis({
    supabase: mockSupabase,
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.ok(result.data);
  assert.ok(Array.isArray(result.data.analyses));
  assert.strictEqual(result.data.analyses.length, 1);
  assert.strictEqual(result.data.analyses[0].actor, 'Russia');
  assert.strictEqual(result.source, 'ai:posture-analysis');
});

test('generatePostureAnalysis returns empty analyses when no input', async () => {
  const mockSupabase = { rpc: async () => ({ data: null, error: null }) };
  const mockRedis = { get: async () => null };
  const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  const mockHttp = { fetchJson: async () => ({}) };

  const result = await generatePostureAnalysis({
    supabase: mockSupabase,
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.deepStrictEqual(result.data, { analyses: [] });
});

test('generatePostureAnalysis handles LLM API error', async () => {
  const mockSupabase = {
    rpc: async (name) => {
      if (name === 'get_active_llm_provider' || name === 'get_all_enabled_providers') return { data: [{ api_url: 'https://x.com', default_model: 'gpt', api_key_secret_name: 'K' }], error: null };
      if (name === 'get_vault_secret_value') return { data: 'key', error: null };
      return { data: null, error: new Error('Unknown') };
    },
  };
  const mockRedis = { get: async (key) => (key && key.endsWith(':previous') ? null : { theaters: [{ name: 'Test' }] }) };
  const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  const mockHttp = { fetchJson: async () => ({ error: { message: 'API down' } }) };

  const result = await generatePostureAnalysis({
    supabase: mockSupabase,
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.data, null);
  assert.ok(result.error?.includes('API down'));
});

test('generatePostureAnalysis handles malformed LLM JSON', async () => {
  const mockSupabase = {
    rpc: async (name) => {
      if (name === 'get_active_llm_provider' || name === 'get_all_enabled_providers') return { data: [{ api_url: 'https://x.com', default_model: 'gpt', api_key_secret_name: 'K' }], error: null };
      if (name === 'get_vault_secret_value') return { data: 'key', error: null };
      return { data: null, error: new Error('Unknown') };
    },
  };
  const mockRedis = { get: async (key) => (key && key.endsWith(':previous') ? null : { theaters: [{ name: 'Test' }] }) };
  const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  const mockHttp = { fetchJson: async () => ({ choices: [{ message: { content: 'not json' } }] }) };

  const result = await generatePostureAnalysis({
    supabase: mockSupabase,
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.data, null);
  assert.ok(result.error?.includes('invalid JSON'));
});
