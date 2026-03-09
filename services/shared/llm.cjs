'use strict';

/**
 * Shared LLM provider resolution and API call logic for ai-engine generators.
 */

async function fetchLLMProvider(supabase) {
  const { data: providerRows, error: providerError } = await supabase.rpc('get_active_llm_provider');
  if (providerError || !providerRows || providerRows.length === 0) {
    throw new Error('No active LLM provider found');
  }
  const row = providerRows[0];
  const apiUrl = row.api_url ?? '';
  const model = row.default_model ?? '';
  const secretName = row.api_key_secret_name ?? '';
  const providerName = row.name ?? 'unknown';

  let apiKey = '';
  if (secretName) {
    const { data: secretData, error: secretError } = await supabase.rpc('get_vault_secret_value', {
      secret_name: secretName,
    });
    if (!secretError && secretData != null) {
      apiKey = String(secretData);
    }
  }
  if (!apiKey && secretName) {
    apiKey = process.env[secretName] ?? '';
  }

  let bearerToken = '';
  if (providerName.toLowerCase() === 'ollama') {
    const tokenResult = await supabase.rpc('get_vault_secret_value', { secret_name: 'OLLAMA_BEARER_TOKEN' });
    if (!tokenResult.error && tokenResult.data != null) {
      bearerToken = String(tokenResult.data);
    }
    if (!bearerToken) {
      bearerToken = process.env.OLLAMA_BEARER_TOKEN ?? '';
    }
  }

  return {
    api_key: apiKey,
    base_url: apiUrl,
    model_name: model,
    provider_type: row.provider_type ?? 'openai',
    provider_name: providerName,
    bearer_token: bearerToken,
  };
}

async function callLLM(provider, systemPrompt, userPrompt, http, options = {}) {
  const { api_key, base_url, model_name, bearer_token } = provider;
  const url = base_url.includes('/chat/completions') ? base_url : base_url.replace(/\/+$/, '') + '/chat/completions';
  const maxTokens = options.maxTokens ?? 2000;
  const temperature = options.temperature ?? 0.7;

  const headers = {
    'Content-Type': 'application/json',
  };

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

module.exports = { fetchLLMProvider, callLLM };
