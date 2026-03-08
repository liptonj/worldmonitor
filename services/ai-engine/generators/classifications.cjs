'use strict';

// AI generator: Event classifications
// Fetches events from telegram, news, and cyber Redis channels, calls LLM to classify by type,
// severity, and region. Returns structured classifications in worker-compatible format.

const MAX_EVENTS = 20;

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

  return {
    api_key: apiKey,
    base_url: apiUrl,
    model_name: model,
    provider_type: row.provider_type ?? 'openai',
  };
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
      temperature: 0.3,
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

module.exports = async function generateClassifications({ supabase, redis, log, http }) {
  log.debug('generateClassifications executing');

  if (!supabase || !redis || !http) {
    throw new Error('supabase, redis, and http are required');
  }

  try {
    const [telegramData, newsData, cyberData] = await Promise.all([
      redis.get('relay:telegram:v1'),
      redis.get('relay:news:full:v1'),
      redis.get('relay:cyber:v1'),
    ]);

    const events = [];

    if (telegramData?.data?.messages && Array.isArray(telegramData.data.messages)) {
      for (const m of telegramData.data.messages) {
        const text = m.text ?? m.content ?? '';
        if (text) {
          events.push({ id: m.id ?? `tg_${events.length}`, text, source: 'telegram' });
        }
      }
    }

    const newsItems = newsData?.items ?? newsData?.data ?? [];
    const newsArr = Array.isArray(newsItems) ? newsItems.slice(0, 10) : [];
    for (let i = 0; i < newsArr.length; i++) {
      const a = newsArr[i];
      const title = a.title ?? '';
      const desc = a.description ?? a.content ?? '';
      const text = title ? (desc ? `${title} - ${desc}` : title) : desc;
      if (text) {
        events.push({ id: `news_${i}`, text, source: 'news' });
      }
    }

    const cyberItems = cyberData?.data ?? cyberData?.items ?? [];
    const cyberArr = Array.isArray(cyberItems) ? cyberItems.slice(0, 10) : [];
    for (let i = 0; i < cyberArr.length; i++) {
      const c = cyberArr[i];
      const text = c.summary ?? c.title ?? c.description ?? JSON.stringify(c);
      if (text) {
        events.push({ id: `cyber_${i}`, text, source: 'cyber' });
      }
    }

    if (events.length === 0) {
      log.warn('No events found for classification');
      return {
        timestamp: new Date().toISOString(),
        source: 'ai:classifications',
        data: { classifications: [] },
        status: 'success',
      };
    }

    const provider = await fetchLLMProvider(supabase);

    const systemPrompt =
      'You are an intelligence analyst. Classify each event by type (cyber, military, political, economic, social, environmental), severity (low, medium, high, critical), and region (Global, Asia, Europe, Middle East, Americas, Africa). Also provide a confidence score (0-1). Output valid JSON: { "classifications": [{ "id": string|number, "type": string, "severity": string, "region": string, "confidence": number, "summary": string }] }. Preserve the id from each input event.';

    const batch = events.slice(0, MAX_EVENTS);
    const userPrompt = `Classify these events:\n\n${JSON.stringify(batch, null, 2)}`;

    const responseText = await callLLM(provider, systemPrompt, userPrompt, http);

    let parsed;
    try {
      parsed = JSON.parse(responseText);
    } catch (parseErr) {
      log.error('generateClassifications malformed LLM JSON', { error: parseErr.message });
      throw new Error('LLM returned invalid JSON');
    }

    const classifications = Array.isArray(parsed.classifications) ? parsed.classifications : [];

    return {
      timestamp: new Date().toISOString(),
      source: 'ai:classifications',
      data: { classifications },
      status: 'success',
    };
  } catch (err) {
    log.error('generateClassifications error', { error: err.message });
    return {
      timestamp: new Date().toISOString(),
      source: 'ai:classifications',
      data: null,
      status: 'error',
      error: err.message,
    };
  }
};
