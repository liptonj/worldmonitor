# Ollama Qwen3:14B Setup Guide

**Date:** 2026-03-03
**Hardware:** MacBook Pro M4 Max, 32GB unified memory
**Model:** Qwen3:14B (9.3GB, Q4_K_M)

## Decision Summary

Qwen3:14B was chosen over Gemma 3:27B, Phi-4-reasoning-plus, DeepSeek-R1-14B, and Mistral Small 3.1 because it offers the best balance of:

- Broad world knowledge for geopolitical analysis
- Toggleable thinking mode (deep reasoning for deduction, fast mode for summaries)
- Best-in-class multilingual support (100+ languages)
- 131K context window (largest in the 14B class)
- Comfortable memory fit (9.3GB model + 8K context = ~13GB, leaving 19GB free)
- Direct upgrade from the existing qwen3:8b — same prompt format, no code rewrite

## Server Setup Commands

Run these on the Ollama server (ollama.5ls.us):

```bash
# 1. Pull the model
ollama pull qwen3:14b

# 2. Verify download
ollama list

# 3. Quick smoke test
ollama run qwen3:14b "Summarize the geopolitical situation in Eastern Europe in 2 sentences."

# 4. Create a custom model profile with optimized defaults
cat > /tmp/Modelfile-qwen3-wm <<'EOF'
FROM qwen3:14b
PARAMETER num_ctx 8192
PARAMETER temperature 0.3
PARAMETER top_p 0.9
PARAMETER top_k 20
PARAMETER repeat_penalty 1.0
EOF

ollama create qwen3-wm -f /tmp/Modelfile-qwen3-wm

# 5. Verify the custom model
ollama list
# Should show both qwen3:14b and qwen3-wm

# 6. Test the custom model
ollama run qwen3-wm "What are the key risks in the South China Sea? /nothink"

# 7. Test thinking mode
ollama run qwen3-wm "Analyze what happens if Iran closes the Strait of Hormuz. Consider second-order economic and military effects. /think"

# 8. Test structured JSON output (classification task)
ollama run qwen3-wm 'Classify this headline into threat level and category. Return ONLY JSON: {"level":"...","category":"..."} Levels: critical, high, medium, low, info. Categories: conflict, protest, disaster, diplomatic, economic, terrorism, cyber, health, environmental, military, crime, infrastructure, tech, general. Headline: "Russia launches largest drone strike on Kyiv in months" /nothink'

# 9. (Optional) Remove the old 8B model to free disk space
# ollama rm qwen3:8b
```

## API Smoke Tests

Test via the OpenAI-compatible endpoint (same path WorldMonitor uses):

```bash
# Test non-thinking mode (summarization)
curl -s https://ollama.5ls.us/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3-wm",
    "messages": [
      {"role": "system", "content": "Summarize the single most important headline in 2 concise sentences MAX (under 60 words total). /nothink"},
      {"role": "user", "content": "1. US imposes new sanctions on Russian oil exports\n2. Earthquake hits Turkey, 4.7 magnitude\n3. NATO allies agree to increase defense spending to 3% GDP"}
    ],
    "temperature": 0.3,
    "max_tokens": 300
  }' | python3 -m json.tool

# Test thinking mode (deduction) — note higher max_tokens
curl -s https://ollama.5ls.us/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3-wm",
    "messages": [
      {"role": "system", "content": "You are a senior geopolitical intelligence analyst and forecaster."},
      {"role": "user", "content": "What happens if China blockades Taiwan in the next 6 months? Consider military, economic, and diplomatic second-order effects. /think"}
    ],
    "temperature": 0.3,
    "max_tokens": 3000
  }' | python3 -m json.tool

# Test classification (JSON output)
curl -s https://ollama.5ls.us/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3-wm",
    "messages": [
      {"role": "system", "content": "You classify news headlines into threat level and category. Return ONLY valid JSON, no other text. /nothink"},
      {"role": "user", "content": "Major cyberattack disrupts European banking systems"}
    ],
    "temperature": 0,
    "max_tokens": 50
  }' | python3 -m json.tool
```

