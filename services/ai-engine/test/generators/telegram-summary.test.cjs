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

  it('single-call batch produces channelSummaries and crossChannelDigest', async () => {
    const mockMessages = [];
    for (const ch of ['AuroraIntel', 'BNONews', 'OSINTdefender']) {
      for (let i = 0; i < 5; i++) {
        mockMessages.push({
          text: `Breaking: event ${i} reported in region`,
          channel: ch,
          channelTitle: ch,
          date: Date.now() / 1000 - i * 60,
          ts: new Date(Date.now() - i * 60_000).toISOString(),
        });
      }
    }

    const mockRedis = {
      get: async (key) => {
        if (key === 'relay:telegram:v1') return { messages: mockMessages };
        if (key === 'ai:telegram-summary:v1') return null;
        if (key === 'ai:telegram-summary:meta') return null;
        return null;
      },
      set: async () => {},
    };

    const llmResponse = JSON.stringify({
      channelSummaries: [
        {
          channel: 'AuroraIntel',
          channelTitle: 'AuroraIntel',
          summary: 'Test summary',
          themes: ['conflict'],
          sentiment: 'alarming',
          messageCount: 5,
        },
      ],
      crossChannelDigest: 'Cross-channel analysis text',
      earlyWarnings: ['Warning 1'],
      changes: ['escalation'],
      previousSummaryComparison: 'Situation unchanged',
    });

    let llmCallCount = 0;
    const mockSupabase = {
      rpc: async (name) => {
        if (name === 'get_llm_function_config') return { data: [], error: null };
        if (name === 'get_all_enabled_providers')
          return {
            data: [
              {
                name: 'groq',
                api_url: 'http://test',
                default_model: 'test',
                api_key_secret_name: '',
                max_tokens: 3000,
                requests_per_minute: 60,
                tokens_per_minute: 0,
                context_window: 32768,
                complexity_cap: 'heavy',
              },
            ],
            error: null,
          };
        if (name === 'get_llm_prompt') return { data: null, error: null };
        if (name === 'get_vault_secret_value') return { data: 'test-key', error: null };
        return { data: null, error: null };
      },
    };

    const mockHttp = {
      fetchJson: async () => {
        llmCallCount++;
        return { choices: [{ message: { content: llmResponse } }] };
      },
    };

    const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
    const result = await generateTelegramSummary({
      supabase: mockSupabase,
      redis: mockRedis,
      log: mockLog,
      http: mockHttp,
    });

    assert.strictEqual(result.status, 'success');
    assert.ok(result.data.channelSummaries);
    assert.ok(result.data.crossChannelDigest);
    assert.strictEqual(llmCallCount, 1, 'should make exactly 1 LLM call');
  });
});
