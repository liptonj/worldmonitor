# Relay-Native AI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move ALL AI/LLM functions from Vercel to the relay server. The relay resolves provider credentials per-function from the admin-configurable `llm_function_config` table, supports priority-based fallback across multiple providers, and uses a two-model consensus approach for the full panel summary. The relay is the **only** AI source (no browser or Vercel AI calls), and freshness is enforced by cron + data-change regeneration with explicit TTLs and `generatedAt` metadata.

**Architecture:**
- `scripts/ais-relay.cjs` gains: a multi-provider LLM client that resolves per-function provider assignments from `wm_admin.llm_function_config` (with fallback chain), a prompt loader from `get_llm_prompt` RPC, and 9 AI cron functions that call providers directly and broadcast results.
- The full panel summary uses a **two-model consensus** approach: it runs two different models (configurable via admin portal), then a third "arbiter" call synthesizes both outputs into a final summary. This ensures higher quality and cross-validates facts.
- The relay already has `@supabase/supabase-js` (anon client), `ioredis`, `node-cron`, and `broadcastToChannel()` — no new dependencies needed.
- Client-side removes all AI network calls (no `/api/intelligence/v1/*` or browser T5 summarization); it only consumes relay-pushed or relay-cached AI payloads.
- Freshness is enforced on the relay: each payload includes `generatedAt`, is cached with TTL, and is regenerated on data changes (not by client requests).

**Tech Stack:** Node.js CommonJS (`ais-relay.cjs`), `ioredis`, `node-cron`, `@supabase/supabase-js`, multi-provider LLM HTTP, existing `broadcastToChannel()` + `directFetchAndBroadcast()` patterns.

---

## Provider Resolution & Fallback Chain

### Per-Function Provider Assignment (NEW: `llm_function_config` table)

Each AI function can be assigned a **preferred provider** and an optional **secondary provider** via the admin portal. If the preferred provider fails (timeout, HTTP error, empty response), the relay automatically falls back to the next provider in the chain.

**New table: `wm_admin.llm_function_config`**

```sql
CREATE TABLE wm_admin.llm_function_config (
  function_key     TEXT PRIMARY KEY,   -- e.g. 'intel_digest', 'panel_summary'
  provider_chain   TEXT[] NOT NULL,    -- ordered provider names, e.g. ['ollama', 'groq']
  max_retries      INTEGER NOT NULL DEFAULT 1,
  timeout_ms       INTEGER NOT NULL DEFAULT 120000,
  description      TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Seed with defaults:

| function_key | provider_chain | timeout_ms | description |
|---|---|---|---|
| `intel_digest` | `['ollama']` | 120000 | Global intelligence digest |
| `panel_summary` | `['ollama']` | 180000 | Full panel summary (two-model) |
| `panel_summary_arbiter` | `['ollama']` | 120000 | Panel summary arbiter/synthesizer |
| `news_summary` | `['ollama', 'groq']` | 30000 | Article summarization |
| `classify_event` | `['ollama', 'groq']` | 15000 | Event classification |
| `country_brief` | `['ollama']` | 30000 | Country intel briefs |
| `posture_analysis` | `['ollama']` | 60000 | Theater posture narrative |
| `instability_analysis` | `['ollama']` | 60000 | Country instability narrative |
| `risk_overview` | `['ollama']` | 60000 | Strategic risk narrative |
| `deduction` | `['ollama', 'groq']` | 120000 | User-triggered deduction |

**New RPC: `get_llm_function_config()`** — Returns all rows for relay to cache.

### Provider Credential Resolution

The relay loads ALL enabled providers from `llm_providers` (not just the top-priority one). For each provider, it resolves credentials:

- **Ollama**: `get_ollama_credentials()` RPC → `api_url`, `model`, `cf_access_client_id`, `cf_access_client_secret`, `max_tokens`, `max_tokens_summary`
- **Groq**: `api_key_secret_name` → resolved via `getSecret` or Vault lookup
- **OpenRouter**: same pattern as Groq

All credentials cached in-memory (NOT Redis — contain secrets), refreshed every 15 minutes.

### Fallback Flow

```
callLlmForFunction('intel_digest', messages, opts)
  → look up provider_chain for 'intel_digest': ['ollama', 'groq']
  → try ollama:
      → resolve ollama credentials (CF Access headers)
      → POST to ollama /api/chat (qwen3) or /v1/chat/completions
      → if success → return content
      → if fail → log warning, try next
  → try groq:
      → resolve groq API key
      → POST to groq /v1/chat/completions
      → if success → return content
      → if fail → log error, return null
```

### Prompt Templates (from Supabase `wm_admin.llm_prompts`)

The relay calls `get_llm_prompt(p_key, p_variant, p_mode, p_model)` RPC. Prompts are cached in local Redis with 15-min TTL. Prompt keys used:

| Key | AI Function |
|---|---|
| `intel_digest` | Global Intel Digest |
| `view_summary` | Full Panel Summary |
| `view_summary_arbiter` | Panel Summary arbiter (synthesizes two model outputs) |
| `news_summary` | Article Summarization |
| `classify_event` | Event Classification |
| `intel_brief` | Country Intel Briefs |
| `deduction` | Deduction (user query) |
| `strategic_posture_analysis` | Strategic Posture AI Narrative (NEW — must be seeded) |
| `country_instability_analysis` | Country Instability AI Narrative (NEW — must be seeded) |
| `strategic_risk_overview` | Strategic Risk Overview AI Narrative (NEW — must be seeded) |

### LLM Call Patterns

For **qwen3 models** (model starts with `qwen3`):
- Endpoint: `{api_url}/api/chat` (native Ollama)
- Body: `{ model, messages, think: false, stream: false, options: { num_predict } }`
- Response: `data.message.content`

For **OpenAI-compat models** (Groq, OpenRouter, non-qwen3 Ollama):
- Endpoint: `{api_url}/v1/chat/completions`
- Body: `{ model, messages, temperature, max_tokens, stream: false }`
- Response: `data.choices[0].message.content`

Provider-specific headers:
- Ollama: `CF-Access-Client-Id`, `CF-Access-Client-Secret`
- Groq: `Authorization: Bearer <GROQ_API_KEY>`
- OpenRouter: `Authorization: Bearer <OPENROUTER_API_KEY>`, `HTTP-Referer`, `X-Title`

---

## AI Channel Inventory

| Channel | Cron | TTL | Description |
|---|---|---|---|
| `ai:intel-digest` | `*/10 * * * *` | 4h | Global intelligence narrative |
| `ai:panel-summary` | `*/15 * * * *` | 15 min | Full world-state summary (two-model consensus) |
| `ai:article-summaries` | On news update | 24h | Pre-summarized headlines |
| `ai:classifications` | On news update | 24h | Per-headline severity/category |
| `ai:country-briefs` | `*/30 * * * *` | 2h | Top-15 country briefs |
| `ai:posture-analysis` | `*/15 * * * *` | 15 min | Theater posture narratives |
| `ai:instability-analysis` | `*/30 * * * *` | 2h | Country instability narratives |
| `ai:risk-overview` | `*/15 * * * *` | 15 min | Strategic risk narrative |

---

## Freshness & Cache Invalidation (Relay-Only Source)

- **Redis TTLs + `generatedAt`:** Every AI payload is stored with TTL and includes `generatedAt` so clients can detect staleness.
- **Cron + change triggers:** The relay regenerates on schedule and immediately after upstream data changes (news updates, panel inputs, or country brief source updates).
- **No client-triggered AI:** Clients never call AI endpoints directly; they only consume relay-pushed or relay-cached data.
- **Stale handling:** If `now - generatedAt > TTL`, the UI shows a stale/refreshing state while still rendering last known good data.

---

## Task 1: Add multi-provider LLM client to relay

The relay needs a module that:
1. Loads ALL enabled providers from `llm_providers` + credentials from Supabase vault
2. Loads per-function provider assignments from `llm_function_config`
3. Provides `callLlmForFunction(functionKey, messages, opts)` that tries providers in order
4. Provides `callLlmWithProvider(providerName, messages, opts)` for direct provider calls (used by two-model panel summary)
5. Handles qwen3 native API vs OpenAI-compat, CF Access auth, Groq/OpenRouter auth

**Files:**
- Modify: `scripts/ais-relay.cjs` (add after the Supabase client init ~line 195)
- Create: `tests/relay-ollama-client.test.mjs`

### Step 1: Write failing test

```javascript
// tests/relay-ollama-client.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('relay multi-provider LLM client contract', () => {
  const src = readFileSync('scripts/ais-relay.cjs', 'utf8');

  it('defines resolveAllProviders function', () => {
    assert.ok(src.includes('resolveAllProviders'), 'must define resolveAllProviders');
  });

  it('defines callLlmForFunction function', () => {
    assert.ok(src.includes('callLlmForFunction'), 'must define callLlmForFunction');
  });

  it('defines callLlmWithProvider function', () => {
    assert.ok(src.includes('callLlmWithProvider'), 'must define callLlmWithProvider for direct provider calls');
  });

  it('defines getFunctionConfig function', () => {
    assert.ok(src.includes('getFunctionConfig'), 'must define getFunctionConfig');
  });

  it('calls get_ollama_credentials RPC', () => {
    assert.ok(src.includes("'get_ollama_credentials'") || src.includes('"get_ollama_credentials"'),
      'must call get_ollama_credentials RPC');
  });

  it('calls get_llm_function_config RPC or reads llm_function_config', () => {
    assert.ok(src.includes('llm_function_config') || src.includes('function_config'),
      'must read per-function provider config');
  });

  it('sends CF-Access-Client-Id header for Ollama', () => {
    assert.ok(src.includes('CF-Access-Client-Id'), 'must send CF-Access-Client-Id header');
  });

  it('handles qwen3 native API', () => {
    assert.ok(src.includes('/api/chat') && src.includes('qwen3'),
      'must handle qwen3 native API path');
  });

  it('handles OpenAI-compat API', () => {
    assert.ok(src.includes('/v1/chat/completions'),
      'must handle OpenAI-compat API path');
  });

  it('implements provider fallback chain', () => {
    assert.ok(src.includes('provider_chain') || src.includes('providerChain'),
      'must implement provider fallback chain');
  });

  it('defines loadLlmPrompt function', () => {
    assert.ok(src.includes('loadLlmPrompt'), 'must define loadLlmPrompt');
  });

  it('calls get_llm_prompt RPC', () => {
    assert.ok(src.includes("'get_llm_prompt'") || src.includes('"get_llm_prompt"'),
      'must call get_llm_prompt RPC');
  });
});
```

### Step 2: Run test to verify it fails

```bash
node --test tests/relay-ollama-client.test.mjs
```

Expected: FAIL

### Step 3: Implement multi-provider LLM client in relay

Add this block after the Supabase client init (~line 195 in `ais-relay.cjs`), after `redisSetex`:

```javascript
// ── Multi-Provider LLM Client ───────────────────────────────────────────────
// Resolves ALL enabled providers from Supabase, supports per-function provider
// assignment with priority-based fallback chains, handles qwen3 native API,
// OpenAI-compat, and provider-specific auth (CF Access, Bearer token).

