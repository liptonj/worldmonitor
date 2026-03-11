# Telegram Summary: Single-Call Batch Redesign

**Date:** 2026-03-11
**Status:** Approved

## Problem

The telegram summary generator makes 13 sequential LLM calls per run (12 per-channel + 1 cross-channel synthesis), running every 5 minutes. This causes three compounding failures:

1. **Cost:** ~3,456 LLM calls/day burning ~5.2M tokens/day — 10x over Groq's 500K free-tier daily limit
2. **Reliability:** When any provider fails, each channel still attempts every provider in sequence. 75 failed channel summaries in 2 hours is typical
3. **Speed:** Successful runs take ~52 seconds. Failed runs take 430–542 seconds because Ollama times out at 30–60s per channel, multiplied by 12 channels

## Design

### 1. Single-Call Architecture

Replace 13 sequential LLM calls with 1 batch call.

**Current flow:**
```
for each of 12 channels:
    LLM call → per-channel summary  (30–60s each on failure)
then:
    LLM call → cross-channel synthesis
= 13 LLM calls, 50–540 seconds
```

**New flow:**
```
1. Gather all messages from Redis
2. Group by channel, truncate to fit provider context
3. ONE LLM call → per-channel summaries + cross-channel digest
= 1 LLM call, 3–8 seconds
```

The prompt includes all channels' messages (truncated per provider) and asks for a single structured JSON response containing both per-channel summaries and cross-channel analysis.

### 2. Smart Scheduling (Delta-Based)

Only invoke the LLM when there are enough new messages to justify the cost.

- Store `lastSummarizedAt` timestamp and a message-set hash in Redis after each successful run
- On each cron tick (still every 5 min), count new messages since `lastSummarizedAt`
- Decision matrix:
  - **< 3 new messages:** skip entirely
  - **3–10 new messages:** run (low activity)
  - **10+ new messages:** run immediately (spike)

Estimated impact: ~50–100 runs/day instead of ~288, saving 60–80% of token budget.

### 3. Token Budgeting and Provider-Aware Truncation

Prevent context-overflow errors by truncating the prompt *before* sending it, sized to the target provider.

**Per-provider targets:**
- Groq (32K context): full payload, up to ~10K input tokens
- Ollama (8K context): compact payload, ~6K input tokens max

**Progressive truncation (applied if prompt exceeds target):**
1. Reduce MAX_CHANNEL_MSGS from 15 → 8 → 5 → 3
2. Truncate each message from 300 → 150 chars
3. Drop least-active channels entirely

**For the Ollama fallback:** pre-build a "compact" variant — top 5 channels, 3 messages each, 150 chars per message — that always fits within 8K context.

**Daily quota awareness:**
- Existing `markProviderRateLimited` / `isInCooldown` handles Groq's 500K TPD hard cutoff
- Budget: ~4,000 tokens/run × ~100 runs/day = ~400K tokens (within 500K limit)

### 4. Output Format (No Frontend Changes)

The output structure written to `ai:telegram-summary:v1` in Redis remains identical:

```json
{
  "channelSummaries": [{ "channel", "channelTitle", "summary", "themes", "sentiment", "messageCount" }],
  "crossChannelDigest": "...",
  "earlyWarnings": [...],
  "changes": [...],
  "previousSummaryComparison": "...",
  "messageCount": 200,
  "channelCount": 12,
  "model": "...",
  "provider": "...",
  "generatedAt": "..."
}
```

The `TelegramSummaryPanel`, channel registry (`ai:telegram-summary`), and WebSocket push path are unchanged.

### 5. Error Handling

- **One call, one failure point.** If it fails, the run completes in seconds, not minutes
- **Graceful degradation:** Groq fails → try Ollama with compact payload → if both fail, keep previous summary in Redis (stale but valid per `staleAfterMs: 10 * 60_000`)
- **No log spam:** eliminates the "Failed to summarize channel" ×75 pattern

## Token Math

| Metric | Current | New |
|---|---|---|
| LLM calls/run | 13 | 1 |
| Runs/day | ~288 | ~50–100 |
| Tokens/run | ~1,500 × 13 = ~19,500 | ~4,000 |
| Tokens/day | ~5.2M (10× over limit) | ~200–400K (within 500K) |
| Duration (success) | ~52s | ~3–8s |
| Duration (all-fail) | ~430–540s | ~3–5s |

## Files Changed

- `services/ai-engine/generators/telegram-summary.cjs` — rewrite generator logic
- `services/shared/llm.cjs` — no changes needed (existing `callLLMForFunction` handles the single call)
- Supabase `llm_prompts` — add/update prompt for the combined summary
- No frontend changes
- No orchestrator/cron changes (generator short-circuits internally)

## Risks

- Single-call output quality may differ slightly from per-channel calls (LLM has more context to juggle). Mitigated by clear prompt structure with per-channel sections
- Ollama compact fallback covers fewer channels. Acceptable trade-off vs. total failure
