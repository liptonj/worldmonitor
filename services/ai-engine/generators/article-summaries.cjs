'use strict';

const { callLLMForFunction } = require('@worldmonitor/shared/llm.cjs');
const { parseNewsFromRedis } = require('../utils/news-parse.cjs');

const REDIS_NEWS_KEY = 'news:digest:v1:full:en';

function fnv1aHash(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

const MAX_ARTICLES = 10;

const FALLBACK_SYSTEM_PROMPT =
  'You are a skilled content summarizer. For each article provided, create a concise summary (2-3 sentences) and extract 3-5 key points. You MUST respond with ONLY valid JSON, no prose, no markdown fences, no explanation. Use this exact structure: { "summaries": [{ "url": string, "title": string, "summary": string, "keyPoints": string[] }] }. Preserve the exact url and title from each input article.';

module.exports = async function generateArticleSummaries({ supabase, redis, log, http }) {
  if (!supabase || !redis || !http) {
    throw new Error('supabase, redis, and http are required');
  }

  log.debug('generateArticleSummaries executing');

  try {
    const newsData = await redis.get(REDIS_NEWS_KEY);
    const articles = parseNewsFromRedis(newsData);

    if (articles.length === 0) {
      log.warn('No articles found for summarization');
      return {
        timestamp: new Date().toISOString(),
        source: 'ai:article-summaries',
        data: {},
        status: 'success',
      };
    }

    const batch = articles.slice(0, MAX_ARTICLES).map((a) => ({
      title: a.title ?? '',
      url: a.url ?? a.link ?? '',
      text: a.description ?? a.content ?? '',
    }));

    const result = await callLLMForFunction(
      supabase,
      'news_summary',
      'news_summary',
      { articles: JSON.stringify(batch, null, 2) },
      http,
      {
        temperature: 0.5,
        maxTokens: 3000,
        fallbackSystemPrompt: FALLBACK_SYSTEM_PROMPT,
        fallbackUserPrompt: `Summarize these articles:\n\n${JSON.stringify(batch, null, 2)}`,
      },
    );
    const parsed = result.parsed;

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
