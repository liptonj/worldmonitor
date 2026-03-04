# Qwen3:14B + Headlines Context Buffer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Upgrade Ollama from qwen3:8b to qwen3:14b with per-task thinking mode toggles, and add a Redis-based recent headlines buffer that enriches deduction and country intel prompts with real-time context.

**Architecture:** Two independent changes: (1) Model upgrade + thinking mode toggles in existing LLM call sites, (2) Redis sorted set buffer that stores headlines during feed digest builds and injects them before LLM calls. Both use existing infrastructure (Ollama OpenAI-compatible API, Upstash Redis).

**Tech Stack:** TypeScript (Vercel Edge Functions), Upstash Redis (@upstash/redis SDK), Ollama OpenAI-compatible API (/v1/chat/completions)

---

## Part 1: Model Upgrade + Thinking Mode

### Task 1: Update Ollama seed migration

**Files:**
- Modify: `supabase/migrations/20260303000004_seed_ollama_config.sql`

**Step 1: Update the default model and max tokens in the migration**

Change `qwen3:8b` to `qwen3-wm` (the custom Modelfile profile) and update OLLAMA_MAX_TOKENS from 1500 to 3000.

```sql
-- In the INSERT INTO wm_admin.llm_providers block:
-- Change: 'qwen3:8b' → 'qwen3-wm'

-- In the OLLAMA_MODEL vault secret block:
-- Change: 'qwen3:8b' → 'qwen3-wm'

-- In the OLLAMA_MAX_TOKENS vault secret block:
-- Change: '1500' → '3000'
```

**Step 2: Verify the SQL is valid**

Run: `grep -n 'qwen3' supabase/migrations/20260303000004_seed_ollama_config.sql`
Expected: All references should show `qwen3-wm`, not `qwen3:8b`

**Step 3: Commit**

```bash
git add supabase/migrations/20260303000004_seed_ollama_config.sql
git commit -m "chore: upgrade Ollama model from qwen3:8b to qwen3-wm (14b)"
```

---

### Task 2: Add thinking mode toggle to summarize-article

**Files:**
- Modify: `server/worldmonitor/news/v1/_shared.ts`

**Step 1: Add `/nothink` suffix to all system prompts in `buildArticlePrompts`**

In `_shared.ts`, the function `buildArticlePrompts` builds system prompts for brief, analysis, translate, and default modes. Append `/nothink` to the end of every system prompt returned by this function. Summarization is a fast task that does not benefit from chain-of-thought reasoning.

Find every `systemPrompt = ...` assignment and every return path. Add ` /nothink` to the end of each system prompt string, just before the closing backtick or quote.

For the DB-managed prompt path (when `dbPrompt?.systemPrompt` exists), append `/nothink` after the `buildPrompt()` call:

```typescript
return {
  systemPrompt: buildPrompt(dbPrompt.systemPrompt, { dateContext, langInstruction }) + ' /nothink',
  userPrompt: buildPrompt(dbPrompt.userPrompt ?? '', { headlineText, intelSection }),
};
```

For the hardcoded prompt paths (brief, analysis, translate, default), append ` /nothink` to the end of each systemPrompt string. Example for the brief non-tech case:

```typescript
systemPrompt = `${dateContext}

Summarize the single most important headline in 2 concise sentences MAX (under 60 words total).
Rules:
- Each numbered headline below is a SEPARATE, UNRELATED story
...
- No bullet points, no meta-commentary, no elaboration beyond the core facts${langInstruction} /nothink`;
```

Apply the same pattern to all 6 systemPrompt assignments in the function.

**Step 2: Verify the change compiles**

