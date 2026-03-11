'use strict';

const { callLLMForFunction, extractJson } = require('@worldmonitor/shared/llm.cjs');

const MAX_CONTEXT_CHARS = 12_000;
const MAX_CHANNEL_MSGS = 30;

function groupMessagesByChannel(messages) {
  const grouped = Object.create(null);
  for (const msg of messages) {
    const ch = msg.channel || msg.channelTitle || 'unknown';
    if (!grouped[ch]) grouped[ch] = [];
    grouped[ch].push(msg);
  }
  return grouped;
}

function buildChannelContext(grouped, maxChars) {
  const sections = [];
  for (const [channel, msgs] of Object.entries(grouped)) {
    const title = msgs[0]?.channelTitle || channel;
    const lines = msgs.slice(0, MAX_CHANNEL_MSGS).map((m) => {
      const ts = m.ts || (typeof m.date === 'number' ? new Date(m.date).toISOString() : '');
      return `[${ts}] ${String(m.text || '').slice(0, 400)}`;
    });
    sections.push(`### ${title} (@${channel}) — ${msgs.length} messages\n${lines.join('\n')}`);
  }
  let result = sections.join('\n\n');
  if (result.length > maxChars) {
    result = result.slice(0, maxChars) + '\n[truncated]';
  }
  return result;
}

const FALLBACK_CHANNEL_SYSTEM =
  'You are an OSINT analyst. Summarize the following Telegram channel messages grouped by channel. For each channel produce: summary (2-4 sentences), themes (array), sentiment (one word), messageCount. Respond with ONLY valid JSON: { "channelSummaries": [...] }';
const FALLBACK_CROSS_SYSTEM =
  'You are a senior intelligence analyst. Given per-channel Telegram summaries and the previous digest, produce: crossChannelDigest (3-5 sentences), earlyWarnings (events from 2+ channels), changes (new/escalation/de-escalation/resolved vs previous), previousSummaryComparison (one sentence). Respond with ONLY valid JSON.';

module.exports = async function generateTelegramSummary({ supabase, redis, log, http }) {
  log.debug('generateTelegramSummary executing');

  try {
    if (!supabase || !http) {
      throw new Error('supabase and http are required');
    }

    const [telegramData, previousSummaryRaw] = await Promise.all([
      redis.get('relay:telegram:v1'),
      redis.get('ai:telegram-summary:v1'),
    ]);

    const messages = telegramData?.messages || telegramData?.items || [];
    if (!Array.isArray(messages) || messages.length === 0) {
      log.info('No telegram messages available for summarization');
      return {
        timestamp: new Date().toISOString(),
        source: 'ai:telegram-summary',
        data: null,
        status: 'skipped',
        error: 'No telegram messages available',
      };
    }

    const textMessages = messages.filter((m) => m.text && String(m.text).trim().length > 10);
    if (textMessages.length === 0) {
      log.info('No text messages to summarize (all media-only or too short)');
      return {
        timestamp: new Date().toISOString(),
        source: 'ai:telegram-summary',
        data: null,
        status: 'skipped',
        error: 'No text messages to summarize',
      };
    }

    let previousCrossDigest = null;
    if (previousSummaryRaw) {
      try {
        const prev =
          typeof previousSummaryRaw === 'string' ? JSON.parse(previousSummaryRaw) : previousSummaryRaw;
        const prevData = prev?.data ?? prev;
        previousCrossDigest = prevData?.crossChannelDigest || null;
      } catch (_) {
        /* ignore parse errors */
      }
    }

    const grouped = groupMessagesByChannel(textMessages);
    const channelCount = Object.keys(grouped).length;
    const channelContext = buildChannelContext(grouped, MAX_CONTEXT_CHARS);
    const dateStr = new Date().toISOString().slice(0, 10);

    log.info('Telegram summary: starting per-channel LLM call', {
      channelCount,
      messageCount: textMessages.length,
    });

    // --- LLM Call 1: Per-channel summaries ---
    const channelResult = await callLLMForFunction(
      supabase,
      'telegram_channel_summary',
      'telegram_channel_summary',
      { date: dateStr, channelCount: String(channelCount), channelMessages: channelContext },
      http,
      {
        jsonMode: false,
        fallbackSystemPrompt: FALLBACK_CHANNEL_SYSTEM,
        fallbackUserPrompt: `Summarize these ${channelCount} Telegram channels:\n\n${channelContext}`,
      },
    );

    let channelSummaries = [];
    let channelParsed = channelResult.parsed;
    if (!channelParsed) {
      try {
        channelParsed = extractJson(channelResult.content);
      } catch (_) {
        /* fallback */
      }
    }
    if (channelParsed?.channelSummaries && Array.isArray(channelParsed.channelSummaries)) {
      channelSummaries = channelParsed.channelSummaries;
    }

    log.info('Telegram summary: per-channel complete', {
      summaryCount: channelSummaries.length,
      provider: channelResult.provider_name,
      model: channelResult.model_name,
    });

    // --- LLM Call 2: Cross-channel + delta ---
    const channelSummariesStr = JSON.stringify(channelSummaries, null, 2);
    const prevSummaryStr = previousCrossDigest || 'No previous summary available (first run).';

    const crossResult = await callLLMForFunction(
      supabase,
      'telegram_cross_channel',
      'telegram_cross_channel',
      {
        date: dateStr,
        channelCount: String(channelCount),
        channelSummaries: channelSummariesStr,
        previousSummary: prevSummaryStr,
      },
      http,
      {
        jsonMode: false,
        fallbackSystemPrompt: FALLBACK_CROSS_SYSTEM,
        fallbackUserPrompt: `Per-channel summaries:\n${channelSummariesStr}\n\nPrevious digest:\n${prevSummaryStr}\n\nProduce cross-channel digest, early warnings, and change analysis.`,
      },
    );

    let crossChannelDigest = '';
    let earlyWarnings = [];
    let changes = [];
    let previousSummaryComparison = '';

    let crossParsed = crossResult.parsed;
    if (!crossParsed) {
      try {
        crossParsed = extractJson(crossResult.content);
      } catch (_) {
        /* fallback */
      }
    }
    if (crossParsed && typeof crossParsed === 'object') {
      crossChannelDigest = crossParsed.crossChannelDigest || crossResult.content;
      earlyWarnings = Array.isArray(crossParsed.earlyWarnings) ? crossParsed.earlyWarnings : [];
      changes = Array.isArray(crossParsed.changes) ? crossParsed.changes : [];
      previousSummaryComparison = crossParsed.previousSummaryComparison || '';
    } else {
      crossChannelDigest = crossResult.content;
    }

    log.info('Telegram summary: cross-channel complete', {
      earlyWarningCount: earlyWarnings.length,
      changeCount: changes.length,
      provider: crossResult.provider_name,
      model: crossResult.model_name,
    });

    return {
      timestamp: new Date().toISOString(),
      source: 'ai:telegram-summary',
      data: {
        channelSummaries,
        crossChannelDigest,
        earlyWarnings,
        changes,
        previousSummaryComparison,
        messageCount: textMessages.length,
        channelCount,
        model: crossResult.model_name,
        provider: crossResult.provider_name,
        generatedAt: new Date().toISOString(),
      },
      status: 'success',
    };
  } catch (err) {
    log.error('generateTelegramSummary error', { error: err.message });
    return {
      timestamp: new Date().toISOString(),
      source: 'ai:telegram-summary',
      data: null,
      status: 'error',
      error: err.message,
    };
  }
};

module.exports.groupMessagesByChannel = groupMessagesByChannel;
module.exports.buildChannelContext = buildChannelContext;