If your Ollama server uses Cloudflare Access, add these headers:

```bash
  -H "CF-Access-Client-Id: YOUR_CLIENT_ID" \
  -H "CF-Access-Client-Secret: YOUR_CLIENT_SECRET" \
```

## Per-Task Settings Reference

| Task | Temperature | max_tokens | Thinking | Why |
|---|---|---|---|---|
| Headline summary | 0.3 | 300 | OFF (`/nothink`) | Fast, factual, 2 sentences |
| Geopolitical deduction | 0.3 | 3000 | ON (`/think`) | Chain-of-thought reasoning |
| Country intel brief | 0.4 | 2000 | ON (`/think`) | Structured 5-section output |
| Event classification | 0.0 | 50 | OFF (`/nothink`) | Deterministic JSON label |
| Translation | 0.2 | 500 | OFF (`/nothink`) | Faithful translation |

## WorldMonitor Config Changes

After the Ollama server is confirmed working, update these values:

| Secret / Config | Old Value | New Value |
|---|---|---|
| `OLLAMA_MODEL` (Vault) | `qwen3:8b` | `qwen3-wm` |
| `OLLAMA_MAX_TOKENS` (Vault) | `1500` | `3000` |
| `llm_providers.default_model` (DB) | `qwen3:8b` | `qwen3-wm` |

These can be updated via the admin portal Secrets page or directly in Supabase.

## Context Window Rationale

**8192 tokens (8K)** was chosen because:

- Heaviest task (deduction with thinking) uses ~4000 tokens total
- 8K provides 2x headroom without wasting memory
- KV cache at 8K ≈ 4GB; at 40K it would be ~20GB (leaving nothing for the model)
- Ollama 0.17's 8-bit KV cache quantization further reduces this to ~2GB

## Memory Budget

| Component | Memory |
|---|---|
| Model weights (Q4_K_M) | ~9.3 GB |
| KV cache (8K context, 8-bit) | ~2 GB |
| Ollama overhead | ~1 GB |
| **Total Ollama** | **~12.3 GB** |
| macOS + apps | ~8 GB |
| **Free headroom** | **~11.7 GB** |

## Headlines Context Buffer (Redis)

Enriches deduction and country intel tasks with recent headlines — no vector database required.

### Problem

The LLM generates deductions and country briefs without knowing what's actually happening right now. The `geoContext` parameter is optionally passed by the client, but it's inconsistent and often empty. The model relies entirely on its training data, which can be months stale.

### Solution

Store the most recent headlines per-region in Redis sorted sets (scored by timestamp). Before calling the LLM for deduction or country intel, pull the 10-20 most recent relevant headlines and inject them as context.

### Data Flow

```
RSS Feed Fetch (list-feed-digest.ts)
  └─ After parsing, push top headlines into Redis sorted sets
       ├─ wm:headlines:recent:global     (top 50 headlines, 24h TTL)
       ├─ wm:headlines:recent:US         (country-specific, 50 headlines)
       ├─ wm:headlines:recent:conflict   (category-specific, 50 headlines)
       └─ ...

LLM Call (deduct-situation.ts / get-country-intel-brief.ts)
  └─ Before building prompt, fetch relevant headlines from Redis
       ├─ deduction: pull from global + relevant category
       ├─ country intel: pull from country code + global
       └─ Inject as "### Recent Headlines" section in user prompt
```

### Redis Key Design

```
Key pattern:   wm:headlines:recent:{scope}
Type:          Sorted Set (ZSET)
Score:         Unix timestamp (ms)
Member:        headline text (deduplicated by content)
Max members:   50 per key
TTL:           86400 seconds (24 hours)
```

Scopes:
- `global` — all headlines regardless of region
- `{ISO country code}` — headlines tagged with a specific country (e.g., `US`, `RU`, `UA`)
- `{category}` — headlines from a specific feed category (e.g., `conflict`, `tech`, `economic`)

### Ingestion Point

