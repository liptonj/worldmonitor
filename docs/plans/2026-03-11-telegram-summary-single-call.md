# Telegram Summary Single-Call Batch Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace 13 sequential LLM calls with 1 batch call, add delta-based scheduling, and add provider-aware truncation to make telegram summaries fast, reliable, and free-tier friendly.

**Architecture:** The generator groups all telegram messages by channel, truncates the payload to fit the target LLM provider's context window, makes a single LLM call that returns both per-channel summaries and cross-channel analysis, and short-circuits when there aren't enough new messages to justify a run. Output format is unchanged — zero frontend changes.

**Tech Stack:** Node.js (CommonJS), Supabase RPCs, Redis, Groq/Ollama LLM providers

---

### Task 1: Add Delta-Detection (Skip When Nothing Changed)

**Files:**
- Modify: `services/ai-engine/generators/telegram-summary.cjs`
- Test: `services/ai-engine/test/generators/telegram-summary.test.cjs`

**Step 1: Write the failing test for delta detection**

Add to the test file:

```javascript
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('skips run when fewer than 3 new messages since last summary', async () => {
  const mockRedis = {
    get: async (key) => {
      if (key === 'relay:telegram:v1') {
        return { messages: [
          { text: 'old message 1', channel: 'ch1', date: Date.now() / 1000 - 600 },
          { text: 'old message 2', channel: 'ch1', date: Date.now() / 1000 - 500 },
        ]};
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
  const mockLog = { debug: () => {}, info: () => {}, warn: () => {} };

  const generate = require('../../generators/telegram-summary.cjs');
  const result = await generate({ supabase: {}, redis: mockRedis, log: mockLog, http: {} });
  assert.equal(result.status, 'skipped');
  assert.ok(result.error.includes('insufficient new'));
});
```

**Step 2: Run test to verify it fails**

Run: `cd services && node --test ai-engine/test/generators/telegram-summary.test.cjs 2>&1 | tail -20`
Expected: FAIL — current code doesn't check delta

**Step 3: Implement delta detection**

At the top of `generateTelegramSummary` in `telegram-summary.cjs`, after fetching messages and `previousSummaryRaw`, add:

```javascript
const MIN_NEW_MESSAGES = 3;

// Delta detection: skip if not enough new messages since last run
const metaRaw = await redis.get('ai:telegram-summary:meta');
let lastSummarizedAt = null;
if (metaRaw) {
  try {
    const meta = typeof metaRaw === 'string' ? JSON.parse(metaRaw) : metaRaw;
    lastSummarizedAt = meta.lastSummarizedAt ? new Date(meta.lastSummarizedAt) : null;
  } catch (_) { /* ignore */ }
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
```

At the end of a successful run (before the `return` with `status: 'success'`), save the meta:

```javascript
await redis.set('ai:telegram-summary:meta', JSON.stringify({
  lastSummarizedAt: new Date().toISOString(),
  messageCount: textMessages.length,
}));
```

**Step 4: Run test to verify it passes**

Run: `cd services && node --test ai-engine/test/generators/telegram-summary.test.cjs 2>&1 | tail -20`
Expected: PASS

**Step 5: Commit**

```bash
git add services/ai-engine/generators/telegram-summary.cjs services/ai-engine/test/generators/telegram-summary.test.cjs
git commit -m "feat(telegram-summary): add delta detection to skip runs with < 3 new messages"
```

---

### Task 2: Build Truncation Helpers

**Files:**
- Create: `services/ai-engine/utils/truncate.cjs`
- Create: `services/ai-engine/test/utils/truncate.test.cjs`

**Step 1: Write failing tests for truncation**

```javascript
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
```

**Step 2: Run test to verify it fails**

Run: `cd services && node --test ai-engine/test/utils/truncate.test.cjs 2>&1 | tail -20`
Expected: FAIL — module doesn't exist yet

**Step 3: Implement truncation helper**

Create `services/ai-engine/utils/truncate.cjs`:

```javascript
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
```

**Step 4: Run test to verify it passes**

Run: `cd services && node --test ai-engine/test/utils/truncate.test.cjs 2>&1 | tail -20`
Expected: PASS

