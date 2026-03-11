'use strict';

// AI generator: Regional instability assessment
// Fetches conflict, political, economic data from Redis, calls LLM to assess instability.
// Supports incremental: skips LLM when inputs unchanged.

const { callLLMForFunction, truncateContext } = require('@worldmonitor/shared/llm.cjs');
const { parseNewsFromRedis } = require('../utils/news-parse.cjs');

const REDIS_KEYS = ['relay:conflict:v1', 'risk:scores:sebuf:v1', 'news:digest:v1:full:en'];

module.exports = async function generateInstabilityAnalysis({ supabase, redis, log, http }) {
  if (!supabase || !redis || !http) {
    throw new Error('supabase, redis, and http are required');
  }

  log.debug('generateInstabilityAnalysis executing');

  try {
    const previousKeys = REDIS_KEYS.map((k) => `${k}:previous`);
    const [previousOutput, ...currentResults] = await Promise.all([
      redis.get('ai:instability-analysis:v1'),
      ...REDIS_KEYS.map((k) => redis.get(k)),
      ...previousKeys.map((k) => redis.get(k)),
    ]);
    const currentData = currentResults.slice(0, REDIS_KEYS.length);
    const previousData = currentResults.slice(REDIS_KEYS.length);

    const contextStr = JSON.stringify(currentData);
    const previousContextStr = JSON.stringify(previousData);
    const inputsUnchanged = contextStr === previousContextStr;
    const previousRegions =
      previousOutput?.source === 'ai:instability-analysis' && previousOutput?.status === 'success'
        ? (previousOutput?.data?.regions ?? previousOutput?.regions ?? [])
        : [];
    const hasPreviousRegions = Array.isArray(previousRegions) && previousRegions.length > 0;

    if (inputsUnchanged && hasPreviousRegions) {
      log.info('Instability analysis inputs unchanged, keeping previous output');
      return previousOutput;
    }

    const [conflictData, riskData, newsData] = currentData;

    const conflictItems = conflictData?.data?.events ?? conflictData?.data ?? conflictData?.events ?? [];
    const conflictArr = Array.isArray(conflictItems) ? conflictItems.slice(0, 30) : [];
    const riskItems = riskData?.ciiScores ?? riskData?.data ?? [];
    const riskArr = Array.isArray(riskItems) ? riskItems.slice(0, 20) : [];
    const newsArr = parseNewsFromRedis(newsData).slice(0, 15);

    const context = {
      conflict: conflictArr.map((c) => ({ country: c.country ?? c.actor1, event: c.event_type ?? c.sub_event_type, fatalities: c.fatalities, date: c.event_date })),
      risk: riskArr.map((r) => ({ country: r.country ?? r.code, score: r.score ?? r.cii, level: r.level })),
      news: newsArr.map((n) => ({ title: n.title, source: n.source, description: (n.description ?? n.content ?? '').slice(0, 200) })),
    };

    if (conflictArr.length === 0 && newsArr.length === 0) {
      log.warn('No conflict or news data for instability analysis');
      return {
        timestamp: new Date().toISOString(),
        source: 'ai:instability-analysis',
        data: { regions: [] },
        status: 'success',
      };
    }

    const dateStr = new Date().toISOString().slice(0, 10);
    const countryData = truncateContext(context);
    const fallbackSystemPrompt =
      'You MUST respond with ONLY valid JSON, no prose, no markdown fences, no explanation. Use this exact structure: { "regions": [{ "region", "level", "drivers", "countries", "trajectory" }] }.';
    const fallbackUserPrompt = hasPreviousRegions
      ? `Here is the previous instability analysis:\n${JSON.stringify(previousRegions, null, 2)}\n\nHere is the updated data. Update the analysis to reflect any changes:\n${countryData}`
      : `Assess regional instability:\n\n${countryData}`;

    const result = await callLLMForFunction(
      supabase,
      'instability_analysis',
      'country_instability_analysis',
      { date: dateStr, countryData },
      http,
      {
        temperature: 0.4,
        maxTokens: 2500,
        fallbackSystemPrompt,
        fallbackUserPrompt,
      },
    );

    const parsed = result.parsed;
    if (!parsed) {
      log.error('generateInstabilityAnalysis missing parsed result');
      throw new Error('LLM returned invalid JSON');
    }
    const regions = Array.isArray(parsed.regions) ? parsed.regions : [];

    return {
      timestamp: new Date().toISOString(),
      source: 'ai:instability-analysis',
      data: { regions },
      status: 'success',
    };
  } catch (err) {
    log.error('generateInstabilityAnalysis error', { error: err.message });
    return {
      timestamp: new Date().toISOString(),
      source: 'ai:instability-analysis',
      data: null,
      status: 'error',
      error: err.message,
    };
  }
};
