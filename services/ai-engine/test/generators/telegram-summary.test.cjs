'use strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'test-anon-key';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const generateTelegramSummary = require('../../generators/telegram-summary.cjs');

describe('generateTelegramSummary', () => {
  it('returns error when supabase is missing', async () => {
    const result = await generateTelegramSummary({
      supabase: null,
      redis: { get: async () => null },
      log: { debug() {}, info() {}, warn() {}, error() {} },
      http: {},
    });
    assert.strictEqual(result.status, 'error');
    assert.ok(result.error.includes('supabase'));
  });

  it('returns early with skipped status when telegram buffer is empty', async () => {
    const result = await generateTelegramSummary({
      supabase: {},
      redis: { get: async () => null },
      log: { debug() {}, info() {}, warn() {}, error() {} },
      http: {},
    });
    assert.strictEqual(result.status, 'skipped');
    assert.ok(result.error.includes('No telegram'));
  });

  it('returns early when telegram buffer has zero messages', async () => {
    const result = await generateTelegramSummary({
      supabase: {},
      redis: {
        get: async (key) => {
          if (key === 'relay:telegram:v1')
            return { messages: [], count: 0, timestamp: new Date().toISOString() };
          return null;
        },
      },
      log: { debug() {}, info() {}, warn() {}, error() {} },
      http: {},
    });
    assert.strictEqual(result.status, 'skipped');
  });

  it('groups messages by channel correctly', async () => {
    const { groupMessagesByChannel } = require('../../generators/telegram-summary.cjs');
    const messages = [
      { channel: 'BNONews', text: 'msg1' },
      { channel: 'AuroraIntel', text: 'msg2' },
      { channel: 'BNONews', text: 'msg3' },
    ];
    const grouped = groupMessagesByChannel(messages);
    assert.strictEqual(Object.keys(grouped).length, 2);
    assert.strictEqual(grouped['BNONews'].length, 2);
    assert.strictEqual(grouped['AuroraIntel'].length, 1);
  });

  it('builds per-channel context string with character limit', async () => {
    const { buildChannelContext } = require('../../generators/telegram-summary.cjs');
    const grouped = {
      TestChannel: [
        {
          channel: 'TestChannel',
          channelTitle: 'Test Channel',
          text: 'Hello world',
          ts: '2026-03-11T00:00:00Z',
        },
      ],
    };
    const context = buildChannelContext(grouped, 5000);
    assert.ok(context.includes('TestChannel'));
    assert.ok(context.includes('Hello world'));
  });
});
