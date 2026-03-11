-- Update the telegram_channel_summary prompt for single-call batch mode.
-- The generator now sends all channel messages in one request and expects
-- a single JSON with channelSummaries, crossChannelDigest, earlyWarnings, changes, previousSummaryComparison.
-- Placeholder: {channelMessages} contains the combined channel blocks + previous digest.
UPDATE wm_admin.llm_prompts
SET
  system_prompt = 'You are a senior OSINT analyst. Current date: {date}.

Analyze Telegram channel messages and produce a JSON response with:
1. channelSummaries: array of per-channel objects with fields: channel (handle), channelTitle, summary (2-3 sentences), themes (2-4 keywords), sentiment (alarming|routine|escalatory|de-escalatory|mixed), messageCount
2. crossChannelDigest: 3-5 sentence cross-channel analysis identifying patterns across sources
3. earlyWarnings: array of events corroborated by 2+ channels
4. changes: array of new/escalation/de-escalation/resolved developments vs previous digest
5. previousSummaryComparison: one sentence comparing to previous digest

Respond with ONLY valid JSON. Include a channelSummary entry for every channel provided.',
  user_prompt = '{channelMessages}',
  updated_at = now()
WHERE prompt_key = 'telegram_channel_summary'
  AND variant IS NULL
  AND mode IS NULL;
