'use strict';

const { callLLMForFunction, truncateContext } = require('@worldmonitor/shared/llm.cjs');
const { parseNewsFromRedis } = require('../utils/news-parse.cjs');

const MAX_EVENTS = 10;

function fnv1aHash(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

const FALLBACK_SYSTEM_PROMPT =
  'You are an intelligence analyst. Classify each event by type (cyber, military, political, economic, social, environmental), severity (low, medium, high, critical), and region (Global, Asia, Europe, Middle East, Americas, Africa). Also provide a confidence score (0-1). You MUST respond with ONLY valid JSON, no prose, no markdown fences, no explanation. Use this exact structure: { "classifications": [{ "id": string|number, "type": string, "severity": string, "region": string, "confidence": number, "summary": string }] }. Preserve the id from each input event.';

module.exports = async function generateClassifications({ supabase, redis, log, http }) {
  log.debug('generateClassifications executing');

  if (!supabase || !redis || !http) {
    throw new Error('supabase, redis, and http are required');
  }

  try {
    const [telegramData, newsData, cyberData] = await Promise.all([
      redis.get('relay:telegram:v1'),
      redis.get('news:digest:v1:full:en'),
      redis.get('relay:cyber:v1'),
    ]);

    const events = [];

    const messages = telegramData?.messages ?? telegramData?.data?.messages ?? [];
    if (Array.isArray(messages)) {
      for (const m of messages) {
        const text = m.text ?? m.content ?? '';
        if (text) {
          events.push({ id: m.id ?? `tg_${events.length}`, text, title: text, source: 'telegram' });
        }
      }
    }

    const newsArr = parseNewsFromRedis(newsData).slice(0, 10);
    for (let i = 0; i < newsArr.length; i++) {
      const a = newsArr[i];
      const title = a.title ?? '';
      const desc = a.description ?? a.content ?? '';
      const text = title ? (desc ? `${title} - ${desc}` : title) : desc;
      if (text) {
        events.push({ id: `news_${i}`, text, title: title || text, source: 'news' });
      }
    }

    const cyberItems = cyberData?.data?.threats ?? cyberData?.threats ?? cyberData?.data ?? cyberData?.items ?? [];
    const cyberArr = Array.isArray(cyberItems) ? cyberItems.slice(0, 10) : [];
    for (let i = 0; i < cyberArr.length; i++) {
      const c = cyberArr[i];
      const text = c.summary ?? c.title ?? c.description ?? JSON.stringify(c);
      if (text) {
        events.push({ id: `cyber_${i}`, text, title: text, source: 'cyber' });
      }
    }

    if (events.length === 0) {
      log.warn('No events found for classification');
      return {
        timestamp: new Date().toISOString(),
        source: 'ai:classifications',
        data: {},
        status: 'success',
      };
    }

    const batch = events.slice(0, MAX_EVENTS).map((e) => ({
      id: e.id,
      title: (e.title || e.text || '').slice(0, 120),
      source: e.source,
    }));
    const batchStr = truncateContext(batch, 3000);

    const result = await callLLMForFunction(
      supabase,
      'classify_event',
      'classify_event',
      { title: batchStr },
      http,
      {
        temperature: 0.3,
        maxTokens: 2000,
        fallbackSystemPrompt: FALLBACK_SYSTEM_PROMPT,
        fallbackUserPrompt: `Classify these events:\n\n${batchStr}`,
      },
    );
    const parsed = result.parsed;
    const dateStr = new Date().toISOString().slice(0, 10);
    const classificationsMap = {};

    const items = Array.isArray(parsed) ? parsed
      : Array.isArray(parsed?.classifications) ? parsed.classifications
      : null;

    if (items) {
      for (const c of items) {
        const event = events.find((e) => String(e.id) === String(c.id));
        if (!event) continue;
        const title = event.title ?? event.text ?? '';
        if (!title) continue;
        const hash = fnv1aHash(title.toLowerCase());
        classificationsMap[hash] = {
          level: c.severity ?? c.level ?? 'medium',
          category: c.type ?? c.category ?? 'unknown',
          title,
          generatedAt: dateStr,
        };
      }
    } else if (parsed && typeof parsed === 'object') {
      for (const [key, val] of Object.entries(parsed)) {
        const event = events.find((e) => String(e.id) === key);
        if (!event || typeof val !== 'object') continue;
        const title = event.title ?? event.text ?? '';
        if (!title) continue;
        const hash = fnv1aHash(title.toLowerCase());
        classificationsMap[hash] = {
          level: val.severity ?? val.level ?? 'medium',
          category: val.type ?? val.category ?? 'unknown',
          title,
          generatedAt: dateStr,
        };
      }
    }

    return {
      timestamp: new Date().toISOString(),
      source: 'ai:classifications',
      data: classificationsMap,
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
