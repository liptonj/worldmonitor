'use strict';

// AI generator: Event classifications
// Fetches events from telegram, news, and cyber Redis channels, calls LLM to classify by type,
// severity, and region. Returns hash-map keyed by FNV-1a hash of title (matches frontend
// lookupRelayClassification in threat-classifier.ts).

const { callLLMWithFallback } = require('@worldmonitor/shared/llm.cjs');
const { parseNewsFromRedis } = require('../utils/news-parse.cjs');

const MAX_EVENTS = 20;

// FNV-1a — matches fnv1aHash() in src/services/threat-classifier.ts and simpleHash() in ais-relay.cjs
function fnv1aHash(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

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

    const systemPrompt =
      'You are an intelligence analyst. Classify each event by type (cyber, military, political, economic, social, environmental), severity (low, medium, high, critical), and region (Global, Asia, Europe, Middle East, Americas, Africa). Also provide a confidence score (0-1). Output valid JSON: { "classifications": [{ "id": string|number, "type": string, "severity": string, "region": string, "confidence": number, "summary": string }] }. Preserve the id from each input event.';

    const batch = events.slice(0, MAX_EVENTS);
    const userPrompt = `Classify these events:\n\n${JSON.stringify(batch, null, 2)}`;

    const result = await callLLMWithFallback(supabase, systemPrompt, userPrompt, http, {
      temperature: 0.3,
      maxTokens: 2000,
    });
    const responseText = result.content;

    let parsed;
    try {
      parsed = JSON.parse(responseText);
    } catch (parseErr) {
      log.error('generateClassifications malformed LLM JSON', { error: parseErr.message });
      throw new Error('LLM returned invalid JSON');
    }

    const parsedClassifications = Array.isArray(parsed.classifications) ? parsed.classifications : [];
    const dateStr = new Date().toISOString().slice(0, 10);

    const classificationsMap = {};
    for (const c of parsedClassifications) {
      const event = events.find((e) => String(e.id) === String(c.id));
      if (!event) continue;

      const title = event.title ?? event.text ?? '';
      if (!title) continue;

      const hash = fnv1aHash(title.toLowerCase());
      classificationsMap[hash] = {
        level: c.severity ?? 'medium',
        category: c.type ?? 'unknown',
        title,
        generatedAt: dateStr,
      };
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
