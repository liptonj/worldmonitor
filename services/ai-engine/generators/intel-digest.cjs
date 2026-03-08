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

  let apiKey = '';
  if (secretName) {
    const { data: secretData, error: secretError } = await supabase.rpc('get_vault_secret_value', {
      secret_name: secretName,
    });
    if (!secretError && secretData != null) {
      apiKey = String(secretData);
    }
  }
  if (!apiKey) {
    apiKey = process.env[secretName] ?? '';
  }
  if (!apiKey) {
    throw new Error(`Could not resolve API key for provider ${row.name ?? 'unknown'}`);
  }

  return { api_key: apiKey, base_url: apiUrl, model_name: model };
}

async function callLLM(provider, systemPrompt, userPrompt, http) {
  const { api_key, base_url, model_name } = provider;
  const url = base_url.includes('/chat/completions') ? base_url : base_url.replace(/\/+$/, '') + '/chat/completions';

  const response = await http.fetchJson(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${api_key}`,
    },
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

  return response.choices[0].message.content;
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

    const systemPrompt =
      'You are an intelligence analyst. Synthesize the following data sources into a concise global intelligence digest. Focus on significant developments, emerging patterns, and potential risks. Output valid JSON with fields: summary (string), highlights (array of strings), regions (array of strings).';

    const userPrompt = `Analyze this data and create an intelligence digest:\n\n${JSON.stringify(context, null, 2)}`;

    const provider = await fetchLLMProvider(supabase);
    const responseText = await callLLM(provider, systemPrompt, userPrompt, http);

    const parsed = JSON.parse(responseText);

    return {
      timestamp: new Date().toISOString(),
      source: 'ai:intel-digest',
      data: parsed,
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