const providerRegistry = new Map();  // name → { apiUrl, model, headers, maxTokens, maxTokensSummary, type }
let functionConfigMap = new Map();   // functionKey → { provider_chain, timeout_ms, max_retries }
let providersExpiresAt = 0;
const PROVIDER_TTL_MS = 15 * 60 * 1000; // 15 minutes
const DEFAULT_TIMEOUT_MS = 120_000;

// ── Resolve ALL providers from Supabase ──

async function resolveAllProviders() {
  if (providerRegistry.size > 0 && Date.now() < providersExpiresAt) return;
  if (!supabase) {
    console.error('[llm] Supabase client not configured — cannot resolve providers');
    return;
  }

  try {
    // 1. Load Ollama credentials (CF Access + model)
    const { data: ollamaData, error: ollamaErr } = await supabase.rpc('get_ollama_credentials');
    if (!ollamaErr && Array.isArray(ollamaData) && ollamaData.length > 0) {
      const row = ollamaData[0];
      if (row.api_url) {
        providerRegistry.set('ollama', {
          apiUrl: row.api_url.replace(/\/+$/, ''),
          model: row.model || 'qwen3:8b',
          type: (row.model || '').startsWith('qwen3') ? 'qwen3' : 'openai-compat',
          maxTokens: row.max_tokens || 3000,
          maxTokensSummary: row.max_tokens_summary || 400,
          headers: {
            'Content-Type': 'application/json',
            ...(row.cf_access_client_id && { 'CF-Access-Client-Id': row.cf_access_client_id }),
            ...(row.cf_access_client_secret && { 'CF-Access-Client-Secret': row.cf_access_client_secret }),
          },
        });
        console.log(`[llm] registered ollama: model=${row.model} url=${row.api_url}`);
      }
    } else if (ollamaErr) {
      console.error('[llm] get_ollama_credentials RPC error:', ollamaErr.message);
    }

    // 2. Load all enabled providers from llm_providers table
    const { data: providers, error: provErr } = await supabase.rpc('get_all_enabled_providers');
    if (!provErr && Array.isArray(providers)) {
      for (const p of providers) {
        if (p.name === 'ollama') continue; // already resolved above with full credentials
        // Resolve API key from vault
        let apiKey = null;
        if (p.api_key_secret_name) {
          const { data: secretData } = await supabase.rpc('get_secret_value', {
            p_name: p.api_key_secret_name,
          });
          apiKey = secretData?.[0]?.decrypted_secret || null;
        }
        providerRegistry.set(p.name, {
          apiUrl: p.api_url.replace(/\/+$/, ''),
          model: p.default_model,
          type: 'openai-compat',
          maxTokens: p.max_tokens || 3000,
          maxTokensSummary: p.max_tokens_summary || 400,
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey && { 'Authorization': `Bearer ${apiKey}` }),
            ...(p.name === 'openrouter' && {
              'HTTP-Referer': 'https://worldmonitor.app',
              'X-Title': 'WorldMonitor',
            }),
          },
        });
        console.log(`[llm] registered ${p.name}: model=${p.default_model}`);
      }
    }

    // 3. Load per-function provider config
    const { data: funcData, error: funcErr } = await supabase.rpc('get_llm_function_config');
    if (!funcErr && Array.isArray(funcData)) {
      const newMap = new Map();
      for (const row of funcData) {
        newMap.set(row.function_key, {
          providerChain: row.provider_chain || ['ollama'],
          timeoutMs: row.timeout_ms || DEFAULT_TIMEOUT_MS,
          maxRetries: row.max_retries || 1,
        });
      }
      functionConfigMap = newMap;
      console.log(`[llm] loaded ${newMap.size} function configs`);
    }

    providersExpiresAt = Date.now() + PROVIDER_TTL_MS;
    console.log(`[llm] ${providerRegistry.size} providers ready`);
  } catch (err) {
    console.error('[llm] resolveAllProviders exception:', err?.message ?? err);
  }
}

function getFunctionConfig(functionKey) {
  return functionConfigMap.get(functionKey) || { providerChain: ['ollama'], timeoutMs: DEFAULT_TIMEOUT_MS, maxRetries: 1 };
}

// ── Strip thinking blocks from model output ──

function stripThinkingBlocks(text) {
  return text
    .replace(/<\|begin_of_thought\|>[\s\S]*?<\|end_of_thought\|>/g, '')
    .replace(/<\|thinking\|>[\s\S]*?<\|\/thinking\|>/g, '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/g, '')
    .replace(/<reflection>[\s\S]*?<\/reflection>/g, '')
    .trim();
}

// ── Call a specific named provider ──

async function callLlmWithProvider(providerName, messages, opts = {}) {
  await resolveAllProviders();
  const provider = providerRegistry.get(providerName);
  if (!provider) {
    console.error(`[llm] unknown provider: ${providerName}`);
    return null;
  }

  const maxTokens = opts.maxTokens ?? provider.maxTokens;
  const temperature = opts.temperature ?? 0.4;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let url, body;

  if (provider.type === 'qwen3') {
    // Native Ollama API for qwen3 models
    url = `${provider.apiUrl}/api/chat`;
    body = JSON.stringify({
      model: provider.model,
      messages,
      think: false,
      stream: false,
      options: { num_predict: maxTokens },
    });
  } else {
    // OpenAI-compat: Groq, OpenRouter, non-qwen3 Ollama
    url = `${provider.apiUrl}/v1/chat/completions`;
    body = JSON.stringify({
      model: provider.model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: false,
    });
  }

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: provider.headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      console.error(`[llm:${providerName}] HTTP ${resp.status}: ${errText.slice(0, 200)}`);
      return null;
    }

    const data = await resp.json();

    let content;
    if (provider.type === 'qwen3') {
      content = data?.message?.content ?? '';
    } else {
      content = data?.choices?.[0]?.message?.content
        ?? data?.choices?.[0]?.message?.reasoning
        ?? '';
    }

    content = stripThinkingBlocks(content);

    if (!content) {
      console.warn(`[llm:${providerName}] empty response after stripping think blocks`);
      return null;
    }

    return content;
  } catch (err) {
    console.error(`[llm:${providerName}] call error: ${err?.message ?? err}`);
    return null;
  }
}

// ── Call LLM for a function with fallback chain ──

async function callLlmForFunction(functionKey, messages, opts = {}) {
  const config = getFunctionConfig(functionKey);
  const { providerChain } = config;
  const timeoutMs = opts.timeoutMs ?? config.timeoutMs;

  for (let i = 0; i < providerChain.length; i++) {
    const providerName = providerChain[i];
    console.log(`[llm] trying ${providerName} for ${functionKey} (${i + 1}/${providerChain.length})`);

    const result = await callLlmWithProvider(providerName, messages, { ...opts, timeoutMs });
    if (result) {
      if (i > 0) console.log(`[llm] ${functionKey} succeeded on fallback provider ${providerName}`);
      return result;
    }

    if (i < providerChain.length - 1) {
      console.warn(`[llm] ${providerName} failed for ${functionKey}, falling back to ${providerChain[i + 1]}`);
    } else {
      console.error(`[llm] all providers exhausted for ${functionKey}`);
    }
  }

  return null;
}

// ── Prompt Loader ────────────────────────────────────────────────────────────

const PROMPT_CACHE_TTL = 900; // 15 min
const promptCache = new Map();

async function loadLlmPrompt(promptKey, variant = null, mode = null) {
  const model = providerRegistry.get('ollama')?.model ?? null;
  const cacheKey = `${promptKey}:${variant ?? 'null'}:${mode ?? 'null'}:${model ?? 'null'}`;

  const cached = promptCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.prompt;

  const redisKey = `wm:llm:prompt:v1:${cacheKey}`;
  const redisCached = await redisGet(redisKey);
  if (redisCached) {
    promptCache.set(cacheKey, { prompt: redisCached, expiresAt: Date.now() + PROMPT_CACHE_TTL * 1000 });
    return redisCached;
  }

  if (!supabase) return null;

  try {
    const { data, error } = await supabase.rpc('get_llm_prompt', {
      p_key: promptKey,
      p_variant: variant,
      p_mode: mode,
      p_model: model,
    });
    if (error) {
      console.error(`[llm] get_llm_prompt error for ${promptKey}:`, error.message);
      return null;
    }
    const row = Array.isArray(data) && data.length > 0 ? data[0] : null;
    if (!row) {
      console.warn(`[llm] no prompt found for key=${promptKey}`);
      return null;
    }
    const prompt = {
      systemPrompt: row.system_prompt || '',
      userPrompt: row.user_prompt || '',
    };
    promptCache.set(cacheKey, { prompt, expiresAt: Date.now() + PROMPT_CACHE_TTL * 1000 });
    await redisSetex(redisKey, PROMPT_CACHE_TTL, prompt);
    return prompt;
  } catch (err) {
    console.error(`[llm] loadLlmPrompt exception for ${promptKey}:`, err?.message ?? err);
    return null;
  }
}

function buildPromptFromTemplate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (match, key) => vars[key] ?? match);
}

// Eagerly resolve providers on startup
void resolveAllProviders();

