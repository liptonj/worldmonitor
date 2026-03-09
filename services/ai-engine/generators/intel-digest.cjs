'use strict';

// AI generator: Global intelligence digest
// Aggregates news, conflict, cyber data from Redis, calls LLM, returns structured analysis

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
  // API key is optional (e.g., Ollama behind Cloudflare Access doesn't need one)
  // If secretName is null/empty, the provider doesn't require an API key

  // Fetch Cloudflare Access credentials if provider is Ollama
  let cfAccessClientId = '';
  let cfAccessClientSecret = '';
  if (providerName === 'ollama') {
    const [idResult, secretResult] = await Promise.all([
      supabase.rpc('get_vault_secret_value', { secret_name: 'OLLAMA_CF_ACCESS_CLIENT_ID' }),
      supabase.rpc('get_vault_secret_value', { secret_name: 'OLLAMA_CF_ACCESS_CLIENT_SECRET' }),
    ]);
    if (!idResult.error && idResult.data != null) {
      cfAccessClientId = String(idResult.data);
    }
    if (!secretResult.error && secretResult.data != null) {
      cfAccessClientSecret = String(secretResult.data);
    }
  }

  return {
    api_key: apiKey,
    base_url: apiUrl,
    model_name: model,
    provider_type: row.provider_type ?? 'openai',
    provider_name: providerName,
    cf_access_client_id: cfAccessClientId,
    cf_access_client_secret: cfAccessClientSecret,
  };
}

async function callLLM(provider, systemPrompt, userPrompt, http) {
  const { api_key, base_url, model_name, cf_access_client_id, cf_access_client_secret } = provider;
  const url = base_url.includes('/chat/completions') ? base_url : base_url.replace(/\/+$/, '') + '/chat/completions';

  const headers = {
    'Content-Type': 'application/json',
  };

  // Add Cloudflare Access headers if present
  if (cf_access_client_id && cf_access_client_secret) {
    headers['CF-Access-Client-Id'] = cf_access_client_id;
    headers['CF-Access-Client-Secret'] = cf_access_client_secret;
  }

  // Add Authorization header if API key is present
  if (api_key) {
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
      temperature: 0.7,
      max_tokens: 2000,
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

module.exports = async function generateIntelDigest({ supabase, redis, log, http }) {
  log.debug('generateIntelDigest executing');

  try {
    if (!supabase || !http) {
      throw new Error('supabase and http are required');
    }

    const [newsData, conflictData, cyberData] = await Promise.all([
      redis.get('news:digest:v1:full:en'),
      redis.get('relay:conflict:v1'),
      redis.get('relay:cyber:v1'),
    ]);

    const context = {
      news: newsData?.data ?? newsData?.items ?? [],
      conflict: conflictData?.data ?? conflictData?.items ?? [],
      cyber: cyberData?.data ?? cyberData?.items ?? [],
    };

    // TODO: Load prompt from wm_admin.llm_prompts via get_llm_prompt RPC
    // Falling back to this hardcoded prompt if none is found
    const systemPrompt =
      'You are an intelligence analyst. Synthesize the following data sources into a concise global intelligence digest. Focus on significant developments, emerging patterns, and potential risks. Output valid JSON with fields: summary (string), highlights (array of strings), regions (array of strings).';

    const userPrompt = `Analyze this data and create an intelligence digest:\n\n${JSON.stringify(context, null, 2)}`;

    const provider = await fetchLLMProvider(supabase);
    const responseText = await callLLM(provider, systemPrompt, userPrompt, http);

    const parsed = JSON.parse(responseText);
    const summary = parsed.summary ?? '';
    const highlights = Array.isArray(parsed.highlights) ? parsed.highlights : [];
    const regions = Array.isArray(parsed.regions) ? parsed.regions : [];

    const digest = [
      summary,
      highlights.length ? `\n\n## Highlights\n${highlights.map((h) => `- ${h}`).join('\n')}` : '',
      regions.length ? `\n\n## Regions\n${regions.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('');

    return {
      timestamp: new Date().toISOString(),
      source: 'ai:intel-digest',
      data: {
        digest,
        summary,
        highlights,
        regions,
        model: provider.model_name,
        provider: provider.provider_type || 'openai',
        generatedAt: new Date().toISOString(),
      },
      status: 'success',
    };
  } catch (err) {
    log.error('generateIntelDigest error', { error: err.message });
    return {
      timestamp: new Date().toISOString(),
      source: 'ai:intel-digest',
      data: null,
      status: 'error',
      error: err.message,
    };
  }
};
