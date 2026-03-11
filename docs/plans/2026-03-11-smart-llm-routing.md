# Smart LLM Routing Design

**Date:** 2026-03-11
**Status:** Approved

## Problem

The AI engine has no intelligence about which LLM provider to use for which task:

1. **No rate limiting** — requests fire as fast as possible, hitting Groq/OpenRouter RPM limits
2. **No complexity awareness** — Ollama gets heavyweight tasks (intel digest, cross-channel analysis) that it struggles with, while cloud providers sit idle
3. **No context window awareness** — large prompts get sent to providers that can't handle them, wasting time on inevitable failures
4. **No backoff on 429s** — when a provider returns 429, the engine just falls to the next provider with no cooldown, guaranteeing repeated 429s on the next cycle

## Solution: Database-Driven Smart Routing

### Schema Changes

#### `wm_admin.llm_providers` — new columns

| Column | Type | Default | Purpose |
|---|---|---|---|
| `requests_per_minute` | integer | 60 | Provider's RPM limit |
| `tokens_per_minute` | integer | 0 | Provider's TPM limit (0 = unlimited) |
| `context_window` | integer | 8192 | Max input tokens the model supports |
| `complexity_cap` | text | `'heavy'` | Max complexity tier: `light`, `medium`, `heavy` |

Recommended provider values:

| Provider | RPM | TPM | Context Window | Complexity Cap |
|---|---|---|---|---|
| ollama | 60 | 0 | 8192 | medium |
| groq | 30 | 15000 | 32768 | heavy |
| openrouter | 60 | 0 | 32768 | heavy |

#### `wm_admin.llm_function_config` — new column

| Column | Type | Default | Purpose |
|---|---|---|---|
| `complexity` | text | `'medium'` | Task complexity tier |

Complexity assignments:

| Function | Complexity | Rationale |
|---|---|---|
| classify_event | light | Short output, simple task |
| news_summary | light | Brief article summary |
| telegram_channel_summary | medium | Single channel, moderate context |
| country_brief | medium | Focused analysis |
| posture_analysis | heavy | Multi-source synthesis |
| instability_analysis | heavy | Multi-source synthesis |
| risk_overview | heavy | Multi-source synthesis |
| intel_digest | heavy | Large context, complex reasoning |
| telegram_cross_channel | heavy | Cross-channel synthesis |
| panel_summary | heavy | Full panel analysis |
| panel_summary_arbiter | heavy | Synthesis of summaries |
| deduction | heavy | User-triggered deep analysis |

### Routing Logic Changes (`services/shared/llm.cjs`)

#### 1. Token Estimation

```javascript
function estimateTokens(text) {
  return Math.ceil(String(text).length / 4);
}
```

#### 2. Complexity Tier Ordering

`light` < `medium` < `heavy`. A provider with `complexity_cap = 'medium'` can handle `light` and `medium` tasks but not `heavy`.

#### 3. Provider Eligibility Filter

Before trying a provider, check:
- `provider.complexity_cap >= function.complexity` (tier comparison)
- `estimateTokens(prompt) < provider.context_window * 0.85` (context fits)
- `!isRateLimited(provider)` (RPM not exceeded)
- `!isInCooldown(provider)` (not in 429 backoff)

#### 4. In-Memory Rate Tracking

Sliding window RPM counter per provider. Resets every 60 seconds.

#### 5. Exponential Backoff on 429

When a provider returns HTTP 429:
- Track consecutive 429 count per provider
- Cooldown = `min(300s, 15s * 2^(count-1))` → 15s, 30s, 60s, 120s, 300s
- After cooldown expires, decrement count by 1 (gradual recovery)
- Skip provider during cooldown, try next in chain

#### 6. Updated `callLLMForFunction` Flow

```
1. Fetch function config (complexity, provider_chain, timeout)
2. Fetch all enabled providers
3. Filter by provider_chain
4. For each provider in chain:
   a. Check complexity_cap >= function complexity → skip if not
   b. Estimate prompt tokens, check context_window → skip if too large
   c. Check rate limit (RPM) → skip if exceeded
   d. Check cooldown (429 backoff) → skip if in cooldown
   e. Try LLM call
   f. On success: record call in rate ledger, return result
   g. On 429: mark rate-limited with backoff, continue to next
   h. On other error: log, continue to next
5. If all providers exhausted: throw with summary
```

### RPC Updates

`get_all_enabled_providers()` — add new columns to return:
- `requests_per_minute`
- `tokens_per_minute`
- `context_window`
- `complexity_cap`

`get_llm_function_config()` — add to return:
- `complexity`

### Admin UI Updates

`src/admin/pages/llm-config.ts`:
- Show new provider fields (RPM, TPM, context window, complexity cap)
- Show complexity tier on function config cards
- Allow editing via existing admin API

### API Updates

`api/admin/llm-providers.ts` and `api/admin/llm-function-configs.ts`:
- Accept and persist new fields

## Implementation Steps

1. Supabase migration: add columns, update RPCs, seed defaults
2. Update `services/shared/llm.cjs`: add rate tracking, backoff, eligibility filtering
3. Update `buildProviderConfig` to include new fields
4. Update admin API routes for new fields
5. Update admin UI to display/edit new fields
6. Update provider_chain defaults: heavy tasks should have `{groq,openrouter,ollama}` fallback order
7. Deploy and verify

## Testing

- Unit test: complexity tier comparison function
- Unit test: token estimation
- Unit test: rate limiter sliding window
- Unit test: backoff state machine
- Integration: verify provider chain skips Ollama for heavy tasks
- Integration: verify 429 triggers backoff and recovery