**Step 5: Commit**

```bash
git add services/ai-engine/utils/truncate.cjs services/ai-engine/test/utils/truncate.test.cjs
git commit -m "feat(telegram-summary): add provider-aware truncation helpers"
```

---

### Task 3: Rewrite Generator to Single-Call Batch

**Files:**
- Modify: `services/ai-engine/generators/telegram-summary.cjs`
- Modify: `services/ai-engine/test/generators/telegram-summary.test.cjs`

**Step 1: Write a failing test for single-call batch output**

Add to test file:

```javascript
test('single-call batch produces channelSummaries and crossChannelDigest', async () => {
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
      { channel: 'AuroraIntel', channelTitle: 'AuroraIntel', summary: 'Test summary', themes: ['conflict'], sentiment: 'alarming', messageCount: 5 },
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
      if (name === 'get_all_enabled_providers') return {
        data: [{ name: 'groq', api_url: 'http://test', default_model: 'test', api_key_secret_name: '', max_tokens: 3000, requests_per_minute: 60, tokens_per_minute: 0, context_window: 32768, complexity_cap: 'heavy' }],
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
  const generate = require('../../generators/telegram-summary.cjs');
  const result = await generate({ supabase: mockSupabase, redis: mockRedis, log: mockLog, http: mockHttp });

  assert.equal(result.status, 'success');
  assert.ok(result.data.channelSummaries);
  assert.ok(result.data.crossChannelDigest);
  assert.equal(llmCallCount, 1, 'should make exactly 1 LLM call');
});
```

**Step 2: Run test to verify it fails**

Run: `cd services && node --test ai-engine/test/generators/telegram-summary.test.cjs 2>&1 | tail -20`
Expected: FAIL — current code makes 4+ LLM calls (1 per channel + 1 cross)

**Step 3: Rewrite the generator**

Replace the body of `generateTelegramSummary` in `telegram-summary.cjs` with the single-call approach. The full replacement code:

```javascript
'use strict';

const { callLLMForFunction, extractJson } = require('@worldmonitor/shared/llm.cjs');
const { buildPromptPayload } = require('../utils/truncate.cjs');

const MIN_NEW_MESSAGES = 3;
const MAX_CHANNELS = 20;

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
      return { timestamp: new Date().toISOString(), source: 'ai:telegram-summary', data: null, status: 'skipped', error: 'No telegram messages available' };
    }

    const textMessages = messages.filter((m) => m.text && String(m.text).trim().length > 10);
    if (textMessages.length === 0) {
      log.info('No text messages to summarize');
      return { timestamp: new Date().toISOString(), source: 'ai:telegram-summary', data: null, status: 'skipped', error: 'No text messages to summarize' };
    }

    // --- Delta detection ---
    let lastSummarizedAt = null;
    if (metaRaw) {
      try {
        const meta = typeof metaRaw === 'string' ? JSON.parse(metaRaw) : metaRaw;
        lastSummarizedAt = meta.lastSummarizedAt ? new Date(meta.lastSummarizedAt) : null;
      } catch (_) { /* ignore */ }
    }

    if (lastSummarizedAt) {
      const lastTs = lastSummarizedAt.getTime() / 1000;
      const newMessages = textMessages.filter((m) => {
        const msgTs = m.date || (m.ts ? new Date(m.ts).getTime() / 1000 : 0);
        return msgTs > lastTs;
      });
      if (newMessages.length < MIN_NEW_MESSAGES) {
        log.info('Telegram summary: insufficient new messages, skipping', {
          newCount: newMessages.length, threshold: MIN_NEW_MESSAGES,
        });
        return { timestamp: new Date().toISOString(), source: 'ai:telegram-summary', data: null, status: 'skipped', error: `insufficient new messages (${newMessages.length} < ${MIN_NEW_MESSAGES})` };
      }
    }

    // --- Build prompt payload ---
    let previousCrossDigest = null;
    if (previousSummaryRaw) {
      try {
        const prev = typeof previousSummaryRaw === 'string' ? JSON.parse(previousSummaryRaw) : previousSummaryRaw;
        const prevData = prev?.data ?? prev;
        previousCrossDigest = prevData?.crossChannelDigest || null;
      } catch (_) { /* ignore */ }
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
      try { parsed = extractJson(result.content); } catch (_) { /* fallback */ }
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

    await redis.set('ai:telegram-summary:meta', JSON.stringify({
      lastSummarizedAt: new Date().toISOString(),
      messageCount: textMessages.length,
    }));

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
    return { timestamp: new Date().toISOString(), source: 'ai:telegram-summary', data: null, status: 'error', error: err.message };
  }
};

module.exports.groupMessagesByChannel = groupMessagesByChannel;
```

