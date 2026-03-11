-- =============================================================
-- Migration: Seed AI prompts + function config + service config
--            for Telegram channel summarization
--
-- Purpose:
--   Phase 2 Task 1 - Seed the database with prompts, function config,
--   and service config for AI Telegram summarization.
--
-- Creates:
--   1. LLM prompts in wm_admin.llm_prompts:
--      - telegram_channel_summary: per-channel summaries with themes, sentiment
--      - telegram_cross_channel: cross-channel digest with early warnings and delta
--   2. Function config in wm_admin.llm_function_config:
--      - Both functions use {ollama} provider chain, 120s timeout
--   3. Service config in wm_admin.service_config:
--      - ai:telegram-summary runs every 5 minutes (2-59/5 * * * *), TTL 300s
--
-- Affected tables: wm_admin.llm_prompts, wm_admin.llm_function_config,
--                  wm_admin.service_config
-- =============================================================

-- 1. Prompts (check if exists first, only insert if not)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM wm_admin.llm_prompts WHERE prompt_key = 'telegram_channel_summary') THEN
    INSERT INTO wm_admin.llm_prompts (prompt_key, variant, mode, model_name, system_prompt, user_prompt)
    VALUES ('telegram_channel_summary', null, null, null,
   'You are an OSINT analyst specializing in Telegram channel monitoring. Current date: {date}.

Analyze the following messages from monitored Telegram channels grouped by channel. For each channel that has messages, produce a detailed summary including:
- Key themes and topics being discussed
- Notable or significant messages (quote briefly)
- Overall sentiment (e.g. alarming, routine, escalatory, de-escalatory)
- Message count

You MUST respond with ONLY valid JSON, no prose, no markdown fences. Use this exact structure:
{
  "channelSummaries": [
    {
      "channel": "handle",
      "channelTitle": "Display Name",
      "summary": "2-4 sentence summary",
      "themes": ["theme1", "theme2"],
      "sentiment": "alarming|routine|escalatory|de-escalatory|mixed",
      "messageCount": 12
    }
  ]
}

Only include channels that have messages. Order by significance (most noteworthy first).',

   'Here are the latest messages from {channelCount} monitored Telegram OSINT channels, grouped by channel:

{channelMessages}

Produce detailed per-channel summaries.');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM wm_admin.llm_prompts WHERE prompt_key = 'telegram_cross_channel') THEN
    INSERT INTO wm_admin.llm_prompts (prompt_key, variant, mode, model_name, system_prompt, user_prompt)
    VALUES ('telegram_cross_channel', null, null, null,
   'You are a senior intelligence analyst. Current date: {date}.

You are given per-channel summaries from {channelCount} Telegram OSINT channels, plus the previous cross-channel digest from ~5 minutes ago.

Your tasks:
1. SITUATIONAL OVERVIEW: Synthesize a 3-5 sentence cross-channel situational awareness digest. What are the key developments right now?
2. EARLY WARNINGS: Identify events or developments being reported by 2+ channels simultaneously. These are higher-confidence signals. Rate confidence as high (3+ channels), medium (2 channels).
3. CHANGES SINCE LAST SUMMARY: Compare against the previous summary and call out:
   - "new": Developments not present in the previous summary
   - "escalation": Situations that have intensified
   - "de-escalation": Situations that have calmed
   - "resolved": Events from the previous summary no longer being reported
4. COMPARISON: One sentence summarizing what changed overall.

You MUST respond with ONLY valid JSON, no prose, no markdown fences. Use this exact structure:
{
  "crossChannelDigest": "3-5 sentence overview",
  "earlyWarnings": [
    { "event": "description", "reportedBy": ["Channel1", "Channel2"], "confidence": "high|medium" }
  ],
  "changes": [
    { "type": "new|escalation|de-escalation|resolved", "description": "what changed" }
  ],
  "previousSummaryComparison": "one sentence comparing to 5 minutes ago"
}

If there is no previous summary, treat everything as "new".',

   'Per-channel summaries:
{channelSummaries}

Previous cross-channel digest (from ~5 minutes ago):
{previousSummary}

Produce the cross-channel digest, early warnings, and change analysis.');
  END IF;
END $$;

-- 2. Function config (using on conflict with the actual primary key)
INSERT INTO wm_admin.llm_function_config (function_key, provider_chain, timeout_ms, description)
VALUES
  ('telegram_channel_summary', '{ollama}', 120000, 'Per-channel Telegram summaries'),
  ('telegram_cross_channel', '{ollama}', 120000, 'Cross-channel Telegram digest with delta')
ON CONFLICT (function_key) DO NOTHING;

-- 3. Service config (using on conflict with the actual primary key)
INSERT INTO wm_admin.service_config (service_key, cron_schedule, redis_key, ttl_seconds, fetch_type, description, settings)
VALUES
  ('ai:telegram-summary', '2-59/5 * * * *', 'ai:telegram-summary:v1', 300, 'custom', 'AI Telegram channel summaries with cross-channel digest', '{}')
ON CONFLICT (service_key) DO NOTHING;
