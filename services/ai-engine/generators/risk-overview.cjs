'use strict';

// AI generator: Comprehensive risk overview across all domains
// Aggregates news, conflict, cyber, strategic-risk, strategic-posture from Redis.
// Frontend: StrategicRiskPanel.applyAiOverview(payload) — expects overview, topRisks, interconnections.
// Relay broadcasts full { timestamp, source, data, status }.

const { fetchLLMProvider, callLLM } = require('@worldmonitor/shared/llm.cjs');

const REDIS_KEYS = [
  'relay:news:full:v1',
  'relay:conflict:v1',
  'relay:cyber:v1',
  'relay:strategic-risk:v1',
  'relay:strategic-posture:v1',
];

module.exports = async function generateRiskOverview({ supabase, redis, log, http }) {
  if (!supabase || !redis || !http) {
    throw new Error('supabase, redis, and http are required');
  }

  log.debug('generateRiskOverview executing');

  try {
    const results = await Promise.all(REDIS_KEYS.map((k) => redis.get(k)));

    const [newsData, conflictData, cyberData, riskData, postureData] = results;

    const newsItems = newsData?.items ?? newsData?.data ?? [];
    const newsArr = Array.isArray(newsItems) ? newsItems.slice(0, 15) : [];
    const conflictItems = conflictData?.data ?? conflictData?.events ?? [];
    const conflictArr = Array.isArray(conflictItems) ? conflictItems.slice(0, 20) : [];
    const cyberItems = cyberData?.data ?? cyberData?.threats ?? [];
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

    const provider = await fetchLLMProvider(supabase);

    const systemPrompt =
      'You are a strategic risk analyst. Synthesize a comprehensive risk overview across all domains (cyber, military, political, economic, environmental). Identify top risks, interconnections between domains, and emerging threats. Output valid JSON: { "overview": string, "topRisks": [{ "domain", "risk", "severity", "trend" }], "interconnections": string[] }. Severity: low/medium/high/critical. Trend: stable/increasing/decreasing.';

    const userPrompt = `Synthesize risk overview from:\n\n${JSON.stringify(context, null, 2)}`;

    const responseText = await callLLM(provider, systemPrompt, userPrompt, http, {
  temperature: 0.5,
  maxTokens: 3500,
});

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
