'use strict';

// AI generator: Dashboard panel summary
// Aggregates data from multiple panels (news, telegram, markets, strategic-risk, cyber, conflict, natural)
// into an executive summary. Supports incremental: skips LLM when inputs unchanged.

const { callLLMWithFallback } = require('@worldmonitor/shared/llm.cjs');
const { parseNewsFromRedis, unwrapEnvelope } = require('../utils/news-parse.cjs');

const REDIS_KEYS = [
  'news:digest:v1:full:en',
  'relay:telegram:v1',
  'market:dashboard:v1',
  'risk:scores:sebuf:v1',
  'relay:cyber:v1',
  'relay:conflict:v1',
  'relay:natural:v1',
];

const KEY_LABELS = ['news', 'telegram', 'markets', 'strategicRisk', 'cyber', 'conflict', 'natural'];

function buildContext(results) {
  const context = {};
  for (let i = 0; i < REDIS_KEYS.length; i++) {
    const raw = results[i];
    const label = KEY_LABELS[i];
    if (raw != null) {
      if (label === 'news') {
        context[label] = parseNewsFromRedis(raw);
      } else {
        context[label] = unwrapEnvelope(raw) ?? raw?.data ?? raw?.items ?? raw;
      }
    }
  }
  return context;
}

module.exports = async function generatePanelSummary({ supabase, redis, log, http }) {
  log.debug('generatePanelSummary executing');

  try {
    if (!supabase || !http) {
      throw new Error('supabase and http are required');
    }

    const previousKeys = REDIS_KEYS.map((k) => `${k}:previous`);
    const [previousOutput, ...currentResults] = await Promise.all([
      redis.get('ai:panel-summary:v1'),
      ...REDIS_KEYS.map((k) => redis.get(k)),
      ...previousKeys.map((k) => redis.get(k)),
    ]);
    const currentData = currentResults.slice(0, REDIS_KEYS.length);
    const previousData = currentResults.slice(REDIS_KEYS.length);

    const context = buildContext(currentData);
    const previousContext = buildContext(previousData);
    const contextStr = JSON.stringify(context);
    const previousContextStr = JSON.stringify(previousContext);
    const inputsUnchanged = contextStr === previousContextStr;

    let previousSummary = null;
    if (previousOutput?.source === 'ai:panel-summary' && previousOutput?.status === 'success') {
      const data = previousOutput?.data ?? previousOutput;
      previousSummary = data?.summary || null;
    }

    if (inputsUnchanged && previousSummary) {
      log.info('Panel inputs unchanged, keeping previous summary');
      return previousOutput;
    }

    const systemPrompt =
      'You are an intelligence analyst creating an executive summary from global intelligence panels. Synthesize all data sources into a concise, actionable intelligence summary. Focus on significant developments, emerging patterns, cross-domain correlations, and critical risks. Output valid JSON with fields: summary (string), keyEvents (array of strings), riskLevel (string: \'low\'|\'medium\'|\'high\'|\'critical\').';

    const userPrompt = previousSummary
      ? `Here is the previous executive summary:\n${previousSummary}\n\nHere is the updated panel data. Update the summary to reflect any changes:\n${JSON.stringify(context, null, 2)}`
      : `Analyze this panel data and create an executive summary:\n\n${JSON.stringify(context, null, 2)}`;

    const result = await callLLMWithFallback(supabase, systemPrompt, userPrompt, http);
    const responseText = result.content;

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
