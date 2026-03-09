'use strict';

// AI generator: Military/strategic posture analysis
// Fetches strategic-posture, conflict, military data from Redis, calls LLM to analyze postures.
// Frontend: StrategicPosturePanel.applyAiAnalysis(payload) — expects { analyses: [...] } or worker format.
// Relay broadcasts full { timestamp, source, data, status }; data.analyses is the array.

const REDIS_KEYS = ['relay:strategic-posture:v1', 'relay:conflict:v1', 'relay:opensky:v1'];

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
      temperature: 0.4,
      max_tokens: 2500,
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

module.exports = async function generatePostureAnalysis({ supabase, redis, log, http }) {
  if (!supabase || !redis || !http) {
    throw new Error('supabase, redis, and http are required');
  }

  log.debug('generatePostureAnalysis executing');

  try {
    const [postureData, conflictData, openskyData] = await Promise.all(
      REDIS_KEYS.map((k) => redis.get(k))
    );

    const theaters = postureData?.theaters ?? postureData?.postures ?? postureData?.data ?? [];
    const theaterArr = Array.isArray(theaters) ? theaters.slice(0, 15) : [];
    const conflictItems = conflictData?.data ?? conflictData?.events ?? [];
    const conflictArr = Array.isArray(conflictItems) ? conflictItems.slice(0, 20) : [];
    const flights = openskyData?.flights ?? openskyData?.data ?? [];
    const flightArr = Array.isArray(flights) ? flights.slice(0, 30) : [];

    const context = {
      theaters: theaterArr.map((t) => ({ name: t.name ?? t.theaterName, level: t.postureLevel ?? t.level, aircraft: t.totalAircraft ?? t.aircraft, vessels: t.totalVessels ?? t.vessels })),
      conflict: conflictArr.map((c) => ({ country: c.country ?? c.actor1, event: c.event_type, location: c.location })),
      flights: flightArr.map((f) => ({ origin: f.origin_country, dest: f.destination_country ?? f.country, type: f.icao24 ?? f.callsign })),
    };

    if (theaterArr.length === 0 && conflictArr.length === 0) {
      log.warn('No posture or conflict data for analysis');
      return {
        timestamp: new Date().toISOString(),
        source: 'ai:posture-analysis',
        data: { analyses: [] },
        status: 'success',
      };
    }

    const provider = await fetchLLMProvider(supabase);

    const systemPrompt =
      'You are a military intelligence analyst. Analyze military and strategic postures from the data. Identify key actors, their capabilities, intentions, and force deployments. Output valid JSON: { "analyses": [{ "actor", "posture", "capabilities", "intentions", "locations" }] }.';

    const userPrompt = `Analyze military postures:\n\n${JSON.stringify(context, null, 2)}`;

    const responseText = await callLLM(provider, systemPrompt, userPrompt, http);

    let parsed;
    try {
      parsed = JSON.parse(responseText);
    } catch (parseErr) {
      log.error('generatePostureAnalysis malformed LLM JSON', { error: parseErr.message });
      throw new Error('LLM returned invalid JSON');
    }

    const analyses = Array.isArray(parsed.analyses) ? parsed.analyses : [];

    return {
      timestamp: new Date().toISOString(),
      source: 'ai:posture-analysis',
      data: { analyses },
      status: 'success',
    };
  } catch (err) {
    log.error('generatePostureAnalysis error', { error: err.message });
    return {
      timestamp: new Date().toISOString(),
      source: 'ai:posture-analysis',
      data: null,
      status: 'error',
      error: err.message,
    };
  }
};
