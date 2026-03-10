'use strict';

// AI generator: Regional instability assessment
// Fetches conflict, political, economic data from Redis, calls LLM to assess instability.
// Supports incremental: skips LLM when inputs unchanged.

const { callLLMWithFallback } = require('@worldmonitor/shared/llm.cjs');
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

    const systemPrompt =
      'You are a geopolitical risk analyst. Assess regional instability from the data. For each region, identify: instability level (low/medium/high/critical), primary drivers, affected countries, trajectory (stable/increasing/decreasing). Output valid JSON: { "regions": [{ "region", "level", "drivers", "countries", "trajectory" }] }.';

    const userPrompt = hasPreviousRegions
      ? `Here is the previous instability analysis:\n${JSON.stringify(previousRegions, null, 2)}\n\nHere is the updated data. Update the analysis to reflect any changes:\n${JSON.stringify(context, null, 2)}`
      : `Assess regional instability:\n\n${JSON.stringify(context, null, 2)}`;

    const result = await callLLMWithFallback(supabase, systemPrompt, userPrompt, http, {
      temperature: 0.4,
      maxTokens: 2500,
    });
    const responseText = result.content;

    let parsed;
    try {
      parsed = JSON.parse(responseText);
    } catch (parseErr) {
      log.error('generateInstabilityAnalysis malformed LLM JSON', { error: parseErr.message });
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