// Refresh every 15 minutes
cron.schedule('*/15 * * * *', () => {
  providersExpiresAt = 0;
  void resolveAllProviders();
  promptCache.clear();
});
```

### Step 4: Run test

```bash
node --test tests/relay-ollama-client.test.mjs
```

Expected: PASS

### Step 5: Commit

```bash
git add scripts/ais-relay.cjs tests/relay-ollama-client.test.mjs
git commit -m "feat(relay): add multi-provider LLM client with fallback chains and per-function config"
```

---

## Task 1b: Database migration — llm_function_config table and RPCs

Creates the per-function provider assignment table and supporting RPCs.

**Files:**
- Create: `supabase/migrations/2026030600003_add_llm_function_config.sql`

### Step 1: Write migration

```sql
-- =============================================================
-- Migration: per-function LLM provider config + supporting RPCs
--
-- Purpose:
--   Allow admins to assign specific LLM providers to each AI function
--   with priority-based fallback chains. Each function (e.g. 'intel_digest',
--   'panel_summary') can have its own ordered list of providers to try.
--
--   Also adds get_all_enabled_providers() and get_llm_function_config()
--   RPCs for the relay server.
-- =============================================================

-- =============================================================
-- 1. llm_function_config table
-- =============================================================

create table if not exists wm_admin.llm_function_config (
  function_key     text        primary key,
  provider_chain   text[]      not null default '{ollama}',
  max_retries      integer     not null default 1 check (max_retries between 0 and 5),
  timeout_ms       integer     not null default 120000 check (timeout_ms between 5000 and 600000),
  description      text,
  updated_at       timestamptz not null default now(),
  updated_by       uuid        references auth.users(id) on delete set null
);

create index if not exists idx_llm_function_config_updated_by
  on wm_admin.llm_function_config (updated_by)
  where updated_by is not null;

alter table wm_admin.llm_function_config enable row level security;
alter table wm_admin.llm_function_config force row level security;

create policy "admins_all_llm_function_config"
  on wm_admin.llm_function_config for all
  using ((select wm_admin.is_admin()));

create trigger trg_llm_function_config_upd
  before update on wm_admin.llm_function_config
  for each row execute function wm_admin.set_updated_at();

-- Seed defaults
insert into wm_admin.llm_function_config (function_key, provider_chain, timeout_ms, description) values
  ('intel_digest',         '{ollama}',           120000, 'Global intelligence digest'),
  ('panel_summary',        '{ollama}',           180000, 'Full panel summary (two-model approach — Model A)'),
  ('panel_summary_arbiter','{ollama}',           120000, 'Panel summary arbiter/synthesizer'),
  ('news_summary',         '{ollama,groq}',       30000, 'Article summarization'),
  ('classify_event',       '{ollama,groq}',       15000, 'Event classification'),
  ('country_brief',        '{ollama}',            30000, 'Country intel briefs'),
  ('posture_analysis',     '{ollama}',            60000, 'Theater posture narrative'),
  ('instability_analysis', '{ollama}',            60000, 'Country instability narrative'),
  ('risk_overview',        '{ollama}',            60000, 'Strategic risk narrative'),
  ('deduction',            '{ollama,groq}',      120000, 'User-triggered deduction')
on conflict (function_key) do nothing;

-- =============================================================
-- 2. get_all_enabled_providers() RPC
-- =============================================================

create or replace function public.get_all_enabled_providers()
returns table(
  name                text,
  api_url             text,
  default_model       text,
  api_key_secret_name text,
  max_tokens          integer,
  max_tokens_summary  integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    lp.name,
    lp.api_url,
    lp.default_model,
    lp.api_key_secret_name,
    lp.max_tokens,
    lp.max_tokens_summary
  from wm_admin.llm_providers lp
  where lp.enabled = true
  order by lp.priority asc;
$$;

comment on function public.get_all_enabled_providers() is
  'Returns all enabled LLM providers ordered by priority. '
  'Used by relay server to build provider registry.';

grant execute on function public.get_all_enabled_providers() to anon;
grant execute on function public.get_all_enabled_providers() to authenticated;
revoke execute on function public.get_all_enabled_providers() from public;

-- =============================================================
-- 3. get_llm_function_config() RPC
-- =============================================================

create or replace function public.get_llm_function_config()
returns table(
  function_key   text,
  provider_chain text[],
  max_retries    integer,
  timeout_ms     integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    fc.function_key,
    fc.provider_chain,
    fc.max_retries,
    fc.timeout_ms
  from wm_admin.llm_function_config fc;
$$;

comment on function public.get_llm_function_config() is
  'Returns all per-function LLM provider assignments. '
  'Used by relay server to determine which providers to use for each AI function.';

grant execute on function public.get_llm_function_config() to anon;
grant execute on function public.get_llm_function_config() to authenticated;
revoke execute on function public.get_llm_function_config() from public;

-- =============================================================
-- 4. get_secret_value() RPC for resolving API keys from vault
-- =============================================================

create or replace function public.get_secret_value(p_name text)
returns table(decrypted_secret text)
language sql
stable
security definer
set search_path = ''
as $$
  select ds.decrypted_secret
  from vault.decrypted_secrets ds
  where ds.name = p_name
  limit 1;
$$;

comment on function public.get_secret_value(text) is
  'Resolves a single vault secret by name. Used by relay for provider API keys.';

grant execute on function public.get_secret_value(text) to anon;
revoke execute on function public.get_secret_value(text) from public;
```

### Step 2: Push migration, commit

```bash
npx supabase db push
git add supabase/migrations/2026030600003_add_llm_function_config.sql
git commit -m "feat(db): add llm_function_config table for per-function provider assignment with fallback chains"
```

---

## Task 1c: Admin Portal — Function Config UI

Add a new section to the LLM Config admin page where admins can:
- See all AI functions with their current provider chains
- Drag/reorder providers in each chain
- Add/remove providers from a function's chain
- Set timeout and retry count per function

**Files:**
- Modify: `src/admin/pages/llm-config.ts`

### Step 1: Add Function Config section

Add after the existing Prompts section in `renderLlmConfigPage`:

```typescript
// ── Function Provider Config section ──

type LlmFunctionConfig = {
  function_key: string;
  provider_chain: string[];
  max_retries: number;
  timeout_ms: number;
  description: string | null;
};

// Render function config table showing:
// - function_key (read-only label)
// - provider_chain (editable list with add/remove/reorder)
// - timeout_ms (number input)
// - max_retries (number input)
// - save button per row

// Load data via: supabase.from('llm_function_config').select('*').order('function_key')
// Save via: supabase.from('llm_function_config').update({...}).eq('function_key', key)
// Available providers loaded from: supabase.from('llm_providers').select('name').eq('enabled', true)
```

The UI should display provider chips that can be added/removed, with the order determining priority. Each function row has a description label, the provider chain, timeout, retries, and a save button.

### Step 2: Commit

```bash
git add src/admin/pages/llm-config.ts
git commit -m "feat(admin): add per-function LLM provider config UI with fallback chain management"
```

---

## Task 2: Add AI channels to relay allowed list

**Files:**
- Modify: `scripts/ais-relay.cjs` (ALLOWED_CHANNELS set ~line 296)

### Step 1: Add channels

Find the `ALLOWED_CHANNELS` Set and add:

```javascript
'ai:intel-digest', 'ai:panel-summary', 'ai:article-summaries',
'ai:classifications', 'ai:country-briefs', 'ai:posture-analysis',
'ai:instability-analysis', 'ai:risk-overview',
```

Also add them to `PHASE4_CHANNEL_KEYS` if they should be included in the `/bootstrap` payload (~line 3294).

### Step 2: Commit

```bash
git add scripts/ais-relay.cjs
git commit -m "feat(relay): add AI broadcast channels to allowed list"
```

---

## Task 3: Implement Global Intel Digest AI cron

Replaces `warmIntelligenceAndBroadcast` — the relay now calls Ollama directly instead of warming Vercel.

**Files:**
- Modify: `scripts/ais-relay.cjs`
- Create: `tests/relay-ai-intel-digest.test.mjs`

### Step 1: Write failing test

```javascript
// tests/relay-ai-intel-digest.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('relay AI intel digest', () => {
  const src = readFileSync('scripts/ais-relay.cjs', 'utf8');

  it('defines generateIntelDigest function', () => {
    assert.ok(src.includes('generateIntelDigest'), 'must define generateIntelDigest');
  });

  it('uses intel_digest prompt key', () => {
    assert.ok(src.includes("'intel_digest'") || src.includes('"intel_digest"'),
      'must load intel_digest prompt');
  });

  it('reads headlines from Redis', () => {
    assert.ok(src.includes('wm:headlines') || src.includes('news:digest'),
      'must read headlines from Redis cache');
  });

  it('broadcasts to ai:intel-digest channel', () => {
    assert.ok(src.includes("'ai:intel-digest'") || src.includes('"ai:intel-digest"'),
      'must broadcast to ai:intel-digest');
  });
});
```

### Step 2: Run test to verify fail

```bash
node --test tests/relay-ai-intel-digest.test.mjs
```

### Step 3: Implement

Add after the Ollama client section in `ais-relay.cjs`:

```javascript
// ── AI: Global Intel Digest ─────────────────────────────────────────────────
// Reads latest headlines from local Redis, calls Ollama for a narrative digest,
// caches result, broadcasts to ai:intel-digest channel.

const AI_DIGEST_CACHE_KEY = 'ai:digest:global:v1';
const AI_DIGEST_TTL = 14400; // 4 hours

