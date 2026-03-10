'use strict';

// AI generator: Comprehensive risk overview across all domains
// Aggregates news, conflict, cyber, strategic-risk, strategic-posture from Redis.
// Supports incremental: skips LLM when inputs unchanged.

const { callLLMWithFallback } = require('@worldmonitor/shared/llm.cjs');
const { parseNewsFromRedis } = require('../utils/news-parse.cjs');

const REDIS_KEYS = [
  'news:digest:v1:full:en',
  'relay:conflict:v1',
  'relay:cyber:v1',
  'risk:scores:sebuf:v1',
  'theater-posture:sebuf:v1',
];

module.exports = async function generateRiskOverview({ supabase, redis, log, http }) {
  if (!supabase || !redis || !http) {
    throw new Error('supabase, redis, and http are required');
  }

  log.debug('generateRiskOverview executing');

  try {
    const previousKeys = REDIS_KEYS.map((k) => `${k}:previous`);
    const [previousOutput, ...currentResults] = await Promise.all([
      redis.get('ai:risk-overview:v1'),
      ...REDIS_KEYS.map((k) => redis.get(k)),
      ...previousKeys.map((k) => redis.get(k)),
    ]);
    const currentData = currentResults.slice(0, REDIS_KEYS.length);
    const previousData = currentResults.slice(REDIS_KEYS.length);

    const contextStr = JSON.stringify(currentData);
    const previousContextStr = JSON.stringify(previousData);
    const inputsUnchanged = contextStr === previousContextStr;
    const previousOverview =
      previousOutput?.source === 'ai:risk-overview' && previousOutput?.status === 'success'
        ? (previousOutput?.data?.overview ?? previousOutput?.overview ?? null)
        : null;

    if (inputsUnchanged && previousOverview) {
      log.info('Risk overview inputs unchanged, keeping previous output');
      return previousOutput;
    }

    const [newsData, conflictData, cyberData, riskData, postureData] = currentData;

    const newsArr = parseNewsFromRedis(newsData).slice(0, 15);
    const conflictItems = conflictData?.data?.events ?? conflictData?.data ?? conflictData?.events ?? [];
    const conflictArr = Array.isArray(conflictItems) ? conflictItems.slice(0, 20) : [];
    const cyberItems = cyberData?.data?.threats ?? cyberData?.threats ?? cyberData?.data ?? [];
    const cyberArr = Array.isArray(cyberItems) ? cyberItems.slice(0, 10) : [];
    const riskItems = riskData?.ciiScores ?? riskData?.strategicRisks ?? riskData?.data ?? [];
    const riskArr = Array.isArray(riskItems) ? riskItems.slice(0, 15) : [];
    const postureItems = postureData?.theaters ?? postureData?.postures ?? postureData?.data ?? [];
    const postureArr = Array.isArray(postureItems) ? postureItems.slice(0, 10) : [];

    const context = {
      news: newsArr.map((n) => ({ title: n.title, source: n.source })),
      conflict: conflictArr.map((c) => ({ country: c.country ?? c.actor1, event: c.event_type, fatalities: c.fatalities })),
      cyber: cyberArr.map((c) => ({ summary: c.summary ?? c.title, severity: c.severity })),
      risk: riskArr.map((r) => ({ country: r.country ?? r.code, score: r.score ?? r.cii })),
      posture: postureArr.map((p) => ({ name: p.name ?? p.theaterName, level: p.postureLevel ?? p.level })),
    };

    const hasData = newsArr.length > 0 || conflictArr.length > 0 || cyberArr.length > 0 || riskArr.length > 0 || postureArr.length > 0;

    if (!hasData) {
      log.warn('No data for risk overview');
      return {
        timestamp: new Date().toISOString(),
        source: 'ai:risk-overview',
        data: {
          overview: '',
          topRisks: [],
          interconnections: [],
        },
        status: 'success',
      };
    }

    const systemPrompt =
      'You are a strategic risk analyst. Synthesize a comprehensive risk overview across all domains (cyber, military, political, economic, environmental). Identify top risks, interconnections between domains, and emerging threats. Output valid JSON: { "overview": string, "topRisks": [{ "domain", "risk", "severity", "trend" }], "interconnections": string[] }. Severity: low/medium/high/critical. Trend: stable/increasing/decreasing.';

    const userPrompt = previousOverview
      ? `Here is the previous risk overview:\n${previousOverview}\n\nHere is the updated data. Update the overview to reflect any changes:\n${JSON.stringify(context, null, 2)}`
      : `Synthesize risk overview from:\n\n${JSON.stringify(context, null, 2)}`;

    const result = await callLLMWithFallback(supabase, systemPrompt, userPrompt, http, {
      temperature: 0.5,
      maxTokens: 3500,
    });
    const responseText = result.content;

    let parsed;
    try {
      parsed = JSON.parse(responseText);
    } catch (parseErr) {
      log.error('generateRiskOverview malformed LLM JSON', { error: parseErr.message });
      throw new Error('LLM returned invalid JSON');
    }

    const overview = typeof parsed.overview === 'string' ? parsed.overview : '';
    const topRisks = Array.isArray(parsed.topRisks) ? parsed.topRisks : [];
    const interconnections = Array.isArray(parsed.interconnections) ? parsed.interconnections : [];

    return {
      timestamp: new Date().toISOString(),
      source: 'ai:risk-overview',
      data: {
        overview,
        topRisks,
        interconnections,
      },
      status: 'success',
    };
  } catch (err) {
    log.error('generateRiskOverview error', { error: err.message });
    return {
      timestamp: new Date().toISOString(),
      source: 'ai:risk-overview',
      data: null,
      status: 'error',
      error: err.message,
    };
  }
};
