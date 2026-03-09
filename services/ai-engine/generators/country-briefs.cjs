'use strict';

// AI generator: Country intelligence briefs
// Fetches news, strategic-risk, conflict from Redis, calls LLM to generate briefs per country.
// Frontend format: country-intel.ts expects Record<countryCode, { brief?: string }> for relayBriefs[code].brief.
// Relay broadcasts full { timestamp, source, data, status }; frontend may use payload.data for lookups.

const REDIS_KEYS = ['relay:news:full:v1', 'relay:strategic-risk:v1', 'relay:conflict:v1'];

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
      temperature: 0.5,
      max_tokens: 3000,
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

module.exports = async function generateCountryBriefs({ supabase, redis, log, http }) {
  if (!supabase || !redis || !http) {
    throw new Error('supabase, redis, and http are required');
  }

  log.debug('generateCountryBriefs executing');

  try {
    const [newsData, riskData, conflictData] = await Promise.all(
      REDIS_KEYS.map((k) => redis.get(k))
    );

    const newsItems = newsData?.items ?? newsData?.data ?? [];
    const newsArr = Array.isArray(newsItems) ? newsItems.slice(0, 15) : [];
    const riskItems = riskData?.ciiScores ?? riskData?.data ?? [];
    const conflictItems = conflictData?.data ?? conflictData?.events ?? [];
    const conflictArr = Array.isArray(conflictItems) ? conflictItems.slice(0, 20) : [];

    const context = {
      news: newsArr.map((a) => ({ title: a.title, description: a.description ?? a.content ?? '', source: a.source })),
      risk: Array.isArray(riskItems) ? riskItems : [],
      conflict: conflictArr.map((c) => ({ country: c.country ?? c.actor1, event: c.event_type ?? c.sub_event_type, date: c.event_date })),
    };

    if (newsArr.length === 0 && conflictArr.length === 0) {
      log.warn('No significant data for country briefs');
      return {
        timestamp: new Date().toISOString(),
        source: 'ai:country-briefs',
        data: {},
        status: 'success',
      };
    }

    const provider = await fetchLLMProvider(supabase);

    const systemPrompt =
      'You are an intelligence analyst. Generate intelligence briefs for each country with significant activity in the data. For each country include: country name, ISO 3166-1 alpha-2 code (e.g. US, RU, CN), brief summary (2-4 sentences), key developments, risk level (low/medium/high/critical). Output valid JSON: { "briefs": [{ "country", "code", "summary", "developments", "riskLevel" }] }. Use standard ISO 2-letter country codes.';

    const userPrompt = `Generate country briefs from this data:\n\n${JSON.stringify(context, null, 2)}`;

    const responseText = await callLLM(provider, systemPrompt, userPrompt, http);

    let parsed;
    try {
      parsed = JSON.parse(responseText);
    } catch (parseErr) {
      log.error('generateCountryBriefs malformed LLM JSON', { error: parseErr.message });
      throw new Error('LLM returned invalid JSON');
    }

    const briefs = Array.isArray(parsed.briefs) ? parsed.briefs : [];
    const briefsMap = {};
    for (const b of briefs) {
      const code = (b.code ?? b.country ?? '').toString().toUpperCase().slice(0, 2);
      if (!code) continue;
      const summary = b.summary ?? '';
      const developments = Array.isArray(b.developments) ? b.developments : (b.developments ? [b.developments] : []);
      const brief = [summary, developments.length ? `Key developments: ${developments.join('; ')}` : ''].filter(Boolean).join('\n\n');
      briefsMap[code] = { brief };
    }

    return {
      timestamp: new Date().toISOString(),
      source: 'ai:country-briefs',
      data: briefsMap,
      status: 'success',
    };
  } catch (err) {
    log.error('generateCountryBriefs error', { error: err.message });
    return {
      timestamp: new Date().toISOString(),
      source: 'ai:country-briefs',
      data: null,
      status: 'error',
      error: err.message,
    };
  }
};