async function generateIntelDigest() {
  const prompt = await loadLlmPrompt('intel_digest');
  if (!prompt) {
    console.warn('[ai-cron] no intel_digest prompt found — skipping');
    return;
  }

  // Gather headlines from the news digest cache (same source relay uses for news:full)
  const newsData = await redisGet('relay:news:full:v1');
  const headlines = [];
  if (newsData?.items && Array.isArray(newsData.items)) {
    for (const item of newsData.items.slice(0, 30)) {
      if (item.title) headlines.push(item.title);
    }
  }
  // Also check intelligence-specific headline sources
  for (const key of ['relay:intelligence:v1']) {
    const data = await redisGet(key);
    if (data?.headlines && Array.isArray(data.headlines)) {
      for (const h of data.headlines.slice(0, 10)) {
        if (typeof h === 'string') headlines.push(h);
        else if (h?.title) headlines.push(h.title);
      }
    }
  }

  if (headlines.length === 0) {
    console.warn('[ai-cron] no headlines available for intel digest — skipping');
    return;
  }

  const dedupedHeadlines = [...new Set(headlines)].slice(0, 30);
  const headlineText = dedupedHeadlines.map((h, i) => `${i + 1}. ${h}`).join('\n');
  const dateStr = new Date().toISOString().slice(0, 10);

  const systemPrompt = buildPromptFromTemplate(prompt.systemPrompt, {
    date: dateStr,
    dateContext: `Current date: ${dateStr}. Provide geopolitical context appropriate for the current date.`,
  });
  const userPrompt = buildPromptFromTemplate(prompt.userPrompt, {
    recentHeadlines: headlineText,
    classificationSummary: `${dedupedHeadlines.length} recent events across monitored scopes`,
    countrySignals: 'Monitoring active in all TIER1 regions',
  });

  const content = await callLlmForFunction('intel_digest',
    [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
    { maxTokens: 2000, temperature: 0.4 },
  );

  if (!content) return;

  const payload = {
    digest: content,
    model: providerRegistry.get('ollama')?.model ?? 'multi-provider',
    generatedAt: new Date().toISOString(),
    headlineCount: dedupedHeadlines.length,
  };

  await redisSetex(AI_DIGEST_CACHE_KEY, AI_DIGEST_TTL, payload);
  broadcastToChannel('ai:intel-digest', payload);
  console.log(`[ai-cron] intel digest generated (${content.length} chars), broadcast to ${channelSubscribers.get('ai:intel-digest')?.size ?? 0} subs`);
}

// Register cron — every 10 minutes
cron.schedule('*/10 * * * *', async () => {
  try { await generateIntelDigest(); }
  catch (err) { console.error('[ai-cron] intel digest error:', err?.message ?? err); }
});
```

### Step 4: Remove old `warmIntelligenceAndBroadcast`

Comment out or replace the old `warmIntelligenceAndBroadcast()` function and its cron entry. The relay no longer calls Vercel for the intel digest — it generates it directly.

### Step 5: Run test, commit

```bash
node --test tests/relay-ai-intel-digest.test.mjs
git add scripts/ais-relay.cjs tests/relay-ai-intel-digest.test.mjs
git commit -m "feat(relay): generate intel digest via Ollama directly — replaces Vercel warm"
```

---

## Task 4: Implement Full Panel Summary AI cron (Two-Model Consensus)

Replaces the user-triggered "Summarize View" modal. The relay reads ALL cached panel data from Redis — including full article content, telegram intelligence, market data, risk scores, and more — then runs a **two-model consensus approach**:

1. **Model A** generates a summary from the full context
2. **Model B** independently generates a summary from the same context
3. **Arbiter call** synthesizes both outputs, cross-validates facts, resolves contradictions, and produces a final consensus summary

This ensures higher quality: two models catch different patterns, and the arbiter filters out hallucinations that appear in only one output.

**Context sources (NOT just headlines):**

| Source | Redis Key | What Gets Extracted |
|---|---|---|
| News Digest | `relay:news:full:v1` | Full headlines + descriptions + sources (not just titles) |
| Telegram Intel | `relay:telegram:v1` | Full telegram messages — raw OSINT channel content |
| Markets | `relay:markets:v1` | Index levels, % changes, commodities, crypto |
| Strategic Risk | `relay:strategic-risk:v1` | CII scores, strategic risk level, top factors |
| Strategic Posture | `relay:strategic-posture:v1` | Theater posture levels, active flights, operations |
| Cyber Threats | `relay:cyber:v1` | Active threats, severity, targets |
| Supply Chain | `relay:supply-chain:v1` | Chokepoint status, disruptions |
| Trade Policy | `relay:trade:v1` | Active trade barriers, tariff changes |
| Predictions | `relay:predictions:v1` | Prediction market probabilities |
| Intelligence | `relay:intelligence:v1` | Intel digest, classified events |
| Weather | `relay:weather:v1` | Active severe weather alerts |
| Cables | `relay:cables:v1` | Undersea cable health/outages |
| Conflict | `relay:conflict:v1` | ACLED conflict events |
| Natural Events | `relay:natural:v1`, `relay:eonet:v1`, `relay:gdacs:v1` | Wildfires, earthquakes, disasters |

**Files:**
- Modify: `scripts/ais-relay.cjs`
- Create: `tests/relay-ai-panel-summary.test.mjs`
- Create: `supabase/migrations/2026030600002_add_panel_summary_arbiter_prompt.sql`

### Step 1: Write failing test

```javascript
// tests/relay-ai-panel-summary.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('relay AI panel summary (two-model)', () => {
  const src = readFileSync('scripts/ais-relay.cjs', 'utf8');

  it('defines generatePanelSummary function', () => {
    assert.ok(src.includes('generatePanelSummary'), 'must define generatePanelSummary');
  });

  it('uses view_summary prompt key', () => {
    assert.ok(src.includes("'view_summary'") || src.includes('"view_summary"'));
  });

  it('uses view_summary_arbiter prompt key', () => {
    assert.ok(src.includes("'view_summary_arbiter'") || src.includes('"view_summary_arbiter"'));
  });

  it('reads telegram data from Redis', () => {
    assert.ok(src.includes('relay:telegram'), 'must read telegram data for panel summary context');
  });

  it('reads full news descriptions not just titles', () => {
    assert.ok(src.includes('description') || src.includes('content') || src.includes('snippet'),
      'must extract article descriptions/content, not just titles');
  });

  it('runs two model calls before arbiter', () => {
    assert.ok(src.includes('modelAOutput') || src.includes('summaryA'),
      'must run two independent model calls');
  });

  it('broadcasts to ai:panel-summary channel', () => {
    assert.ok(src.includes("'ai:panel-summary'") || src.includes('"ai:panel-summary"'));
  });
});
```

### Step 2: Seed arbiter prompt

```sql
-- supabase/migrations/2026030600002_add_panel_summary_arbiter_prompt.sql

insert into wm_admin.llm_prompts (prompt_key, variant, mode, model_name, system_prompt, user_prompt)
values
  ('view_summary_arbiter', null, null, null,
   'You are a senior intelligence analyst synthesizing two independent world situation assessments. Current date: {date}. Your job is to produce a single, authoritative summary by:
1. Keeping facts that appear in BOTH assessments (high confidence)
2. Including unique insights from either assessment only if they are clearly supported by the data
3. Resolving any contradictions by favoring the more specific/data-backed claim
4. Removing any unsupported speculation or hallucination
5. Producing a cohesive, well-structured final assessment

Output a single definitive summary. Do NOT reference "Assessment A" or "Assessment B" — write as if from one voice.',
   'Assessment A:\n{summaryA}\n\n---\n\nAssessment B:\n{summaryB}\n\n---\n\nProduce a single authoritative world situation summary synthesizing both assessments. Focus on: geopolitical developments, market movements, security threats, and emerging risks.')
on conflict (prompt_key, variant, mode, model_name) do nothing;
```

### Step 3: Implement

```javascript
// ── AI: Full Panel Summary (Two-Model Consensus) ────────────────────────────
// Reads ALL cached panel data from Redis — full content, not just headlines.
// Runs two models independently, then an arbiter synthesizes both outputs.

const AI_PANEL_SUMMARY_CACHE_KEY = 'ai:panel-summary:v1';
const AI_PANEL_SUMMARY_TTL = 900; // 15 min

function extractNewsContext(newsData) {
  if (!newsData?.items || !Array.isArray(newsData.items)) return '';
  return newsData.items.slice(0, 40).map((item, i) => {
    const parts = [`${i + 1}. ${item.title || 'Untitled'}`];
    if (item.description) parts.push(`   ${item.description.slice(0, 300)}`);
    if (item.source) parts.push(`   Source: ${item.source}`);
    if (item.pubDate) parts.push(`   Published: ${item.pubDate}`);
    return parts.join('\n');
  }).join('\n\n');
}

function extractTelegramContext(telegramData) {
  if (!telegramData) return '';
  const items = Array.isArray(telegramData) ? telegramData
    : telegramData.items ? telegramData.items : [];
  return items.slice(0, 30).map((msg, i) => {
    const channel = msg.channel || msg.chatTitle || 'Unknown';
    const text = (msg.text || msg.message || '').slice(0, 500);
    const ts = msg.date || msg.timestamp || '';
    return `${i + 1}. [${channel}] ${text}${ts ? ` (${ts})` : ''}`;
  }).join('\n');
}

function extractMarketContext(marketData) {
  if (!marketData) return '';
  const sections = [];
  if (marketData.indices) {
    sections.push('Indices: ' + marketData.indices.slice(0, 10).map(i =>
      `${i.symbol || i.name}: ${i.price ?? i.value ?? '?'} (${i.changePercent ?? i.change ?? '?'}%)`
    ).join(', '));
  }
  if (marketData.commodities) {
    sections.push('Commodities: ' + marketData.commodities.slice(0, 5).map(c =>
      `${c.name || c.symbol}: $${c.price ?? '?'}`
    ).join(', '));
  }
  if (marketData.crypto) {
    sections.push('Crypto: ' + marketData.crypto.slice(0, 5).map(c =>
      `${c.symbol || c.name}: $${c.price ?? '?'} (${c.changePercent ?? '?'}%)`
    ).join(', '));
  }
  return sections.join('\n');
}

