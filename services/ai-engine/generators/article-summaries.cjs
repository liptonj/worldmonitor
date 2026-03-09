'use strict';

// AI generator: Article summarization
// Fetches articles from relay:news:full:v1, calls LLM to generate summaries and key points per article.
// Returns hash-map keyed by FNV-1a hash of title (matches frontend lookupRelaySummary expectations).

const { fetchLLMProvider, callLLM } = require('@worldmonitor/shared/llm.cjs');

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

    const responseText = await callLLM(provider, systemPrompt, userPrompt, http, {
  temperature: 0.5,
  maxTokens: 3000,
});

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
