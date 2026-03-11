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

  it('skips run when fewer than 3 new messages since last summary', async () => {
    const mockRedis = {
      get: async (key) => {
        if (key === 'relay:telegram:v1') {
          return {
            messages: [
              { text: 'old message 1', channel: 'ch1', date: Date.now() / 1000 - 600 },
              { text: 'old message 2', channel: 'ch1', date: Date.now() / 1000 - 500 },
            ],
          };
        }
        if (key === 'ai:telegram-summary:v1') return null;
        if (key === 'ai:telegram-summary:meta') {
          return JSON.stringify({
            lastSummarizedAt: new Date(Date.now() - 120_000).toISOString(),
            messageHash: 'abc123',
          });
        }
        return null;
      },
      set: async () => {},
    };
    const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

    const result = await generateTelegramSummary({
      supabase: {},
      redis: mockRedis,
      log: mockLog,
      http: {},
    });
    assert.strictEqual(result.status, 'skipped');
    assert.ok(result.error.includes('insufficient new'));
  });
});
