'use strict';

// AI generator: Dashboard panel summary
// Aggregates data from multiple panels (news, telegram, markets, strategic-risk, cyber, conflict, natural)
// into an executive summary. Follows intel-digest pattern.

const { fetchLLMProvider, callLLM } = require('@worldmonitor/shared/llm.cjs');

const REDIS_KEYS = [
  'relay:news:full:v1',
  'relay:telegram:v1',
  'relay:markets:v1',
  'relay:strategic-risk:v1',
  'relay:cyber:v1',
  'relay:conflict:v1',
  'relay:natural:v1',
];

module.exports = async function generatePanelSummary({ supabase, redis, log, http }) {
  log.debug('generatePanelSummary executing');

  try {
    if (!supabase || !http) {
      throw new Error('supabase and http are required');
    }

    const results = await Promise.all(REDIS_KEYS.map((key) => redis.get(key)));

    const context = {};
    const keyLabels = [
      'news',
      'telegram',
      'markets',
      'strategicRisk',
      'cyber',
      'conflict',
      'natural',
    ];
    for (let i = 0; i < REDIS_KEYS.length; i++) {
      const raw = results[i];
      const label = keyLabels[i];
      if (raw != null) {
        context[label] = raw?.data ?? raw?.items ?? raw;
      }
    }

    const systemPrompt =
      'You are an intelligence analyst creating an executive summary from global intelligence panels. Synthesize all data sources into a concise, actionable intelligence summary. Focus on significant developments, emerging patterns, cross-domain correlations, and critical risks. Output valid JSON with fields: summary (string), keyEvents (array of strings), riskLevel (string: \'low\'|\'medium\'|\'high\'|\'critical\').';

    const userPrompt = `Analyze this panel data and create an executive summary:\n\n${JSON.stringify(context, null, 2)}`;

    const provider = await fetchLLMProvider(supabase);
    const responseText = await callLLM(provider, systemPrompt, userPrompt, http);

    const parsed = JSON.parse(responseText);
    const summary = parsed.summary ?? '';
    const keyEvents = Array.isArray(parsed.keyEvents) ? parsed.keyEvents : [];
    const riskLevel = ['low', 'medium', 'high', 'critical'].includes(parsed.riskLevel)
      ? parsed.riskLevel
      : 'medium';

    const contextSources = Object.keys(context).filter((k) => context[k] != null).length;

    return {
      timestamp: new Date().toISOString(),
      source: 'ai:panel-summary',
      data: {
        summary,
        keyEvents,
        riskLevel,
        generatedAt: new Date().toISOString(),
        contextSources,
      },
      status: 'success',
    };
  } catch (err) {
    log.error('generatePanelSummary error', { error: err.message });
    return {
      timestamp: new Date().toISOString(),
      source: 'ai:panel-summary',
      data: null,
      status: 'error',
      error: err.message,
    };
  }
};