async function generatePanelSummary() {
  const viewPrompt = await loadLlmPrompt('view_summary');
  const arbiterPrompt = await loadLlmPrompt('view_summary_arbiter');
  if (!viewPrompt) {
    console.warn('[ai-cron] no view_summary prompt found — skipping');
    return;
  }

  // ── Build rich context from ALL data sources ──
  const dateStr = new Date().toISOString().slice(0, 10);
  const contextSections = [];

  // News: full headlines + descriptions + sources
  const newsData = await redisGet('relay:news:full:v1');
  const newsContext = extractNewsContext(newsData);
  if (newsContext) contextSections.push(`## NEWS & HEADLINES\n${newsContext}`);

  // Telegram: raw OSINT channel messages
  const telegramData = await redisGet('relay:telegram:v1');
  const telegramContext = extractTelegramContext(telegramData);
  if (telegramContext) contextSections.push(`## TELEGRAM INTELLIGENCE (OSINT)\n${telegramContext}`);

  // Markets: indices, commodities, crypto
  const marketData = await redisGet('relay:markets:v1');
  const marketContext = extractMarketContext(marketData);
  if (marketContext) contextSections.push(`## MARKET DATA\n${marketContext}`);

  // Structured data panels — summarize as key metrics
  const dataKeys = [
    { key: 'relay:strategic-risk:v1', label: 'STRATEGIC RISK SCORES' },
    { key: 'relay:strategic-posture:v1', label: 'MILITARY THEATER POSTURE' },
    { key: 'relay:intelligence:v1', label: 'INTELLIGENCE DIGEST' },
    { key: 'relay:cyber:v1', label: 'CYBER THREATS' },
    { key: 'relay:supply-chain:v1', label: 'SUPPLY CHAIN STATUS' },
    { key: 'relay:predictions:v1', label: 'PREDICTION MARKETS' },
    { key: 'relay:trade:v1', label: 'TRADE POLICY' },
    { key: 'relay:weather:v1', label: 'WEATHER ALERTS' },
    { key: 'relay:cables:v1', label: 'UNDERSEA CABLE HEALTH' },
    { key: 'relay:conflict:v1', label: 'CONFLICT EVENTS' },
    { key: 'relay:natural:v1', label: 'NATURAL DISASTERS / WILDFIRES' },
    { key: 'relay:eonet:v1', label: 'NASA EARTH EVENTS' },
    { key: 'relay:gdacs:v1', label: 'GDACS DISASTER ALERTS' },
  ];

  for (const { key, label } of dataKeys) {
    const data = await redisGet(key);
    if (data) {
      contextSections.push(`## ${label}\n${JSON.stringify(data).slice(0, 2500)}`);
    }
  }

  if (contextSections.length < 5) {
    console.warn(`[ai-cron] only ${contextSections.length} data sources available — skipping panel summary`);
    return;
  }

  const panelData = contextSections.join('\n\n');
  const systemPrompt = buildPromptFromTemplate(viewPrompt.systemPrompt, { date: dateStr });
  const userPrompt = buildPromptFromTemplate(viewPrompt.userPrompt, { panelData, date: dateStr });
  const messages = [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }];

  // ── Two-Model Consensus ──
  // Run two models in parallel, then synthesize with arbiter

  const funcConfig = await getFunctionConfig('panel_summary');
  const providerChain = funcConfig?.provider_chain || ['ollama'];

  // Model A: first provider in chain
  const summaryAPromise = callLlmForFunction('panel_summary', messages, { maxTokens: 1500, temperature: 0.4 });

  // Model B: second provider in chain (or same provider if only one)
  let summaryBPromise;
  if (providerChain.length >= 2) {
    summaryBPromise = callLlmWithProvider(providerChain[1], messages, { maxTokens: 1500, temperature: 0.4 });
  } else {
    // Same model, different temperature for diversity
    summaryBPromise = callLlmForFunction('panel_summary', messages, { maxTokens: 1500, temperature: 0.7 });
  }

  const [summaryA, summaryB] = await Promise.all([summaryAPromise, summaryBPromise]);

  if (!summaryA && !summaryB) {
    console.warn('[ai-cron] both model calls failed for panel summary');
    return;
  }

  let finalSummary;
  const modelsUsed = [];

  if (summaryA && summaryB && arbiterPrompt) {
    // ── Arbiter: synthesize both outputs ──
    const arbiterSystem = buildPromptFromTemplate(arbiterPrompt.systemPrompt, { date: dateStr });
    const arbiterUser = buildPromptFromTemplate(arbiterPrompt.userPrompt, {
      summaryA: summaryA,
      summaryB: summaryB,
    });

    finalSummary = await callLlmForFunction('panel_summary_arbiter',
      [{ role: 'system', content: arbiterSystem }, { role: 'user', content: arbiterUser }],
      { maxTokens: 1500, temperature: 0.3 },
    );
    modelsUsed.push('model_a', 'model_b', 'arbiter');

    if (!finalSummary) {
      finalSummary = summaryA; // fallback to model A if arbiter fails
      modelsUsed.length = 0;
      modelsUsed.push('model_a_fallback');
    }
  } else {
    finalSummary = summaryA || summaryB;
    modelsUsed.push(summaryA ? 'model_a_only' : 'model_b_only');
  }

  if (!finalSummary) return;

  const payload = {
    summary: finalSummary,
    approach: modelsUsed.join('+'),
    generatedAt: new Date().toISOString(),
    contextSources: contextSections.length,
    dataSources: {
      newsHeadlines: newsData?.items?.length ?? 0,
      telegramMessages: (Array.isArray(telegramData) ? telegramData : telegramData?.items || []).length,
      panelCount: dataKeys.filter(k => contextSections.some(s => s.includes(k.label))).length,
    },
  };

  await redisSetex(AI_PANEL_SUMMARY_CACHE_KEY, AI_PANEL_SUMMARY_TTL, payload);
  broadcastToChannel('ai:panel-summary', payload);
  console.log(`[ai-cron] panel summary generated via ${payload.approach} (${finalSummary.length} chars, ${contextSections.length} sources)`);
}

cron.schedule('*/15 * * * *', async () => {
  try { await generatePanelSummary(); }
  catch (err) { console.error('[ai-cron] panel summary error:', err?.message ?? err); }
});
```

### Step 4: Run migration, test, commit

```bash
npx supabase db push
node --test tests/relay-ai-panel-summary.test.mjs
git add scripts/ais-relay.cjs tests/relay-ai-panel-summary.test.mjs supabase/migrations/2026030600002_add_panel_summary_arbiter_prompt.sql
git commit -m "feat(relay): add two-model consensus panel summary with rich context (telegram, full articles, all panels)"
```

---

## Task 5: Implement Article Summarization + Event Classification

These run together — when the news digest updates, the relay processes ALL headlines through Ollama for summaries and classifications.

**Files:**
- Modify: `scripts/ais-relay.cjs`
- Create: `tests/relay-ai-article-classify.test.mjs`

### Step 1: Write failing test

```javascript
// tests/relay-ai-article-classify.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('relay AI article summarization and classification', () => {
  const src = readFileSync('scripts/ais-relay.cjs', 'utf8');

  it('defines summarizeAndClassifyHeadlines function', () => {
    assert.ok(src.includes('summarizeAndClassifyHeadlines'));
  });

  it('uses news_summary prompt key', () => {
    assert.ok(src.includes("'news_summary'") || src.includes('"news_summary"'));
  });

  it('uses classify_event prompt key', () => {
    assert.ok(src.includes("'classify_event'") || src.includes('"classify_event"'));
  });

  it('broadcasts to ai:article-summaries channel', () => {
    assert.ok(src.includes("'ai:article-summaries'") || src.includes('"ai:article-summaries"'));
  });

  it('broadcasts to ai:classifications channel', () => {
    assert.ok(src.includes("'ai:classifications'") || src.includes('"ai:classifications"'));
  });
});
```

### Step 2: Implement

```javascript
// ── AI: Article Summarization + Event Classification ────────────────────────
// Processes all headlines when news digest updates.
// Batches Ollama calls (one per headline) with concurrency limiting.

const AI_SUMMARIES_CACHE_KEY = 'ai:article-summaries:v1';
const AI_CLASSIFICATIONS_CACHE_KEY = 'ai:classifications:v1';
const AI_ARTICLE_TTL = 86400; // 24 hours
const AI_MAX_CONCURRENT = 3;  // max parallel Ollama calls

async function summarizeAndClassifyHeadlines() {
  const newsData = await redisGet('relay:news:full:v1');
  if (!newsData?.items || !Array.isArray(newsData.items) || newsData.items.length === 0) {
    console.warn('[ai-cron] no news items for article summarization — skipping');
    return;
  }

  const summaryPrompt = await loadLlmPrompt('news_summary', null, 'brief');
  const classifyPrompt = await loadLlmPrompt('classify_event');

  if (!summaryPrompt && !classifyPrompt) {
    console.warn('[ai-cron] no prompts found for summary or classify — skipping');
    return;
  }

  // Load existing caches to skip already-processed headlines
  const existingSummaries = (await redisGet(AI_SUMMARIES_CACHE_KEY)) || {};
  const existingClassifications = (await redisGet(AI_CLASSIFICATIONS_CACHE_KEY)) || {};

  const headlines = newsData.items.slice(0, 100); // cap at 100 per run
  const summaries = { ...existingSummaries };
  const classifications = { ...existingClassifications };
  const dateStr = new Date().toISOString().slice(0, 10);

  // Process in batches with concurrency limiting
  const queue = [];
  for (const item of headlines) {
    const title = item.title || '';
    if (!title || title.length < 10) continue;
    const hash = simpleHash(title.toLowerCase());

    // Skip if already processed and not expired
    if (summaries[hash] && classifications[hash]) continue;

    queue.push({ title, hash, item });
  }

  console.log(`[ai-cron] ${queue.length} new headlines to summarize/classify out of ${headlines.length}`);

  // Process with concurrency limit
  for (let i = 0; i < queue.length; i += AI_MAX_CONCURRENT) {
    const batch = queue.slice(i, i + AI_MAX_CONCURRENT);
    await Promise.all(batch.map(async ({ title, hash }) => {
      // Summarize
      if (summaryPrompt && !summaries[hash]) {
        const sysPrompt = buildPromptFromTemplate(summaryPrompt.systemPrompt, {
          dateContext: `Current date: ${dateStr}.`,
          langInstruction: '',
        });
        const usrPrompt = buildPromptFromTemplate(summaryPrompt.userPrompt, {
          headlineText: title,
          intelSection: '',
        });
        const summary = await callLlmForFunction('news_summary',
          [{ role: 'system', content: sysPrompt }, { role: 'user', content: usrPrompt }],
          { maxTokens: 400, temperature: 0.3 },
        );
        if (summary && summary.length >= 20) {
          summaries[hash] = { text: summary, title, generatedAt: dateStr };
        }
      }

      // Classify
      if (classifyPrompt && !classifications[hash]) {
        const sysPrompt = classifyPrompt.systemPrompt;
        const usrPrompt = buildPromptFromTemplate(classifyPrompt.userPrompt, {
          title: title.slice(0, 500),
        });
        const raw = await callLlmForFunction('classify_event',
          [{ role: 'system', content: sysPrompt }, { role: 'user', content: usrPrompt }],
          { maxTokens: 50, temperature: 0 },
        );
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            if (parsed.level && parsed.category) {
              classifications[hash] = { ...parsed, title, generatedAt: dateStr };
            }
          } catch { /* not valid JSON — skip */ }
        }
      }
    }));
  }

  await redisSetex(AI_SUMMARIES_CACHE_KEY, AI_ARTICLE_TTL, summaries);
  await redisSetex(AI_CLASSIFICATIONS_CACHE_KEY, AI_ARTICLE_TTL, classifications);
  broadcastToChannel('ai:article-summaries', summaries);
  broadcastToChannel('ai:classifications', classifications);
  console.log(`[ai-cron] article AI complete: ${Object.keys(summaries).length} summaries, ${Object.keys(classifications).length} classifications`);
}

