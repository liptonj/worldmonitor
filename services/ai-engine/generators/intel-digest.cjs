'use strict';

// AI generator: Global intelligence digest
// Aggregates news, conflict, cyber data from Redis, calls LLM, returns structured analysis
// Supports incremental: reads previous output and news snapshot, skips LLM when unchanged.

const { callLLMWithFallback } = require('@worldmonitor/shared/llm.cjs');
const { parseNewsFromRedis } = require('../utils/news-parse.cjs');

const MAX_CONTEXT_CHARS = 8_000;

function summariseItems(items, limit) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, limit).map((item) => {
    if (typeof item === 'string') return item.slice(0, 200);
    const title = item.title || item.headline || item.summary || item.text || '';
    const source = item.source || item.feed || '';
    const ts = item.ts || item.date || item.publishedAt || '';
    return [title.slice(0, 150), source, ts].filter(Boolean).join(' | ');
  });
}

function itemTitle(item) {
  if (typeof item === 'string') return item.slice(0, 200);
  return item?.title || item?.headline || item?.summary || item?.text || '';
}

module.exports = async function generateIntelDigest({ supabase, redis, log, http }) {
  log.debug('generateIntelDigest executing');

  try {
    if (!supabase || !http) {
      throw new Error('supabase and http are required');
    }

    const [newsData, previousNewsData, previousDigestRaw, conflictData, cyberData] = await Promise.all([
      redis.get('news:digest:v1:full:en'),
      redis.get('news:digest:v1:full:en:previous'),
      redis.get('ai:digest:global:v1'),
      redis.get('relay:conflict:v1'),
      redis.get('relay:cyber:v1'),
    ]);

    const rawNews = parseNewsFromRedis(newsData);
    let previousSummary = null;
    const previousTitles = new Set();
    if (previousDigestRaw) {
      try {
        const parsed = typeof previousDigestRaw === 'string' ? JSON.parse(previousDigestRaw) : previousDigestRaw;
        const data = parsed?.data ?? parsed;
        previousSummary = data?.digest || data?.summary || parsed?.digest || parsed?.summary || null;
      } catch (_) {}
    }
    if (previousNewsData) {
      try {
        const prevItems = parseNewsFromRedis(previousNewsData);
        for (const i of prevItems) {
          const t = itemTitle(i);
          if (t) previousTitles.add(t);
        }
      } catch (_) {}
    }

    const newItems = rawNews.filter((i) => {
      const t = itemTitle(i);
      return t && !previousTitles.has(t);
    });

    if (newItems.length === 0 && previousSummary) {
      const prev = typeof previousDigestRaw === 'string' ? JSON.parse(previousDigestRaw) : previousDigestRaw;
      if (prev?.source === 'ai:intel-digest' && prev?.status === 'success') {
        log.info('No new items since last digest, keeping previous output');
        return prev;
      }
    }

    const conflictItems = conflictData?.data?.events ?? conflictData?.data ?? conflictData?.events ?? [];
    const conflictArr = Array.isArray(conflictItems) ? conflictItems.slice(0, 20) : [];
    const rawCyber = cyberData?.data?.threats ?? cyberData?.threats ?? cyberData?.data ?? cyberData?.items ?? [];
    const rawCyberArr = Array.isArray(rawCyber) ? rawCyber : [];

    const context = {
      news: summariseItems(rawNews, 25),
      conflict: summariseItems(conflictArr, 15),
      cyber: summariseItems(rawCyberArr, 10),
    };

    let contextStr = JSON.stringify(context);
    if (contextStr.length > MAX_CONTEXT_CHARS) {
      context.news = context.news.slice(0, 15);
      context.conflict = context.conflict.slice(0, 10);
      context.cyber = context.cyber.slice(0, 5);
      contextStr = JSON.stringify(context);
    }
    if (contextStr.length > MAX_CONTEXT_CHARS) {
      contextStr = contextStr.slice(0, MAX_CONTEXT_CHARS);
    }

    const systemPrompt =
      'You are an intelligence analyst. Synthesize the following data sources into a concise global intelligence digest. Focus on significant developments, emerging patterns, and potential risks. Output valid JSON with fields: summary (string), highlights (array of strings), regions (array of strings).';

    const userPrompt = previousSummary
      ? `Here is the previous intelligence digest:\n${previousSummary}\n\nHere are ${newItems.length} new developments since then. Update the digest to incorporate them:\n${JSON.stringify(summariseItems(newItems, 25))}`
      : `Analyze this data and create an intelligence digest:\n\n${contextStr}`;

    const result = await callLLMWithFallback(supabase, systemPrompt, userPrompt, http);
    log.info('intel-digest LLM succeeded', { provider: result.provider_name, model: result.model_name });

    const parsed = JSON.parse(result.content);
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
        model: result.model_name,
        provider: result.provider_name,
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