Run: `npx tsc --noEmit server/worldmonitor/news/v1/_shared.ts` (or the project's type check command)
Expected: No type errors

**Step 3: Commit**

```bash
git add server/worldmonitor/news/v1/_shared.ts
git commit -m "feat: add /nothink to summarization prompts for faster Qwen3 responses"
```

---

### Task 3: Add thinking mode toggle to deduct-situation

**Files:**
- Modify: `server/worldmonitor/intelligence/v1/deduct-situation.ts`

**Step 1: Append `/think` to the user prompt**

In `deductSituation`, find where `userPrompt` is built (around line 48-51). After the geo context is appended, add the `/think` suffix:

```typescript
let userPrompt = query;
if (geoContext) {
  userPrompt += `\n\n### Current Intelligence Context\n${geoContext}`;
}
userPrompt += ' /think';
```

**Step 2: Increase max_tokens from 1500 to 3000**

Find the `max_tokens: 1500` in the fetch body (around line 69) and change to `3000`. The thinking tokens count against the limit, so the model needs more room.

```typescript
body: JSON.stringify({
  model,
  messages: [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ],
  temperature: 0.3,
  max_tokens: 3000,
}),
```

**Step 3: Verify the `<think>` tag stripping still works**

The existing code at line 83 already strips thinking tags:
```typescript
raw = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
```
No change needed — just verify it's still present.

**Step 4: Commit**

```bash
git add server/worldmonitor/intelligence/v1/deduct-situation.ts
git commit -m "feat: enable thinking mode for geopolitical deduction (Qwen3 /think)"
```

---

### Task 4: Add thinking mode toggle to classify-event

**Files:**
- Modify: `server/worldmonitor/intelligence/v1/classify-event.ts`

**Step 1: Append `/nothink` to the system prompt**

Classification is a simple JSON label task. Find the `systemPrompt` constant (around line 61) and append `/nothink`:

```typescript
const systemPrompt = `You classify news headlines into threat level and category. Return ONLY valid JSON, no other text.

Levels: critical, high, medium, low, info
Categories: conflict, protest, disaster, diplomatic, economic, terrorism, cyber, health, environmental, military, crime, infrastructure, tech, general

Focus: geopolitical events, conflicts, disasters, diplomacy. Classify by real-world severity and impact.

Return: {"level":"...","category":"..."} /nothink`;
```

**Step 2: Commit**

```bash
git add server/worldmonitor/intelligence/v1/classify-event.ts
git commit -m "feat: add /nothink to classification prompt for faster Qwen3 responses"
```

---

### Task 5: Add thinking mode toggle to get-country-intel-brief

**Files:**
- Modify: `server/worldmonitor/intelligence/v1/get-country-intel-brief.ts`

**Step 1: Append `/think` to the user prompt**

Country intel briefs benefit from structured reasoning. Find where `userPromptParts` is built (around line 72-77) and add `/think` at the end:

```typescript
const userPromptParts = [
  `Country: ${countryName} (${req.countryCode})`,
];
if (contextSnapshot) {
  userPromptParts.push(`Context snapshot:\n${contextSnapshot}`);
}
userPromptParts.push('/think');
```

**Step 2: Increase max_tokens from 900 to 2000**

Find `max_tokens: 900` in the fetch body and change to `2000`:

```typescript
max_tokens: 2000,
```

**Step 3: Add `<think>` tag stripping to the response**

The country intel brief handler doesn't currently strip thinking tags. Add stripping before returning:

```typescript
let brief = data.choices?.[0]?.message?.content?.trim() || '';
brief = brief.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
if (!brief) return null;
```

**Step 4: Commit**

```bash
git add server/worldmonitor/intelligence/v1/get-country-intel-brief.ts
git commit -m "feat: enable thinking mode for country intel briefs (Qwen3 /think)"
```

---

## Part 2: Headlines Context Buffer

### Task 6: Create the headlines buffer module

**Files:**
- Create: `server/_shared/headlines-buffer.ts`

**Step 1: Create the module**

```typescript
import { getRedisClient } from './redis';

const BUFFER_TTL = 86400;
const MAX_PER_SCOPE = 50;
const MAX_HEADLINE_LEN = 200;

export async function pushHeadlines(
  headlines: Array<{ title: string; pubDate: number }>,
  scopes: string[],
): Promise<void> {
  const redis = getRedisClient();
  if (!redis || headlines.length === 0 || scopes.length === 0) return;

  const entries = headlines.slice(0, 20).map(h => ({
    score: h.pubDate,
    member: h.title.slice(0, MAX_HEADLINE_LEN),
  }));

  try {
    for (const scope of scopes) {
      const key = `wm:headlines:recent:${scope}`;
      for (const entry of entries) {
        await redis.zadd(key, { score: entry.score, member: entry.member });
      }
      await redis.zremrangebyrank(key, 0, -(MAX_PER_SCOPE + 1));
      await redis.expire(key, BUFFER_TTL);
    }
  } catch { /* non-fatal — buffer is best-effort */ }
}

