'use strict';

// AI generator: Dashboard panel summary
// Aggregates data from multiple panels (news, telegram, markets, strategic-risk, cyber, conflict, natural)
// into an executive summary. Follows intel-digest pattern.

const REDIS_KEYS = [
  'relay:news:full:v1',
  'relay:telegram:v1',
  'relay:markets:v1',
  'relay:strategic-risk:v1',
  'relay:cyber:v1',
  'relay:conflict:v1',
  'relay:natural:v1',
];

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
  // API key is optional (e.g., Ollama behind LiteLLM proxy doesn't need one)
  // If secretName is null/empty, the provider doesn't require an API key

  // Fetch Bearer token if provider is Ollama
  let bearerToken = '';
  if (providerName === 'ollama') {
    const tokenResult = await supabase.rpc('get_vault_secret_value', { secret_name: 'OLLAMA_BEARER_TOKEN' });
    if (!tokenResult.error && tokenResult.data != null) {
      bearerToken = String(tokenResult.data);
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

async function callLLM(provider, systemPrompt, userPrompt, http) {
  const { api_key, base_url, model_name, bearer_token } = provider;
  const url = base_url.includes('/chat/completions') ? base_url : base_url.replace(/\/+$/, '') + '/chat/completions';

  const headers = {
    'Content-Type': 'application/json',
  };

  // Add Bearer token if present (Ollama via LiteLLM proxy)
  if (bearer_token) {
    headers.Authorization = `Bearer ${bearer_token}`;
  }
  // Otherwise, add standard API key if present
  else if (api_key) {
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

module.exports = async function generatePanelSummary({ supabase, redis, log, http }) {
  log.debug('generatePanelSummary executing');

  try {
    if (!supabase || !http) {
      throw new Error('supabase and http are required');
    }

    const results = await Promise.all(REDIS_KEYS.map((key) => redis.get(key)));

    const context = {};
    const keyLabels = [
      'news',
      'telegram',
      'markets',
      'strategicRisk',
      'cyber',
      'conflict',
      'natural',
    ];
    for (let i = 0; i < REDIS_KEYS.length; i++) {
      const raw = results[i];
      const label = keyLabels[i];
      if (raw != null) {
        context[label] = raw?.data ?? raw?.items ?? raw;
      }
    }

    const systemPrompt =
      'You are an intelligence analyst creating an executive summary from global intelligence panels. Synthesize all data sources into a concise, actionable intelligence summary. Focus on significant developments, emerging patterns, cross-domain correlations, and critical risks. Output valid JSON with fields: summary (string), keyEvents (array of strings), riskLevel (string: \'low\'|\'medium\'|\'high\'|\'critical\').';

    const userPrompt = `Analyze this panel data and create an executive summary:\n\n${JSON.stringify(context, null, 2)}`;

    const provider = await fetchLLMProvider(supabase);
    const responseText = await callLLM(provider, systemPrompt, userPrompt, http);

    const parsed = JSON.parse(responseText);
    const summary = parsed.summary ?? '';
    const keyEvents = Array.isArray(parsed.keyEvents) ? parsed.keyEvents : [];
    const riskLevel = ['low', 'medium', 'high', 'critical'].includes(parsed.riskLevel)
      ? parsed.riskLevel
      : 'medium';

    const contextSources = Object.keys(context).filter((k) => context[k] != null).length;

    return {
      timestamp: new Date().toISOString(),
      source: 'ai:panel-summary',
      data: {
        summary,
        keyEvents,
        riskLevel,
        generatedAt: new Date().toISOString(),
        contextSources,
      },
      status: 'success',
    };
  } catch (err) {
    log.error('generatePanelSummary error', { error: err.message });
    return {
      timestamp: new Date().toISOString(),
      source: 'ai:panel-summary',
      data: null,
      status: 'error',
      error: err.message,
    };
  }
};