**Step 4: Run tests to verify they pass**

Run: `cd services && node --test ai-engine/test/generators/telegram-summary.test.cjs 2>&1 | tail -20`
Expected: PASS — both delta detection and single-call batch tests pass

**Step 5: Run TypeScript/lint checks**

Run: `npm run lint --prefix services 2>&1 | tail -20`

**Step 6: Commit**

```bash
git add services/ai-engine/generators/telegram-summary.cjs services/ai-engine/test/generators/telegram-summary.test.cjs
git commit -m "feat(telegram-summary): rewrite to single-call batch architecture

Replaces 13 sequential LLM calls with 1 batch call.
Adds provider-aware truncation to prevent context overflow.
Reduces expected run time from 50-540s to 3-8s."
```

---

### Task 4: Update Supabase LLM Prompt

**Files:**
- Create: `supabase/migrations/2026031112XXXX_telegram_batch_prompt.sql` (use actual timestamp)

**Step 1: Write the migration**

The `telegram_channel_summary` prompt key needs to be updated (or a new one inserted) to match the batch format. This prompt is fetched by `callLLMForFunction` via `fetchPrompt`.

```sql
-- Update the telegram_channel_summary prompt for single-call batch mode
insert into wm_admin.llm_prompts (key, system_prompt, user_prompt, variant, mode)
values (
  'telegram_channel_summary',
  'You are a senior OSINT analyst. Current date: {date}.

Analyze Telegram channel messages and produce a JSON response with:
1. channelSummaries: array of per-channel objects with fields: channel (handle), channelTitle, summary (2-3 sentences), themes (2-4 keywords), sentiment (alarming|routine|escalatory|de-escalatory|mixed), messageCount
2. crossChannelDigest: 3-5 sentence cross-channel analysis identifying patterns across sources
3. earlyWarnings: array of events corroborated by 2+ channels
4. changes: array of new/escalation/de-escalation/resolved developments vs previous digest
5. previousSummaryComparison: one sentence comparing to previous digest

Respond with ONLY valid JSON. Include a channelSummary entry for every channel provided.',
  '{channelMessages}',
  null,
  'batch'
)
on conflict (key, coalesce(variant, ''::text), coalesce(mode, ''::text))
do update set
  system_prompt = excluded.system_prompt,
  user_prompt = excluded.user_prompt,
  updated_at = now();
```

**Step 2: Apply migration via Supabase MCP**

Use the Supabase MCP tool to apply the migration.

**Step 3: Commit**

```bash
git add supabase/migrations/
git commit -m "feat(telegram-summary): add batch prompt to llm_prompts"
```

---

### Task 5: Deploy and Verify

**Step 1: Build and push Docker image**

Run: `cd services && docker compose build ai-engine`

**Step 2: Deploy to production**

SSH to 10.230.255.80 and pull/restart the ai-engine container.

**Step 3: Watch logs for the first run**

```bash
ssh ubuntu@10.230.255.80 "docker logs worldmon-ai-engine-1 -f 2>&1 | grep -i telegram"
```

Expected output within 5 minutes:
- `Telegram summary: single-call batch` with channelCount, estimatedTokens
- `Telegram summary: complete` with channelSummaryCount, provider
- `Execute complete ... ai:telegram-summary ... duration_ms` showing < 15000 (15s)
- OR `insufficient new messages, skipping` if delta detection triggers

**Step 4: Verify on subsequent runs that delta detection works**

Watch for `skipping` entries when there are < 3 new messages between runs.

**Step 5: Commit any fixes found during verification**

```bash
git add -A && git commit -m "fix(telegram-summary): post-deploy adjustments"
```
