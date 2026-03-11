'use strict';

const { callLLMForFunction, extractJson } = require('@worldmonitor/shared/llm.cjs');

const MAX_CHANNEL_MSGS = 15; // Messages per channel for summarization
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

const FALLBACK_CROSS_SYSTEM =
  'You are a senior intelligence analyst. Given per-channel Telegram summaries and the previous digest, produce: crossChannelDigest (3-5 sentences), earlyWarnings (events from 2+ channels), changes (new/escalation/de-escalation/resolved vs previous), previousSummaryComparison (one sentence). Respond with ONLY valid JSON.';

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
      log.info('No text messages to summarize (all media-only or too short)');
      return {
        timestamp: new Date().toISOString(),
        source: 'ai:telegram-summary',
        data: null,
        status: 'skipped',
        error: 'No text messages to summarize',
      };
    }

    // Delta detection: skip if not enough new messages since last run
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
          lastSummarizedAt: lastSummarizedAt.toISOString(),
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
    
    // Prioritize channels by message count (most active first) and limit to top channels
    const MAX_CHANNELS_TO_SUMMARIZE = 20; // Limit to top 20 most active channels
    const sortedChannels = Object.entries(grouped)
      .sort(([, a], [, b]) => b.length - a.length)
      .slice(0, MAX_CHANNELS_TO_SUMMARIZE);
    
    const channelCount = sortedChannels.length;
    const dateStr = new Date().toISOString().slice(0, 10);

    log.info('Telegram summary: starting per-channel summaries', {
      channelCount,
      totalChannels: Object.keys(grouped).length,
      messageCount: textMessages.length,
    });

    // --- Process each channel individually to avoid context overflow ---
    const channelSummaries = [];
    const SINGLE_CHANNEL_PROMPT = `You are an OSINT analyst. Current date: ${dateStr}.

Analyze messages from this Telegram channel and produce a summary with:
- 2-3 sentence summary of key developments
- Key themes (2-4 keywords)
- Overall sentiment: alarming|routine|escalatory|de-escalatory|mixed
- Message count

Respond with ONLY valid JSON:
{
  "channel": "handle",
  "channelTitle": "Display Name",
  "summary": "2-3 sentences",
  "themes": ["theme1", "theme2"],
  "sentiment": "alarming|routine|escalatory|de-escalatory|mixed",
  "messageCount": 12
}`;

    for (const [channel, msgs] of sortedChannels) {
      const title = msgs[0]?.channelTitle || channel;
      const messageLines = msgs.slice(0, MAX_CHANNEL_MSGS).map((m) => {
        const ts = m.ts || (typeof m.date === 'number' ? new Date(m.date).toISOString() : '');
        const text = String(m.text || '').slice(0, 300);
        return `[${ts}] ${text}`;
      });
      const channelContext = `Channel: ${title} (@${channel})\nMessages (${msgs.length} total, showing ${messageLines.length}):\n\n${messageLines.join('\n')}`;
      
      try {
        const result = await callLLMForFunction(
          supabase,
          'telegram_channel_summary',
          'telegram_channel_summary',
          { date: dateStr, channel, channelTitle: title, channelMessages: channelContext },
          http,
          {
            jsonMode: false,
            fallbackSystemPrompt: SINGLE_CHANNEL_PROMPT,
            fallbackUserPrompt: channelContext,
          },
        );

        let parsed = result.parsed;
        if (!parsed) {
          try { parsed = extractJson(result.content); } catch (_) { /* ignore */ }
        }
        
        if (parsed && typeof parsed === 'object') {
          channelSummaries.push({
            channel: parsed.channel || channel,
            channelTitle: parsed.channelTitle || title,
            summary: parsed.summary || result.content.slice(0, 200),
            themes: Array.isArray(parsed.themes) ? parsed.themes : [],
            sentiment: parsed.sentiment || 'routine',
            messageCount: parsed.messageCount || msgs.length,
          });
        }
      } catch (err) {
        log.warn('Failed to summarize channel', { channel, error: err.message });
        // Continue with other channels even if one fails
      }
    }

    log.info('Telegram summary: per-channel complete', {
      summaryCount: channelSummaries.length,
      channelCount,
    });

    // --- LLM Call 2: Cross-channel synthesis using per-channel summaries ---
    // Build a concise context from channel summaries (not the full message text)
    const summaryLines = channelSummaries.map((cs) => {
      const themes = cs.themes?.join(', ') || 'none';
      return `**${cs.channelTitle}** (@${cs.channel})\n- Summary: ${cs.summary}\n- Themes: ${themes}\n- Sentiment: ${cs.sentiment}\n- Messages: ${cs.messageCount}`;
    });
    const channelSummariesStr = summaryLines.join('\n\n');
    const prevSummaryStr = previousCrossDigest || 'No previous summary available (first run).';

    log.info('Telegram summary: starting cross-channel LLM call', {
      summariesContextChars: channelSummariesStr.length,
      previousContextChars: prevSummaryStr.length,
    });

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
        fallbackUserPrompt: `Per-channel summaries:\n\n${channelSummariesStr}\n\nPrevious digest:\n${prevSummaryStr}\n\nProduce cross-channel digest, early warnings, and change analysis.`,
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
