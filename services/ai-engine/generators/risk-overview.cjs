'use strict';

// AI generator: Comprehensive risk overview across all domains
// Aggregates news, conflict, cyber, strategic-risk, strategic-posture from Redis.
// Supports incremental: skips LLM when inputs unchanged.

const { callLLMForFunction, truncateContext } = require('@worldmonitor/shared/llm.cjs');
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

    const dateStr = new Date().toISOString().slice(0, 10);
    const contextJson = truncateContext(context);
    const riskScore = riskArr.length ? (riskArr.reduce((s, r) => s + (r.score ?? r.cii ?? 0), 0) / riskArr.length).toFixed(1) : '';
    const riskLevel = riskArr.length ? (riskArr.map((r) => r.level).filter(Boolean)[0] ?? '') : '';
    const topFactors = riskArr.slice(0, 5).map((r) => `${r.country ?? r.code}: ${r.score ?? ''}`).join('; ') || '';
    const postureSummary = truncateContext(postureArr, 1500);
    const instabilitySummary = truncateContext({ conflict: conflictArr.slice(0, 5), risk: riskArr.slice(0, 5) }, 1500);
    const headlines = newsArr.map((n) => n.title).filter(Boolean).slice(0, 10).join('\n');

    const fallbackSystemPrompt =
      'You MUST respond with ONLY valid JSON, no prose, no markdown fences, no explanation. Use this exact structure: { "overview": string, "topRisks": [{ "domain", "risk", "severity", "trend" }], "interconnections": string[] }.';
    const fallbackUserPrompt = previousOverview
      ? `Here is the previous risk overview:\n${previousOverview}\n\nHere is the updated data. Update the overview to reflect any changes:\n${contextJson}`
      : `Synthesize risk overview from:\n\n${contextJson}`;

    const result = await callLLMForFunction(
      supabase,
      'risk_overview',
      'strategic_risk_overview',
      {
        date: dateStr,
        riskScore,
        riskLevel,
        topFactors,
        postureSummary,
        instabilitySummary,
        headlines,
      },
      http,
      {
        temperature: 0.5,
        maxTokens: 3500,
        fallbackSystemPrompt,
        fallbackUserPrompt,
      },
    );

    const parsed = result.parsed;
    if (!parsed) {
      log.error('generateRiskOverview missing parsed result');
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
