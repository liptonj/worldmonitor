'use strict';

// AI generator: Article summarization
// Fetches articles from relay:news:full:v1, calls LLM to generate summaries and key points per article.
// Returns hash-map keyed by FNV-1a hash of title (matches frontend lookupRelaySummary expectations).

const REDIS_NEWS_KEY = 'relay:news:full:v1';

// FNV-1a — matches fnv1aHash() in src/services/summarization.ts and simpleHash() in ais-relay.cjs
function fnv1aHash(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(36);
}
const MAX_ARTICLES = 10;

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

module.exports = async function generateArticleSummaries({ supabase, redis, log, http }) {
  if (!supabase || !redis || !http) {
    throw new Error('supabase, redis, and http are required');
  }

  log.debug('generateArticleSummaries executing');

  try {
    const newsData = await redis.get(REDIS_NEWS_KEY);
    const items = newsData?.items ?? newsData?.data ?? [];
    const articles = Array.isArray(items) ? items : [];

    if (articles.length === 0) {
      log.warn('No articles found for summarization');
      return {
        timestamp: new Date().toISOString(),
        source: 'ai:article-summaries',
        data: {},
        status: 'success',
      };
    }

    const provider = await fetchLLMProvider(supabase);

    const systemPrompt =
      'You are a skilled content summarizer. For each article provided, create a concise summary (2-3 sentences) and extract 3-5 key points. Output valid JSON with structure: { "summaries": [{ "url": string, "title": string, "summary": string, "keyPoints": string[] }] }. Preserve the exact url and title from each input article.';

    const batch = articles.slice(0, MAX_ARTICLES).map((a) => ({
      title: a.title ?? '',
      url: a.url ?? a.link ?? '',
      text: a.description ?? a.content ?? '',
    }));

    const userPrompt = `Summarize these articles:\n\n${JSON.stringify(batch, null, 2)}`;

    const responseText = await callLLM(provider, systemPrompt, userPrompt, http);

    let parsed;
    try {
      parsed = JSON.parse(responseText);
    } catch (parseErr) {
      log.error('generateArticleSummaries malformed LLM JSON', { error: parseErr.message });
      throw new Error('LLM returned invalid JSON');
    }

    const summaries = Array.isArray(parsed.summaries) ? parsed.summaries : [];
    const dateStr = new Date().toISOString().slice(0, 10);

    const summariesMap = {};
    for (const s of summaries) {
      const title = s.title ?? '';
      if (!title) continue;
      const hash = fnv1aHash(title.toLowerCase());
      summariesMap[hash] = {
        text: s.summary ?? '',
        title,
        generatedAt: dateStr,
      };
    }

    return {
      timestamp: new Date().toISOString(),
      source: 'ai:article-summaries',
      data: summariesMap,
      status: 'success',
    };
  } catch (err) {
    log.error('generateArticleSummaries error', { error: err.message });
    return {
      timestamp: new Date().toISOString(),
      source: 'ai:article-summaries',
      data: null,
      status: 'error',
      error: err.message,
    };
  }
};