// Utility: simple FNV-1a hash for headline dedup
function simpleHash(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

// Run after news digest updates (every 5 min, staggered by 2 min)
cron.schedule('2-59/5 * * * *', async () => {
  try { await summarizeAndClassifyHeadlines(); }
  catch (err) { console.error('[ai-cron] article summarize/classify error:', err?.message ?? err); }
});
```

### Step 3: Run test, commit

```bash
node --test tests/relay-ai-article-classify.test.mjs
git add scripts/ais-relay.cjs tests/relay-ai-article-classify.test.mjs
git commit -m "feat(relay): add article summarization + classification AI crons"
```

---

## Task 6: Implement Country Intel Briefs AI cron

Pre-generates briefs for the top 10-15 most active countries.

**Files:**
- Modify: `scripts/ais-relay.cjs`
- Create: `tests/relay-ai-country-briefs.test.mjs`

### Step 1: Write failing test

```javascript
// tests/relay-ai-country-briefs.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('relay AI country briefs', () => {
  const src = readFileSync('scripts/ais-relay.cjs', 'utf8');

  it('defines generateCountryBriefs function', () => {
    assert.ok(src.includes('generateCountryBriefs'));
  });

  it('uses intel_brief prompt key', () => {
    assert.ok(src.includes("'intel_brief'") || src.includes('"intel_brief"'));
  });

  it('broadcasts to ai:country-briefs channel', () => {
    assert.ok(src.includes("'ai:country-briefs'") || src.includes('"ai:country-briefs"'));
  });

  it('determines active countries from data', () => {
    assert.ok(src.includes('activeCountries') || src.includes('topCountries'),
      'must determine which countries to generate briefs for');
  });
});
```

### Step 2: Implement

```javascript
// ── AI: Country Intel Briefs ────────────────────────────────────────────────
// Pre-generates briefs for the top 15 most active countries.

const AI_COUNTRY_BRIEFS_CACHE_KEY = 'ai:country-briefs:v1';
const AI_COUNTRY_BRIEF_TTL = 7200; // 2 hours

const TIER1_COUNTRIES = {
  US: 'United States', RU: 'Russia', CN: 'China', UA: 'Ukraine',
  IR: 'Iran', IL: 'Israel', TW: 'Taiwan', KP: 'North Korea',
  SA: 'Saudi Arabia', TR: 'Turkey', PL: 'Poland', DE: 'Germany',
  FR: 'France', GB: 'United Kingdom', IN: 'India', PK: 'Pakistan',
  SY: 'Syria', YE: 'Yemen', MM: 'Myanmar', VE: 'Venezuela',
};

const COUNTRY_KEYWORDS = {
  US: ['united states', 'usa', 'america', 'washington', 'biden', 'trump', 'pentagon'],
  RU: ['russia', 'moscow', 'kremlin', 'putin'],
  CN: ['china', 'beijing', 'xi jinping', 'prc'],
  UA: ['ukraine', 'kyiv', 'zelensky', 'donbas'],
  IR: ['iran', 'tehran', 'khamenei', 'irgc'],
  IL: ['israel', 'tel aviv', 'netanyahu', 'idf', 'gaza'],
  TW: ['taiwan', 'taipei'],
  KP: ['north korea', 'pyongyang', 'kim jong'],
  SA: ['saudi arabia', 'riyadh'],
  TR: ['turkey', 'ankara', 'erdogan'],
  PL: ['poland', 'warsaw'],
  DE: ['germany', 'berlin'],
  FR: ['france', 'paris', 'macron'],
  GB: ['britain', 'uk', 'london'],
  IN: ['india', 'delhi', 'modi'],
  PK: ['pakistan', 'islamabad'],
  SY: ['syria', 'damascus'],
  YE: ['yemen', 'sanaa', 'houthi'],
  MM: ['myanmar', 'burma'],
  VE: ['venezuela', 'caracas', 'maduro'],
};

function detectActiveCountries(headlines) {
  const mentions = {};
  for (const [code] of Object.entries(TIER1_COUNTRIES)) mentions[code] = 0;

  for (const title of headlines) {
    const lower = title.toLowerCase();
    for (const [code, keywords] of Object.entries(COUNTRY_KEYWORDS)) {
      if (keywords.some(kw => lower.includes(kw))) {
        mentions[code] = (mentions[code] || 0) + 1;
      }
    }
  }

  return Object.entries(mentions)
    .filter(([, count]) => count > 0)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 15)
    .map(([code]) => code);
}

async function generateCountryBriefs() {
  const prompt = await loadLlmPrompt('intel_brief');
  if (!prompt) {
    console.warn('[ai-cron] no intel_brief prompt found — skipping');
    return;
  }

  // Gather all headlines
  const newsData = await redisGet('relay:news:full:v1');
  const headlines = [];
  if (newsData?.items && Array.isArray(newsData.items)) {
    for (const item of newsData.items.slice(0, 50)) {
      if (item.title) headlines.push(item.title);
    }
  }

  if (headlines.length === 0) {
    console.warn('[ai-cron] no headlines for country briefs — skipping');
    return;
  }

  const topCountries = detectActiveCountries(headlines);
  if (topCountries.length === 0) return;

  const existingBriefs = (await redisGet(AI_COUNTRY_BRIEFS_CACHE_KEY)) || {};
  const briefs = { ...existingBriefs };
  const dateStr = new Date().toISOString().slice(0, 10);
  const headlineText = headlines.map((h, i) => `${i + 1}. ${h}`).join('\n');

  // Process countries sequentially (to avoid overloading Ollama)
  for (const code of topCountries) {
    const countryName = TIER1_COUNTRIES[code] || code;
    const systemPrompt = buildPromptFromTemplate(prompt.systemPrompt, { date: dateStr });
    const userPrompt = buildPromptFromTemplate(prompt.userPrompt, {
      date: dateStr,
      countryName,
      countryCode: code,
      contextSnapshot: '',
      recentHeadlines: headlineText,
    });

    const content = await callLlmForFunction('country_brief',
      [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      { maxTokens: 900, temperature: 0.4 },
    );

    if (content) {
      briefs[code] = {
        brief: content,
        countryName,
        generatedAt: new Date().toISOString(),
      };
    }
  }

  await redisSetex(AI_COUNTRY_BRIEFS_CACHE_KEY, AI_COUNTRY_BRIEF_TTL, briefs);
  broadcastToChannel('ai:country-briefs', briefs);
  console.log(`[ai-cron] generated ${topCountries.length} country briefs`);
}

cron.schedule('*/30 * * * *', async () => {
  try { await generateCountryBriefs(); }
  catch (err) { console.error('[ai-cron] country briefs error:', err?.message ?? err); }
});
```

### Step 3: Run test, commit

```bash
node --test tests/relay-ai-country-briefs.test.mjs
git add scripts/ais-relay.cjs tests/relay-ai-country-briefs.test.mjs
git commit -m "feat(relay): add country intel briefs AI cron — pre-generates top 15 active countries"
```

---

## Task 7: Implement Strategic Posture, Instability, and Risk AI narratives

These generate AI narratives from the existing algorithmic data (scores, theater postures, CII).

**Files:**
- Modify: `scripts/ais-relay.cjs`
- Create: `tests/relay-ai-strategic.test.mjs`
- Create: `supabase/migrations/2026030600001_add_strategic_ai_prompts.sql`

### Step 1: Create Supabase migration for new prompt seeds

```sql
-- Migration: Seed AI prompts for strategic analysis narratives
-- These are new prompt keys used by the relay AI crons.

insert into wm_admin.llm_prompts (prompt_key, variant, mode, model_name, system_prompt, user_prompt)
values
  ('strategic_posture_analysis', null, null, null,
   'You are a military intelligence analyst. Current date: {date}. Provide concise theater-by-theater analysis of military posture based on the data provided. Focus on operational significance, not raw numbers. 3-5 sentences per theater. No speculation beyond what the data supports.',
   'Analyze the following military theater posture data:\n\n{theaterData}\n\nProvide a brief strategic assessment for each theater with elevated or critical posture levels. Highlight any strike-capable formations or unusual activity patterns.'),

  ('country_instability_analysis', null, null, null,
   'You are a geopolitical risk analyst. Current date: {date}. Provide concise analysis of country instability based on the composite scores and contributing factors provided. Focus on what is driving the scores and potential near-term implications. 2-3 sentences per country.',
   'Analyze the following country instability scores:\n\n{countryData}\n\nFor the top countries by score, explain what factors are driving instability and any near-term risks to watch.'),

  ('strategic_risk_overview', null, null, null,
   'You are a senior strategic risk advisor. Current date: {date}. Provide a concise overall risk assessment synthesizing theater posture, country instability, and recent events into a unified picture. 4-6 sentences total. Be direct and actionable.',
   'Current global strategic risk score: {riskScore}/100 ({riskLevel})\nTop contributing factors: {topFactors}\n\nTheater posture summary:\n{postureSummary}\n\nTop instability countries:\n{instabilitySummary}\n\nRecent headlines:\n{headlines}\n\nProvide a brief strategic risk overview synthesizing these signals.')
on conflict (prompt_key, variant, mode, model_name) do nothing;
```

### Step 2: Write failing test

```javascript
// tests/relay-ai-strategic.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('relay AI strategic analysis', () => {
  const src = readFileSync('scripts/ais-relay.cjs', 'utf8');

  it('defines generatePostureAnalysis', () => {
    assert.ok(src.includes('generatePostureAnalysis'));
  });

  it('defines generateInstabilityAnalysis', () => {
    assert.ok(src.includes('generateInstabilityAnalysis'));
  });

  it('defines generateRiskOverview', () => {
    assert.ok(src.includes('generateRiskOverview'));
  });

  it('broadcasts to ai:posture-analysis', () => {
    assert.ok(src.includes("'ai:posture-analysis'"));
  });

  it('broadcasts to ai:instability-analysis', () => {
    assert.ok(src.includes("'ai:instability-analysis'"));
  });

  it('broadcasts to ai:risk-overview', () => {
    assert.ok(src.includes("'ai:risk-overview'"));
  });
});
```

### Step 3: Implement all three

```javascript
// ── AI: Strategic Posture Analysis ──────────────────────────────────────────

