// tests/relay-ollama-client.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('relay multi-provider LLM client contract', () => {
  const src = readFileSync('scripts/ais-relay.cjs', 'utf8');

  it('defines resolveAllProviders function', () => {
    assert.ok(src.includes('resolveAllProviders'), 'must define resolveAllProviders');
  });

  it('defines callLlmForFunction function', () => {
    assert.ok(src.includes('callLlmForFunction'), 'must define callLlmForFunction');
  });

  it('defines callLlmWithProvider function', () => {
    assert.ok(src.includes('callLlmWithProvider'), 'must define callLlmWithProvider for direct provider calls');
  });

  it('defines getFunctionConfig function', () => {
    assert.ok(src.includes('getFunctionConfig'), 'must define getFunctionConfig');
  });

  it('calls get_ollama_credentials RPC', () => {
    assert.ok(src.includes("'get_ollama_credentials'") || src.includes('"get_ollama_credentials"'),
      'must call get_ollama_credentials RPC');
  });

  it('calls get_llm_function_config RPC or reads llm_function_config', () => {
    assert.ok(src.includes('llm_function_config') || src.includes('function_config'),
      'must read per-function provider config');
  });

  it('sends CF-Access-Client-Id header for Ollama', () => {
    assert.ok(src.includes('CF-Access-Client-Id'), 'must send CF-Access-Client-Id header');
  });

  it('handles qwen3 native API', () => {
    assert.ok(src.includes('/api/chat') && src.includes('qwen3'),
      'must handle qwen3 native API path');
  });

  it('handles OpenAI-compat API', () => {
    assert.ok(src.includes('/v1/chat/completions'),
      'must handle OpenAI-compat API path');
  });

  it('implements provider fallback chain', () => {
    assert.ok(src.includes('provider_chain') || src.includes('providerChain'),
      'must implement provider fallback chain');
  });

  it('defines loadLlmPrompt function', () => {
    assert.ok(src.includes('loadLlmPrompt'), 'must define loadLlmPrompt');
  });

  it('calls get_llm_prompt RPC', () => {
    assert.ok(src.includes("'get_llm_prompt'") || src.includes('"get_llm_prompt"'),
      'must call get_llm_prompt RPC');
  });
});
