'use strict';

const { callLLMForFunction, extractJson } = require('@worldmonitor/shared/llm.cjs');
const { buildPromptPayload } = require('../utils/truncate.cjs');

const MIN_NEW_MESSAGES = 3;

function groupMessagesByChannel(messages) {
  const grouped = Object.create(null);
  for (const msg of messages) {
    const ch = msg.channel || msg.channelTitle || 'unknown';
    if (!grouped[ch]) grouped[ch] = [];
    grouped[ch].push(msg);
  }
  return grouped;
}

const BATCH_SYSTEM_PROMPT_TEMPLATE = `You are a senior OSINT analyst. Current date: {date}.

Analyze Telegram channel messages and produce a JSON response with:
1. channelSummaries: array of per-channel objects (channel, channelTitle, summary [2-3 sentences], themes [2-4 keywords], sentiment [alarming|routine|escalatory|de-escalatory|mixed], messageCount)
2. crossChannelDigest: 3-5 sentence cross-channel analysis
3. earlyWarnings: events corroborated by 2+ channels
4. changes: list of new/escalation/de-escalation/resolved vs previous digest
5. previousSummaryComparison: one sentence comparing to previous

Respond with ONLY valid JSON matching this structure. Include a channelSummary entry for every channel provided.`;

module.exports = async function generateTelegramSummary({ supabase, redis, log, http }) {
  log.debug('generateTelegramSummary executing');

  try {
    if (!supabase || !http) {
      throw new Error('supabase and http are required');
    }

    const [telegramData, previousSummaryRaw, metaRaw] = await Promise.all([
      redis.get('relay:telegram:v1'),
      redis.get('ai:telegram-summary:v1'),
      redis.get('ai:telegram-summary:meta'),
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
      log.info('No text messages to summarize');
      return {
        timestamp: new Date().toISOString(),
        source: 'ai:telegram-summary',
        data: null,
        status: 'skipped',
        error: 'No text messages to summarize',
      };
    }

    // --- Delta detection ---
    let lastSummarizedAt = null;
    if (metaRaw) {
      try {
        const meta = typeof metaRaw === 'string' ? JSON.parse(metaRaw) : metaRaw;
        lastSummarizedAt = meta.lastSummarizedAt ? new Date(meta.lastSummarizedAt) : null;
      } catch (_) {
        /* ignore */
      }
    }

    if (lastSummarizedAt) {
      const lastTs = lastSummarizedAt.getTime() / 1000;
      const newMessages = textMessages.filter((m) => {
        const msgTs = m.date || (m.ts ? new Date(m.ts).getTime() / 1000 : 0);
        return msgTs > lastTs;
      });
      if (newMessages.length < MIN_NEW_MESSAGES) {
        log.info('Telegram summary: insufficient new messages, skipping', {
          newCount: newMessages.length,
          threshold: MIN_NEW_MESSAGES,
        });
        return {
          timestamp: new Date().toISOString(),
          source: 'ai:telegram-summary',
          data: null,
          status: 'skipped',
          error: `insufficient new messages (${newMessages.length} < ${MIN_NEW_MESSAGES})`,
        };
      }
    }

    // --- Build prompt payload ---
    let previousCrossDigest = null;
    if (previousSummaryRaw) {
      try {
        const prev =
          typeof previousSummaryRaw === 'string' ? JSON.parse(previousSummaryRaw) : previousSummaryRaw;
        const prevData = prev?.data ?? prev;
        previousCrossDigest = prevData?.crossChannelDigest || null;
      } catch (_) {
        /* ignore */
      }
    }

    const grouped = groupMessagesByChannel(textMessages);
    const dateStr = new Date().toISOString().slice(0, 10);
    const prevSummaryStr = previousCrossDigest || 'No previous summary available (first run).';

    // Use 10K tokens for Groq (32K context), fallback builder uses 6K for Ollama
    const payload = buildPromptPayload(grouped, { maxTokens: 10000 });
    const channelCount = payload.channelBlocks.length;

    log.info('Telegram summary: single-call batch', {
      channelCount,
      totalChannels: Object.keys(grouped).length,
      messageCount: textMessages.length,
      estimatedTokens: payload.estimatedTokens,
    });

    const userPrompt = `${payload.combinedText}\n\nPrevious digest:\n${prevSummaryStr}`;

    const result = await callLLMForFunction(
      supabase,
      'telegram_channel_summary',
      'telegram_channel_summary',
      { date: dateStr, channelMessages: userPrompt },
      http,
      {
        jsonMode: false,
        maxTokens: 2000,
        fallbackSystemPrompt: BATCH_SYSTEM_PROMPT_TEMPLATE.replace('{date}', dateStr),
        fallbackUserPrompt: userPrompt,
      },
    );

    let parsed = result.parsed;
    if (!parsed) {
      try {
        parsed = extractJson(result.content);
      } catch (_) {
        /* fallback */
      }
    }

    let channelSummaries = [];
    let crossChannelDigest = '';
    let earlyWarnings = [];
    let changes = [];
    let previousSummaryComparison = '';

    if (parsed && typeof parsed === 'object') {
      channelSummaries = Array.isArray(parsed.channelSummaries) ? parsed.channelSummaries : [];
      crossChannelDigest = parsed.crossChannelDigest || result.content;
      earlyWarnings = Array.isArray(parsed.earlyWarnings) ? parsed.earlyWarnings : [];
      changes = Array.isArray(parsed.changes) ? parsed.changes : [];
      previousSummaryComparison = parsed.previousSummaryComparison || '';
    } else {
      crossChannelDigest = result.content;
    }

    log.info('Telegram summary: complete', {
      channelSummaryCount: channelSummaries.length,
      earlyWarningCount: earlyWarnings.length,
      provider: result.provider_name,
      model: result.model_name,
    });

    await redis.set(
      'ai:telegram-summary:meta',
      JSON.stringify({
        lastSummarizedAt: new Date().toISOString(),
        messageCount: textMessages.length,
      }),
    );

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
        model: result.model_name,
        provider: result.provider_name,
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
