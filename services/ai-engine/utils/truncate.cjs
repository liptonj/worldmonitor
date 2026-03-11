'use strict';

function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

const TRUNCATION_TIERS = [
  { maxMsgsPerChannel: 15, maxCharsPerMsg: 300 },
  { maxMsgsPerChannel: 8, maxCharsPerMsg: 300 },
  { maxMsgsPerChannel: 5, maxCharsPerMsg: 200 },
  { maxMsgsPerChannel: 3, maxCharsPerMsg: 150 },
  { maxMsgsPerChannel: 2, maxCharsPerMsg: 100 },
];

function buildChannelBlock(channel, title, messages, maxMsgs, maxChars) {
  const slice = messages.slice(0, maxMsgs);
  const lines = slice.map((m) => {
    const ts = m.ts || (typeof m.date === 'number' ? new Date(m.date * 1000).toISOString() : '');
    const text = String(m.text || '').slice(0, maxChars);
    return `[${ts}] ${text}`;
  });
  return {
    channel,
    title,
    messageCount: messages.length,
    text: `**${title}** (@${channel}) — ${messages.length} messages:\n${lines.join('\n')}`,
  };
}

/**
 * Build a combined prompt payload from channel-grouped messages that fits within maxTokens.
 * Returns { channelBlocks, combinedText, estimatedTokens } where estimatedTokens = input text
 * tokens + system prompt overhead (output reserve not included).
 */
function buildPromptPayload(grouped, { maxTokens = 10000 } = {}) {
  const SYSTEM_PROMPT_OVERHEAD = 500;
  const OUTPUT_RESERVE = 1500;
  const inputBudget = maxTokens - SYSTEM_PROMPT_OVERHEAD - OUTPUT_RESERVE;

  const sortedChannels = Object.entries(grouped)
    .sort(([, a], [, b]) => b.length - a.length);

  for (const tier of TRUNCATION_TIERS) {
    const blocks = sortedChannels.map(([ch, msgs]) =>
      buildChannelBlock(ch, msgs[0]?.channelTitle || ch, msgs, tier.maxMsgsPerChannel, tier.maxCharsPerMsg)
    );

    const combinedText = blocks.map((b) => b.text).join('\n\n');
    const tokens = estimateTokens(combinedText);

    if (tokens <= inputBudget) {
      return { channelBlocks: blocks, combinedText, estimatedTokens: tokens + SYSTEM_PROMPT_OVERHEAD };
    }

    let trimmedBlocks = [...blocks];
    while (estimateTokens(trimmedBlocks.map((b) => b.text).join('\n\n')) > inputBudget && trimmedBlocks.length > 2) {
      trimmedBlocks.pop();
    }

    const trimmedText = trimmedBlocks.map((b) => b.text).join('\n\n');
    const trimmedTokens = estimateTokens(trimmedText);
    if (trimmedTokens <= inputBudget) {
      return { channelBlocks: trimmedBlocks, combinedText: trimmedText, estimatedTokens: trimmedTokens + SYSTEM_PROMPT_OVERHEAD };
    }
  }

  const minimal = sortedChannels.slice(0, 3).map(([ch, msgs]) =>
    buildChannelBlock(ch, msgs[0]?.channelTitle || ch, msgs, 2, 80)
  );
  const minText = minimal.map((b) => b.text).join('\n\n');
  return { channelBlocks: minimal, combinedText: minText, estimatedTokens: estimateTokens(minText) + SYSTEM_PROMPT_OVERHEAD };
}

module.exports = { buildPromptPayload, estimateTokens, buildChannelBlock };
