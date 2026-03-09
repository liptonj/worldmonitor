'use strict';

/**
 * Shared LLM provider resolution and API call logic for ai-engine generators.
 *
 * Supports automatic provider fallback: if the primary provider fails, the
 * next-priority enabled provider is tried until one succeeds or all fail.
 */

async function resolveProviderSecret(supabase, secretName) {
  if (!secretName) return '';
  const { data, error } = await supabase.rpc('get_vault_secret_value', { secret_name: secretName });
  if (!error && data != null) return String(data);
  return process.env[secretName] ?? '';
}

async function buildProviderConfig(supabase, row) {
  const providerName = row.name ?? 'unknown';
  const apiKey = await resolveProviderSecret(supabase, row.api_key_secret_name ?? '');

  let bearerToken = '';
  if (providerName.toLowerCase() === 'ollama') {
    bearerToken = await resolveProviderSecret(supabase, 'OLLAMA_BEARER_TOKEN');
    if (!bearerToken) bearerToken = process.env.OLLAMA_BEARER_TOKEN ?? '';
  }

  return {
    api_key: apiKey,
    base_url: row.api_url ?? '',
    model_name: row.default_model ?? '',
    provider_type: 'openai',
    provider_name: providerName,
    bearer_token: bearerToken,
    max_tokens: row.max_tokens ?? 3000,
  };
}

async function fetchLLMProvider(supabase) {
  const { data: providerRows, error: providerError } = await supabase.rpc('get_active_llm_provider');
  if (providerError || !providerRows || providerRows.length === 0) {
    throw new Error('No active LLM provider found');
  }
  return buildProviderConfig(supabase, providerRows[0]);
}

async function fetchAllLLMProviders(supabase) {
  const { data: rows, error } = await supabase.rpc('get_all_enabled_providers');
  if (error || !rows || rows.length === 0) {
    throw new Error('No enabled LLM providers found');
  }
  const providers = [];
  for (const row of rows) {
    providers.push(await buildProviderConfig(supabase, row));
  }
  return providers;
}

async function callLLM(provider, systemPrompt, userPrompt, http, options = {}) {
  const { api_key, base_url, model_name, bearer_token } = provider;
  const url = base_url.includes('/chat/completions') ? base_url : base_url.replace(/\/+$/, '') + '/chat/completions';
  const maxTokens = options.maxTokens ?? 2000;
  const temperature = options.temperature ?? 0.7;

  const headers = { 'Content-Type': 'application/json' };
  if (bearer_token) {
    headers.Authorization = `Bearer ${bearer_token}`;
  } else if (api_key) {
    headers.Authorization = `Bearer ${api_key}`;
  }

  const response = await http.fetchJson(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: model_name,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature,
      max_tokens: maxTokens,
    }),
  });

  if (response.error) {
    throw new Error(response.error.message || 'LLM API error');
  }

  const content = response.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('LLM returned empty or invalid response');
  }

  return content;
}

async function callLLMWithFallback(supabase, systemPrompt, userPrompt, http, options = {}) {
  const providers = await fetchAllLLMProviders(supabase);
  const errors = [];
  for (const provider of providers) {
    try {
      const content = await callLLM(provider, systemPrompt, userPrompt, http, options);
      return { content, provider_name: provider.provider_name, model_name: provider.model_name };
    } catch (err) {
      errors.push({ provider: provider.provider_name, model: provider.model_name, error: err.message });
    }
  }
  const summary = errors.map((e) => `${e.provider}/${e.model}: ${e.error}`).join('; ');
  throw new Error(`All LLM providers failed: ${summary}`);
}

module.exports = { fetchLLMProvider, fetchAllLLMProviders, callLLM, callLLMWithFallback };
