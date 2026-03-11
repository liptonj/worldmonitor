'use strict';

const { callLLMForFunction, extractJson, truncateContext } = require('@worldmonitor/shared/llm.cjs');
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
        const items = parseNewsFromRedis(raw).slice(0, 8);
        context[label] = items.map((a) => ({ title: (a.title || '').slice(0, 100) }));
      } else if (label === 'telegram') {
        const msgs = raw?.messages ?? raw?.data?.messages ?? [];
        context[label] = (Array.isArray(msgs) ? msgs : []).slice(0, 5).map((m) => (m.text || '').slice(0, 100));
      } else {
        const data = unwrapEnvelope(raw) ?? raw?.data ?? raw?.items ?? raw;
        if (Array.isArray(data)) {
          context[label] = data.slice(0, 5);
        } else {
          context[label] = data;
        }
      }
    }
  }
  return context;
}

const FALLBACK_SYSTEM_PROMPT =
  'You are an intelligence analyst creating an executive summary from global intelligence panels. Synthesize all data sources into a concise, actionable intelligence summary. Focus on significant developments, emerging patterns, cross-domain correlations, and critical risks. You MUST respond with ONLY valid JSON, no prose, no markdown fences, no explanation. Use this exact structure: { "summary": string, "keyEvents": [string], "riskLevel": "low"|"medium"|"high"|"critical" }.';

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

    const dateStr = new Date().toISOString().slice(0, 10);
    const panelData = truncateContext(context, 3000);

    const fallbackUserPrompt = previousSummary
      ? `Here is the previous executive summary:\n${previousSummary}\n\nHere is the updated panel data. Update the summary to reflect any changes:\n${panelData}`
      : `Analyze this panel data and create an executive summary:\n\n${panelData}`;

    const result = await callLLMForFunction(
      supabase,
      'panel_summary',
      'view_summary',
      {
        date: dateStr,
        panelData,
      },
      http,
      {
        jsonMode: false,
        fallbackSystemPrompt: FALLBACK_SYSTEM_PROMPT,
        fallbackUserPrompt,
      },
    );

    let summary = '';
    let keyEvents = [];
    let riskLevel = 'medium';

    let parsed = result.parsed;
    if (!parsed) {
      try { parsed = extractJson(result.content); } catch (_) { /* markdown — use as-is */ }
    }

    if (parsed && typeof parsed === 'object' && parsed.summary) {
      summary = parsed.summary ?? '';
      keyEvents = Array.isArray(parsed.keyEvents) ? parsed.keyEvents : [];
      riskLevel = ['low', 'medium', 'high', 'critical'].includes(parsed.riskLevel)
        ? parsed.riskLevel
        : 'medium';
    } else {
      summary = result.content;
    }

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