export async function getRecentHeadlines(
  scopes: string[],
  limit: number = 15,
): Promise<string[]> {
  const redis = getRedisClient();
  if (!redis || scopes.length === 0) return [];

  const seen = new Set<string>();
  const results: string[] = [];

  for (const scope of scopes) {
    try {
      const items = await redis.zrange(
        `wm:headlines:recent:${scope}`,
        0, limit - 1,
        { rev: true },
      );
      for (const item of items) {
        const text = typeof item === 'string' ? item : String(item);
        if (text && !seen.has(text)) {
          seen.add(text);
          results.push(text);
        }
      }
    } catch { /* non-fatal */ }
  }

  return results.slice(0, limit);
}
```

**Step 2: Verify the module compiles**

Run: `npx tsc --noEmit server/_shared/headlines-buffer.ts`
Expected: No type errors

**Step 3: Commit**

```bash
git add server/_shared/headlines-buffer.ts
git commit -m "feat: add Redis headlines context buffer module"
```

---

### Task 7: Ingest headlines during feed digest builds

**Files:**
- Modify: `server/worldmonitor/news/v1/list-feed-digest.ts`

**Step 1: Import the buffer module**

Add at the top of the file with other imports:

```typescript
import { pushHeadlines } from '../../../_shared/headlines-buffer';
```

**Step 2: Push headlines after feed parsing**

In the `buildDigest` function, after the batch processing loop where results are collected (around line 250-256, after `results.set(category, items)`), add a fire-and-forget call to push headlines into Redis:

```typescript
for (const [category, items] of results) {
  // Existing code: build category buckets...

  // Push top headlines to Redis context buffer (fire-and-forget)
  pushHeadlines(
    items
      .filter(i => i.title)
      .sort((a, b) => (b.pubDate ?? 0) - (a.pubDate ?? 0))
      .slice(0, 20)
      .map(i => ({ title: i.title, pubDate: i.pubDate ?? Date.now() })),
    [category, 'global'],
  ).catch(() => {});
}
```

**Step 3: Verify the module compiles**

Run: `npx tsc --noEmit server/worldmonitor/news/v1/list-feed-digest.ts`
Expected: No type errors

**Step 4: Commit**

```bash
git add server/worldmonitor/news/v1/list-feed-digest.ts
git commit -m "feat: ingest headlines into Redis buffer during feed digest builds"
```

---

### Task 8: Inject recent headlines into deduction prompts

**Files:**
- Modify: `server/worldmonitor/intelligence/v1/deduct-situation.ts`

**Step 1: Import the buffer module**

```typescript
import { getRecentHeadlines } from '../../../_shared/headlines-buffer';
```

**Step 2: Fetch and inject headlines before the LLM call**

Inside the `cachedFetchJson` callback, after building the user prompt but before the `fetch` call, add:

```typescript
const recentHeadlines = await getRecentHeadlines(['global', 'conflict'], 15);
if (recentHeadlines.length > 0) {
  userPrompt += `\n\n### Recent Headlines\n${recentHeadlines.map((h, i) => `${i + 1}. ${h}`).join('\n')}`;
}
```

**Step 3: Commit**

```bash
git add server/worldmonitor/intelligence/v1/deduct-situation.ts
git commit -m "feat: enrich deduction prompts with recent headlines from Redis buffer"
```

---

### Task 9: Inject recent headlines into country intel prompts

**Files:**
- Modify: `server/worldmonitor/intelligence/v1/get-country-intel-brief.ts`

**Step 1: Import the buffer module**

```typescript
import { getRecentHeadlines } from '../../../_shared/headlines-buffer';
```

**Step 2: Fetch and inject headlines before the LLM call**

Inside the `cachedFetchJson` callback, after building `userPromptParts` but before the `fetch` call, add:

```typescript
const recentHeadlines = await getRecentHeadlines([req.countryCode, 'global'], 15);
if (recentHeadlines.length > 0) {
  userPromptParts.push(`Recent headlines:\n${recentHeadlines.map((h, i) => `${i + 1}. ${h}`).join('\n')}`);
}
```

**Step 3: Commit**

```bash
git add server/worldmonitor/intelligence/v1/get-country-intel-brief.ts
git commit -m "feat: enrich country intel briefs with recent headlines from Redis buffer"
```

---

### Task 10: Update DB-managed LLM prompts for Qwen3

**Files:**
- Create: `supabase/migrations/20260304000002_update_llm_prompts_qwen3.sql`

**Step 1: Create the migration**

This migration updates the 5 existing DB prompts in `wm_admin.llm_prompts` and inserts 1 new one:

| Row | Change |
|-----|--------|
| `news_summary` (tech, brief) | Append ` /nothink` to system_prompt |
| `news_summary` (NULL, brief) | Append ` /nothink` to system_prompt |
| `news_summary` (tech, analysis) | Append ` /nothink` to system_prompt |
| `news_summary` (NULL, analysis) | Append ` /nothink` to system_prompt |
| `intel_brief` (NULL, NULL) | Replace system_prompt with `/think` suffix; add user_prompt with `{contextSnapshot}` and `{recentHeadlines}` placeholders |
| `deduction` (NULL, NULL) — **new** | Insert system prompt with `/think` and user prompt with `{query}`, `{geoContext}`, `{recentHeadlines}` placeholders |

**Why:** DB-managed prompts override hardcoded prompts when present. Without this migration, admin-customized prompts would lack the Qwen3 thinking toggles and headlines context, causing inconsistent behavior between the DB path and the hardcoded fallback path.

**Step 2: Verify SQL syntax**

Run: `psql -f supabase/migrations/20260304000002_update_llm_prompts_qwen3.sql --echo-errors` (dry-run on local Supabase)

**Step 3: Commit**

```bash
git add supabase/migrations/20260304000002_update_llm_prompts_qwen3.sql
git commit -m "feat: update DB prompts with Qwen3 thinking toggles and headlines placeholders"
```

---

### Task 11: Final verification and integration commit

**Files:**
- All modified files from Tasks 1-10

**Step 1: Run full type check**

Run: `npx tsc --noEmit`
Expected: No type errors across the project

**Step 2: Verify all changes compile together**

Run: `git diff --stat`
Expected: Changes in these files only:
- `supabase/migrations/20260303000004_seed_ollama_config.sql`
- `supabase/migrations/20260304000002_update_llm_prompts_qwen3.sql` (new)
- `server/worldmonitor/news/v1/_shared.ts`
- `server/worldmonitor/intelligence/v1/deduct-situation.ts`
- `server/worldmonitor/intelligence/v1/classify-event.ts`
- `server/worldmonitor/intelligence/v1/get-country-intel-brief.ts`
- `server/_shared/headlines-buffer.ts` (new)
- `server/worldmonitor/news/v1/list-feed-digest.ts`

**Step 3: Manual smoke test checklist**

After deploying to staging or local dev:

1. Trigger a feed digest refresh — verify Redis keys `wm:headlines:recent:global` and category keys are populated
2. Call the deduction endpoint — verify the response includes analysis that references recent events
3. Call the country intel endpoint — verify the brief mentions current headlines
4. Call the summarization endpoint — verify it responds quickly (no thinking overhead)
5. Call the classification endpoint — verify it returns valid JSON
6. Check Redis memory usage — should be < 500 KB for the headlines buffer

---

## Updates (2026-03-04)

### DB-Only LLM Prompts

`wm_admin.llm_prompts` is now the single source of truth with model-aware cascading via `get_llm_prompt` RPC. All 4 handlers (summarize-article, deduct-situation, get-country-intel-brief, classify-event) now use DB prompts exclusively. The `getLlmPrompt()` function now accepts a `model` parameter for model-aware prompt resolution.

### Model-Aware Cascade

Prompts cascade through 8 levels of specificity (model+variant+mode → generic fallback). Qwen3-specific overrides use `/think` and `/nothink` tokens; generic prompts are model-agnostic.

### Migration Files Added (2026-03-04)

- **`20260304000003_add_model_name_to_llm_prompts.sql`** — Adds `model_name` column, partial unique indexes, `get_llm_prompt` RPC, updates `admin_insert_llm_prompt`
- **`20260304000004_update_llm_prompts_model_aware.sql`** — Seeds generic + qwen3-wm prompt overrides, adds `intel_digest` prompt

### Telegram Headlines Ingestion

New `/api/internal/ingest-headlines` endpoint accepts headline batches and stores them in Redis per-scope. The `ais-relay.cjs` script now fires headlines to this endpoint after each Telegram poll cycle.

### Global Intelligence Digest

New `GetGlobalIntelDigest` RPC that synthesizes headlines, classifications, and country signals into a 4-section intelligence digest. Cached for 4 hours. Rendered in the new `GlobalDigestPanel` UI component.

### Action Items / Follow-up

- Run `make generate` to regenerate TypeScript types from updated protos
- Apply new migrations (`000003` and `000004`) to production database
- Set `WM_APP_KEY` env var in Vercel and Railway environments for headlines ingest auth
- Set `WM_BASE_URL` env var in Railway (ais-relay) to point to production Vercel URL
