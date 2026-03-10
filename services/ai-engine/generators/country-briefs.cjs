'use strict';

// AI generator: Country intelligence briefs
// Fetches news, strategic-risk, conflict from Redis, calls LLM to generate briefs per country.
// Supports incremental: skips LLM when inputs unchanged.

const { callLLMWithFallback } = require('@worldmonitor/shared/llm.cjs');
const { parseNewsFromRedis } = require('../utils/news-parse.cjs');

const REDIS_KEYS = ['news:digest:v1:full:en', 'risk:scores:sebuf:v1', 'relay:conflict:v1'];

module.exports = async function generateCountryBriefs({ supabase, redis, log, http }) {
  if (!supabase || !redis || !http) {
    throw new Error('supabase, redis, and http are required');
  }

  log.debug('generateCountryBriefs executing');

  try {
    const previousKeys = REDIS_KEYS.map((k) => `${k}:previous`);
    const [previousOutput, ...currentResults] = await Promise.all([
      redis.get('ai:country-briefs:v1'),
      ...REDIS_KEYS.map((k) => redis.get(k)),
      ...previousKeys.map((k) => redis.get(k)),
    ]);
    const currentData = currentResults.slice(0, REDIS_KEYS.length);
    const previousData = currentResults.slice(REDIS_KEYS.length);

    const contextStr = JSON.stringify(currentData);
    const previousContextStr = JSON.stringify(previousData);
    const inputsUnchanged = contextStr === previousContextStr;
    const previousBriefs =
      previousOutput?.source === 'ai:country-briefs' && previousOutput?.status === 'success'
        ? (previousOutput?.data ?? previousOutput)
        : null;
    const hasPreviousBriefs = previousBriefs && typeof previousBriefs === 'object' && Object.keys(previousBriefs).length > 0;

    if (inputsUnchanged && hasPreviousBriefs) {
      log.info('Country briefs inputs unchanged, keeping previous output');
      return previousOutput;
    }

    const [newsData, riskData, conflictData] = currentData;

    const newsArr = parseNewsFromRedis(newsData).slice(0, 15);
    const riskItems = riskData?.ciiScores ?? riskData?.data ?? [];
    const conflictItems = conflictData?.data?.events ?? conflictData?.data ?? conflictData?.events ?? [];
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

    const systemPrompt =
      'You are an intelligence analyst. Generate intelligence briefs for each country with significant activity in the data. For each country include: country name, ISO 3166-1 alpha-2 code (e.g. US, RU, CN), brief summary (2-4 sentences), key developments, risk level (low/medium/high/critical). Output valid JSON: { "briefs": [{ "country", "code", "summary", "developments", "riskLevel" }] }. Use standard ISO 2-letter country codes.';

    const previousBriefsStr = hasPreviousBriefs ? JSON.stringify(previousBriefs, null, 2) : '';
    const userPrompt = hasPreviousBriefs
      ? `Here are the previous country briefs:\n${previousBriefsStr}\n\nHere is the updated data. Update the briefs to reflect any changes:\n${JSON.stringify(context, null, 2)}`
      : `Generate country briefs from this data:\n\n${JSON.stringify(context, null, 2)}`;

    const result = await callLLMWithFallback(supabase, systemPrompt, userPrompt, http, {
      temperature: 0.5,
      maxTokens: 3000,
    });
    const responseText = result.content;

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
