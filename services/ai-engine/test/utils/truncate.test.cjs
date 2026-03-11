const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildPromptPayload } = require('../../utils/truncate.cjs');

test('buildPromptPayload fits within token budget', () => {
  const grouped = {};
  for (let i = 0; i < 15; i++) {
    const ch = `channel_${i}`;
    grouped[ch] = [];
    for (let j = 0; j < 20; j++) {
      grouped[ch].push({
        text: 'A'.repeat(300),
        channel: ch,
        channelTitle: `Channel ${i}`,
        ts: new Date().toISOString(),
      });
    }
  }
  const result = buildPromptPayload(grouped, { maxTokens: 8000 });
  assert.ok(result.estimatedTokens <= 8000, `tokens ${result.estimatedTokens} > 8000`);
  assert.ok(result.channelBlocks.length > 0);
});

test('buildPromptPayload returns all channels when budget allows', () => {
  const grouped = {
    ch1: [{ text: 'short msg', channel: 'ch1', channelTitle: 'Ch1', ts: new Date().toISOString() }],
    ch2: [{ text: 'short msg', channel: 'ch2', channelTitle: 'Ch2', ts: new Date().toISOString() }],
  };
  const result = buildPromptPayload(grouped, { maxTokens: 32000 });
  assert.equal(result.channelBlocks.length, 2);
});

test('buildPromptPayload drops least-active channels when over budget', () => {
  const grouped = {};
  for (let i = 0; i < 20; i++) {
    const ch = `channel_${i}`;
    grouped[ch] = [];
    const msgCount = i === 0 ? 1 : 15;
    for (let j = 0; j < msgCount; j++) {
      grouped[ch].push({ text: 'A'.repeat(300), channel: ch, channelTitle: ch, ts: new Date().toISOString() });
    }
  }
  const result = buildPromptPayload(grouped, { maxTokens: 4000 });
  const channels = result.channelBlocks.map((b) => b.channel);
  assert.ok(!channels.includes('channel_0'), 'least active channel should be dropped');
});