async function generatePostureAnalysis() {
  const prompt = await loadLlmPrompt('strategic_posture_analysis');
  if (!prompt) return;

  const postureData = await redisGet('relay:strategic-posture:v1');
  if (!postureData?.theaters || postureData.theaters.length === 0) return;

  const elevated = postureData.theaters.filter(t =>
    t.postureLevel === 'elevated' || t.postureLevel === 'critical'
  );
  if (elevated.length === 0) return; // only analyze elevated+ theaters

  const theaterText = postureData.theaters.map(t =>
    `${t.theater}: ${t.postureLevel} (${t.activeFlights} flights, ${t.trackedVessels ?? 0} vessels, ops: ${(t.activeOperations || []).join(', ') || 'none'})`
  ).join('\n');

  const dateStr = new Date().toISOString().slice(0, 10);
  const systemPrompt = buildPromptFromTemplate(prompt.systemPrompt, { date: dateStr });
  const userPrompt = buildPromptFromTemplate(prompt.userPrompt, { theaterData: theaterText });

  const content = await callLlmForFunction('posture_analysis',
    [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
    { maxTokens: 1000, temperature: 0.3 },
  );
  if (!content) return;

  const payload = { analysis: content, generatedAt: new Date().toISOString(), theaterCount: postureData.theaters.length };
  await redisSetex('ai:posture-analysis:v1', 900, payload);
  broadcastToChannel('ai:posture-analysis', payload);
  console.log(`[ai-cron] posture analysis generated (${content.length} chars)`);
}

// ── AI: Country Instability Analysis ────────────────────────────────────────

async function generateInstabilityAnalysis() {
  const prompt = await loadLlmPrompt('country_instability_analysis');
  if (!prompt) return;

  const riskData = await redisGet('relay:strategic-risk:v1');
  if (!riskData?.ciiScores || riskData.ciiScores.length === 0) return;

  const topScores = riskData.ciiScores
    .filter(s => s.combinedScore >= 30)
    .slice(0, 10);
  if (topScores.length === 0) return;

  const countryText = topScores.map(s =>
    `${s.region} (${TIER1_COUNTRIES[s.region] || s.region}): score=${s.combinedScore}, trend=${s.trend}, components: unrest=${s.components?.ciiContribution ?? 0}, news=${s.components?.newsActivity ?? 0}, military=${s.components?.militaryActivity ?? 0}`
  ).join('\n');

  const dateStr = new Date().toISOString().slice(0, 10);
  const systemPrompt = buildPromptFromTemplate(prompt.systemPrompt, { date: dateStr });
  const userPrompt = buildPromptFromTemplate(prompt.userPrompt, { countryData: countryText });

  const content = await callLlmForFunction('instability_analysis',
    [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
    { maxTokens: 1000, temperature: 0.3 },
  );
  if (!content) return;

  const payload = { analysis: content, generatedAt: new Date().toISOString(), countryCount: topScores.length };
  await redisSetex('ai:instability-analysis:v1', 7200, payload);
  broadcastToChannel('ai:instability-analysis', payload);
  console.log(`[ai-cron] instability analysis generated (${content.length} chars)`);
}

// ── AI: Strategic Risk Overview ─────────────────────────────────────────────

async function generateRiskOverview() {
  const prompt = await loadLlmPrompt('strategic_risk_overview');
  if (!prompt) return;

  const riskData = await redisGet('relay:strategic-risk:v1');
  const postureData = await redisGet('relay:strategic-posture:v1');
  const newsData = await redisGet('relay:news:full:v1');

  if (!riskData?.strategicRisks || riskData.strategicRisks.length === 0) return;

  const globalRisk = riskData.strategicRisks[0];
  const riskScore = globalRisk?.score ?? 0;
  const riskLevel = globalRisk?.level?.replace('SEVERITY_LEVEL_', '') ?? 'UNKNOWN';
  const topFactors = (globalRisk?.factors || []).map(f => TIER1_COUNTRIES[f] || f).join(', ');

  const postureSummary = (postureData?.theaters || [])
    .filter(t => t.postureLevel !== 'normal')
    .map(t => `${t.theater}: ${t.postureLevel}`)
    .join(', ') || 'All theaters normal';

  const instabilitySummary = (riskData?.ciiScores || [])
    .slice(0, 5)
    .map(s => `${TIER1_COUNTRIES[s.region] || s.region}: ${s.combinedScore}`)
    .join(', ');

  const headlines = (newsData?.items || []).slice(0, 10).map(i => i.title).filter(Boolean).join('\n');

  const dateStr = new Date().toISOString().slice(0, 10);
  const systemPrompt = buildPromptFromTemplate(prompt.systemPrompt, { date: dateStr });
  const userPrompt = buildPromptFromTemplate(prompt.userPrompt, {
    riskScore: String(riskScore),
    riskLevel,
    topFactors,
    postureSummary,
    instabilitySummary,
    headlines,
  });

  const content = await callLlmForFunction('risk_overview',
    [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
    { maxTokens: 800, temperature: 0.3 },
  );
  if (!content) return;

  const payload = {
    overview: content,
    riskScore,
    riskLevel,
    model: 'multi-provider',
    generatedAt: new Date().toISOString(),
  };
  await redisSetex('ai:risk-overview:v1', 900, payload);
  broadcastToChannel('ai:risk-overview', payload);
  console.log(`[ai-cron] risk overview generated (${content.length} chars)`);
}

// Register crons — staggered to avoid overloading Ollama
cron.schedule('3-59/15 * * * *', async () => {
  try { await generatePostureAnalysis(); }
  catch (err) { console.error('[ai-cron] posture analysis error:', err?.message ?? err); }
});

cron.schedule('5-59/30 * * * *', async () => {
  try { await generateInstabilityAnalysis(); }
  catch (err) { console.error('[ai-cron] instability analysis error:', err?.message ?? err); }
});

cron.schedule('4-59/15 * * * *', async () => {
  try { await generateRiskOverview(); }
  catch (err) { console.error('[ai-cron] risk overview error:', err?.message ?? err); }
});
```

### Step 4: Run migration, tests, commit

```bash
npx supabase db push
node --test tests/relay-ai-strategic.test.mjs
git add scripts/ais-relay.cjs tests/relay-ai-strategic.test.mjs supabase/migrations/2026030600001_add_strategic_ai_prompts.sql
git commit -m "feat(relay): add strategic posture/instability/risk AI narrative crons"
```

---

## Task 8: Add Deduction HTTP endpoint to relay

The one user-triggered AI function — routes through relay HTTP instead of Vercel.

**Files:**
- Modify: `scripts/ais-relay.cjs` (add HTTP route)
- Create: `tests/relay-deduction-endpoint.test.mjs`

### Step 1: Write failing test

```javascript
// tests/relay-deduction-endpoint.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('relay deduction HTTP endpoint', () => {
  const src = readFileSync('scripts/ais-relay.cjs', 'utf8');

  it('handles POST /api/deduct route', () => {
    assert.ok(src.includes('/api/deduct'), 'must have /api/deduct route');
  });

  it('uses deduction prompt key', () => {
    assert.ok(src.includes("'deduction'"));
  });

  it('validates query input length', () => {
    assert.ok(src.includes('500') || src.includes('query'),
      'must validate query length');
  });
});
```

### Step 2: Implement

Add to the HTTP route handler section of `ais-relay.cjs` (near the existing `/health`, `/bootstrap` routes):

```javascript
// ── HTTP: Deduction endpoint ────────────────────────────────────────────────
// POST /api/deduct — user-triggered situation analysis via Ollama

if (req.method === 'POST' && pathname === '/api/deduct') {
  // Auth check
  if (!authenticateRequest(req)) {
    res.writeHead(401, CORS_HEADERS);
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  let body = '';
  req.on('data', chunk => { body += chunk; if (body.length > 10_000) req.destroy(); });
  req.on('end', async () => {
    try {
      const parsed = JSON.parse(body);
      const query = typeof parsed.query === 'string' ? parsed.query.slice(0, 500) : '';
      const geoContext = typeof parsed.geoContext === 'string' ? parsed.geoContext.slice(0, 2000) : '';

      if (!query) {
        res.writeHead(400, CORS_HEADERS);
        res.end(JSON.stringify({ error: 'query is required' }));
        return;
      }

      // Check Redis cache
      const cacheKey = `ai:deduct:v1:${simpleHash((query + '|' + geoContext).toLowerCase())}`;
      const cached = await redisGet(cacheKey);
      if (cached) {
        res.writeHead(200, CORS_HEADERS);
        res.end(JSON.stringify(cached));
        return;
      }

      const prompt = await loadLlmPrompt('deduction');
      if (!prompt) {
        res.writeHead(503, CORS_HEADERS);
        res.end(JSON.stringify({ error: 'Deduction prompt not configured' }));
        return;
      }

      // Get recent headlines for context
      const newsData = await redisGet('relay:news:full:v1');
      const headlines = (newsData?.items || []).slice(0, 15)
        .map(i => i.title).filter(Boolean)
        .map((h, i) => `${i + 1}. ${h}`).join('\n');

      const systemPrompt = prompt.systemPrompt;
      const userPrompt = buildPromptFromTemplate(prompt.userPrompt, {
        query,
        geoContext,
        recentHeadlines: headlines,
      });

      const content = await callLlmForFunction('deduction',
        [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        { maxTokens: 1500, temperature: 0.3 },
      );

      if (!content) {
        res.writeHead(503, CORS_HEADERS);
        res.end(JSON.stringify({ error: 'LLM generation failed' }));
        return;
      }

      const result = {
        analysis: content,
        model: 'multi-provider',
        generatedAt: new Date().toISOString(),
      };

      await redisSetex(cacheKey, 3600, result); // 1 hour TTL
      res.writeHead(200, CORS_HEADERS);
      res.end(JSON.stringify(result));
    } catch (err) {
      console.error('[relay] /api/deduct error:', err?.message ?? err);
      res.writeHead(500, CORS_HEADERS);
      res.end(JSON.stringify({ error: 'Internal error' }));
    }
  });
  return;
}
```

### Step 3: Run test, commit

```bash
node --test tests/relay-deduction-endpoint.test.mjs
git add scripts/ais-relay.cjs tests/relay-deduction-endpoint.test.mjs
git commit -m "feat(relay): add /api/deduct HTTP endpoint for user-triggered deduction via Ollama"
```

---

## Task 9: Wire client to receive AI data via WebSocket push

Update `App.ts` to subscribe to AI channels. Update panels to display pre-computed AI content.

**Files:**
- Modify: `src/App.ts` (add AI channel subscriptions in `setupRelayPush()`)
- Modify: `src/components/StrategicPosturePanel.ts` (add `applyAiAnalysis`)
- Modify: `src/components/StrategicRiskPanel.ts` (add `applyAiOverview`)
- Modify: `src/components/GlobalDigestPanel.ts` (receive from `ai:intel-digest`)
- Modify: `src/components/SummarizeViewModal.ts` (display cached summary instead of triggering)
- Modify: `src/components/NewsPanel.ts` (display pre-computed summaries)
- Modify: `src/app/event-handlers.ts` (remove SSE summarize-view call)
- Modify: `src/components/DeductionPanel.ts` (call relay `/api/deduct` instead of Vercel)
- Modify: `src/app/country-intel.ts` (remove `/api/intelligence/v1/get-country-intel-brief` fetch; use relay-pushed `ai:country-briefs`)
- Create: `tests/relay-ai-client-wiring.test.mjs`

### Step 1: Add AI channels to `setupRelayPush()` in `src/App.ts`

Add these to the `channels` array:

```typescript
'ai:intel-digest',
'ai:panel-summary',
'ai:article-summaries',
'ai:classifications',
'ai:country-briefs',
'ai:posture-analysis',
'ai:instability-analysis',
'ai:risk-overview',
```

Add subscriptions:

```typescript
subscribeRelayPush('ai:intel-digest', (payload) => {
  const digestPanel = this.state.panels['global-digest'] as GlobalDigestPanel | undefined;
  digestPanel?.applyAiDigest(payload);
});
subscribeRelayPush('ai:panel-summary', (payload) => {
  this.state.latestPanelSummary = payload;
  document.dispatchEvent(new CustomEvent('wm:panel-summary-updated', { detail: payload }));
});
subscribeRelayPush('ai:article-summaries', (payload) => {
  this.state.articleSummaries = payload;
  document.dispatchEvent(new CustomEvent('wm:article-summaries-updated', { detail: payload }));
});
subscribeRelayPush('ai:classifications', (payload) => {
  this.state.classifications = payload;
  document.dispatchEvent(new CustomEvent('wm:classifications-updated', { detail: payload }));
});
subscribeRelayPush('ai:country-briefs', (payload) => {
  this.state.countryBriefs = payload;
});
subscribeRelayPush('ai:posture-analysis', (payload) => {
  const posturePanel = this.state.panels['strategic-posture'] as StrategicPosturePanel | undefined;
  posturePanel?.applyAiAnalysis(payload);
});
subscribeRelayPush('ai:instability-analysis', (payload) => {
  const riskPanel = this.state.panels['strategic-risk'] as StrategicRiskPanel | undefined;
  riskPanel?.applyInstabilityAnalysis(payload);
});
subscribeRelayPush('ai:risk-overview', (payload) => {
  const riskPanel = this.state.panels['strategic-risk'] as StrategicRiskPanel | undefined;
  riskPanel?.applyAiOverview(payload);
});
```

### Step 2: Update SummarizeViewModal

Change from trigger mode to viewer mode — display the latest cached `ai:panel-summary` instead of making an SSE call:

```typescript
public show(): void {
  const cached = (window as any).__wmLatestPanelSummary;
  if (cached?.summary) {
    this.showCachedSummary(cached);
  } else {
    this.showWaiting();
  }
}

private showCachedSummary(data: { summary: string; model: string; generatedAt: string }): void {
  // Display the pre-computed summary with model/timestamp metadata
  // No SSE call, no loading spinner
}
```

### Step 3: Update DeductionPanel

Change the fetch URL from Vercel to the relay:

```typescript
// BEFORE:
const response = await client.deductSituation({ query, geoContext });

// AFTER:
const relayUrl = import.meta.env.VITE_WS_RELAY_URL?.replace('wss://', 'https://').replace('ws://', 'http://');
const response = await fetch(`${relayUrl}/api/deduct`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-relay-key': RELAY_SHARED_SECRET },
  body: JSON.stringify({ query, geoContext }),
});
```

### Step 4: Update Country Intel to relay data

- Remove the direct fetch to `/api/intelligence/v1/get-country-intel-brief`.
- Consume the latest `ai:country-briefs` payload (from relay push or cached in app state).
- Use `generatedAt` and TTL to display staleness indicators.

### Step 5: Run tests, commit

```bash
npm run typecheck
node --test tests/relay-ai-client-wiring.test.mjs
git add src/App.ts src/components/*.ts src/app/event-handlers.ts tests/relay-ai-client-wiring.test.mjs
git commit -m "feat: wire client to receive AI data via relay WebSocket push"
```

---

## Task 10: Remove deprecated AI code and leftover traffic

Clean up Vercel AI endpoints and browser AI services that are no longer called.

**Files to deprecate/remove or trim:**
- `api/intelligence/v1/summarize-view-stream.ts` — add `@deprecated` + early return
- `server/worldmonitor/intelligence/v1/summarize-view.ts` — add `@deprecated`
- `server/worldmonitor/intelligence/v1/get-global-intel-digest.ts` — add `@deprecated`
- `server/worldmonitor/intelligence/v1/get-country-intel-brief.ts` — add `@deprecated`
- `server/worldmonitor/intelligence/v1/classify-event.ts` — add `@deprecated`
- `server/worldmonitor/intelligence/v1/deduct-situation.ts` — add `@deprecated`
- `server/worldmonitor/news/v1/summarize-article.ts` — add `@deprecated`
- `src/services/summarization.ts` — remove browser/cloud AI call logic; keep only relay-cached display if still used
- `src/services/ml-worker.ts` — remove browser T5 **summarization** usage only; keep worker for embeddings/sentiment/NER
- `src/services/threat-classifier.ts` — remove AI calls (classifications arrive via push)
- `src/app/event-handlers.ts` — remove summarize-view SSE request path entirely
- `src/app/country-intel.ts` — remove Vercel brief fetch (relay only)

Do NOT delete the files yet — mark as `@deprecated` so they can be removed in a follow-up after verifying the relay handles everything correctly.

### Step 1: Mark all as deprecated

Add to the top of each server file:

```typescript
/**
 * @deprecated Migrated to relay-native AI (2026-03-06).
 * AI functions now run on the relay server via Ollama cron jobs.
 * This endpoint is no longer called. Kept for rollback reference.
 */
```

### Step 2: Remove browser T5 summarization (keep ML worker for other features)

In `src/App.ts`, remove the ml-worker initialization:

```typescript
// REMOVE: summarization-beta preload — relay handles all summarization
// if (BETA_MODE) mlWorker.loadModel('summarization-beta')
```

### Step 3: Commit

```bash
git add server/ src/ api/
git commit -m "deprecate: mark Vercel AI endpoints as deprecated — relay handles all AI"
```

---

## Task 11: Deploy and smoke test

### Step 1: Deploy relay

```bash
bash scripts/update-relay.sh
```

### Step 2: Verify relay logs

```bash
pm2 logs worldmonitor-relay --lines 100
```

Expected log output:
```
[llm] registered ollama: model=qwen3:14b url=https://ollama.5ls.us
[llm] registered groq: model=llama-3.1-8b-instant
[llm] loaded 10 function configs
[llm] 2 providers ready
[llm] trying ollama for intel_digest (1/1)
[ai-cron] intel digest generated (1234 chars), broadcast to 3 subs
[ai-cron] panel summary generated via model_a+model_b+arbiter (890 chars, 14 sources)
[ai-cron] article AI complete: 45 summaries, 45 classifications
[ai-cron] generated 12 country briefs
[ai-cron] posture analysis generated (456 chars)
[ai-cron] instability analysis generated (567 chars)
[ai-cron] risk overview generated (345 chars)
```

### Step 3: Verify in browser

- Open DevTools → Network → WS tab
- Verify `wm-push` messages arrive for `ai:intel-digest`, `ai:panel-summary`, etc.
- Click "Summarize View" — verify it shows cached summary (no SSE call)
- Check news panel — summaries should be pre-loaded (no sparkle click needed)
- Check Strategic Risk panel — AI narrative should appear alongside scores
- Check Strategic Posture panel — AI analysis should appear for elevated theaters
- Verify Network tab shows **zero** requests to `/api/intelligence/v1/summarize-view-stream`
- Test Deduction panel — verify it calls relay `/api/deduct` (not Vercel)

### Step 4: Commit

```bash
git add scripts/update-relay.sh
git commit -m "ops: deploy relay-native AI — all LLM functions now run on relay server"
```

---

## Execution Checklist

Run before calling complete:

```bash
npm run build                                    # 0 TypeScript errors
node --test tests/relay-ollama-client.test.mjs
node --test tests/relay-ai-intel-digest.test.mjs
node --test tests/relay-ai-panel-summary.test.mjs
node --test tests/relay-ai-article-classify.test.mjs
node --test tests/relay-ai-country-briefs.test.mjs
node --test tests/relay-ai-strategic.test.mjs
node --test tests/relay-deduction-endpoint.test.mjs
node --test tests/relay-ai-client-wiring.test.mjs
npm run test:data                                # all tests pass
```

### Success Metrics

- [ ] Relay resolves ALL enabled providers from Supabase on startup (not just Ollama)
- [ ] Relay loads per-function provider assignments from `llm_function_config`
- [ ] Relay sends `CF-Access-Client-Id` and `CF-Access-Client-Secret` on Ollama calls
- [ ] Relay sends `Authorization: Bearer` for Groq/OpenRouter calls
- [ ] Relay handles qwen3 native `/api/chat` and OpenAI-compat `/v1/chat/completions`
- [ ] Provider fallback works: if primary provider fails, next in chain is tried
- [ ] Panel summary uses two-model consensus (Model A + Model B + Arbiter)
- [ ] Panel summary context includes telegram messages, full article descriptions, all panel data
- [ ] Admin portal shows "Function Config" section for per-function provider assignment
- [ ] All 8 AI cron functions run and produce output
- [ ] Browser receives AI data via WebSocket push (zero AI HTTP calls)
- [ ] "Summarize View" shows cached summary without triggering SSE
- [ ] Article summaries appear pre-loaded in news panel
- [ ] Strategic panels show AI narrative alongside algorithmic scores
- [ ] Deduction routes through relay HTTP, not Vercel
- [ ] No Vercel AI endpoints are called after deployment
- [ ] Browser T5 ml-worker is removed