In `list-feed-digest.ts`, after `parseRssXml()` returns parsed items, push the top headlines into Redis. This runs on every digest refresh (~15 min cache TTL), keeping the buffer fresh without adding new infrastructure.

```typescript
// After parsing feeds, push headlines to Redis context buffer
async function pushHeadlinesToRedis(
  items: ParsedItem[],
  category: string,
): Promise<void> {
  const redis = getRedisClient();
  if (!redis || items.length === 0) return;

  const now = Date.now();
  const globalKey = 'wm:headlines:recent:global';
  const categoryKey = `wm:headlines:recent:${category}`;

  const entries = items.slice(0, 20).map(item => ({
    score: item.pubDate ?? now,
    member: item.title.slice(0, 200),
  }));

  try {
    // Add to global and category sets
    await Promise.all([
      redis.zadd(globalKey, ...entries.flatMap(e => [{ score: e.score, member: e.member }])),
      redis.zadd(categoryKey, ...entries.flatMap(e => [{ score: e.score, member: e.member }])),
    ]);

    // Trim to 50 most recent + set TTL
    await Promise.all([
      redis.zremrangebyrank(globalKey, 0, -51),
      redis.zremrangebyrank(categoryKey, 0, -51),
      redis.expire(globalKey, 86400),
      redis.expire(categoryKey, 86400),
    ]);
  } catch { /* non-fatal */ }
}
```

### Retrieval Before LLM Call

```typescript
async function getRecentHeadlines(
  scopes: string[],
  limit: number = 15,
): Promise<string[]> {
  const redis = getRedisClient();
  if (!redis) return [];

  const seen = new Set<string>();
  const headlines: string[] = [];

  for (const scope of scopes) {
    try {
      const items = await redis.zrevrange(
        `wm:headlines:recent:${scope}`,
        0, limit - 1,
      );
      for (const item of items) {
        const text = typeof item === 'string' ? item : String(item);
        if (!seen.has(text)) {
          seen.add(text);
          headlines.push(text);
        }
      }
    } catch { /* non-fatal */ }
  }

  return headlines.slice(0, limit);
}
```

### Prompt Injection

For deduction:
```typescript
const recentHeadlines = await getRecentHeadlines(['global', category]);
if (recentHeadlines.length > 0) {
  userPrompt += `\n\n### Recent Headlines\n${recentHeadlines.map((h, i) => `${i + 1}. ${h}`).join('\n')}`;
}
```

For country intel:
```typescript
const recentHeadlines = await getRecentHeadlines([req.countryCode, 'global']);
if (recentHeadlines.length > 0) {
  userPromptParts.push(`Recent headlines:\n${recentHeadlines.map((h, i) => `${i + 1}. ${h}`).join('\n')}`);
}
```

### Memory & Performance Impact

| Metric | Value |
|---|---|
| Redis memory per scope | ~5-10 KB (50 headlines x ~200 chars) |
| Total Redis memory (20 scopes) | ~200 KB |
| Retrieval latency | <5ms (Redis sorted set) |
| Extra tokens per LLM call | ~200-400 tokens (15 headlines) |
| Impact on 8K context budget | Minimal — adds ~5% to deduction's ~4000 token total |

### Why NOT Full Vector RAG

| Full Vector RAG | Headlines Buffer |
|---|---|
| Needs Redis Stack or pgvector | Uses existing Upstash Redis |
| Needs server-side embedding model | No embedding model needed |
| Complex ingestion pipeline | 10 lines in existing feed parser |
| ~50ms retrieval + embedding time | <5ms retrieval |
| Finds semantically similar content | Provides chronologically recent content |

For intelligence analysis, **recency matters more than similarity**. The LLM needs to know what happened today, not what's semantically related to the query. The model's own reasoning (especially with thinking mode) handles the relevance filtering.

## Cleanup (After Verification)

Once the new model is confirmed working in production:

```bash
# Remove old model to free 5.2GB
ollama rm qwen3:8b

# Clean up temp Modelfile
rm /tmp/Modelfile-qwen3-wm
```
