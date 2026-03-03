# Admin Portal Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a password-protected admin portal that manages API keys (via Supabase Vault), news feeds, LLM config/prompts, and feature flags — replacing hard-coded env vars and TypeScript config files with database-driven configuration.

**Architecture:** A new `admin.html` entry page (matching the existing `settings.html` pattern) backed by Vercel serverless API routes at `/api/admin/*` that validate Supabase JWTs. All secrets live in Supabase Vault (project `fmultmlsevqgtnqzaylg`); server handlers are updated to call a new `getSecret()` helper that reads from Vault (Redis-cached) with a fallback to `process.env`. LLM provider config and prompts are stored in Supabase and fetched by a `getLlmProvider()` / `getLlmPrompt()` helper at request time.

**Tech Stack:** Supabase (Auth + Vault + Postgres `wm_admin` schema), Vite (vanilla TypeScript, no React — matching existing `settings-window.ts` pattern), Vercel serverless functions, Upstash Redis (caching vault reads), `@supabase/supabase-js` v2.

---

## Pre-flight Checklist (Read Before Starting)

- Supabase project ID: `fmultmlsevqgtnqzaylg`
- Vault is enabled on all Supabase projects by default (uses `pgsodium`)
- Existing HTML multi-page pattern: `settings.html` → `src/settings-main.ts` → `src/settings-window.ts`
- Vite multi-page input is in `vite.config.ts` at `build.rollupOptions.input` (line ~749): already has `main`, `settings`, `liveChannels` entries — add `admin`
- All Vercel API routes live in `/api/` — TypeScript or JavaScript
- Redis client: `server/_shared/redis.ts` already exports `cachedFetchJson` and a `redis` client
- `@supabase/supabase-js` needs to be installed

### Secrets that MUST stay in `process.env` forever (never move to Vault)

Moving these to Vault would create circular dependencies or break the Railway relay:

| Variable | Reason |
|---|---|
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | Used **by** the `getSecret()` caching layer — circular |
| `RELAY_SHARED_SECRET` + `RELAY_AUTH_HEADER` | Also read by Railway relay server (no Supabase client there) |
| `SUPABASE_SERVICE_ROLE_KEY` | The key that unlocks Vault — can't live in Vault |
| `SUPABASE_URL` + `SUPABASE_ANON_KEY` | Bootstraps the Supabase client |
| `CONVEX_URL` | Public endpoint URL, not a secret |
| `VERCEL_ENV` + `VERCEL_GIT_COMMIT_SHA` | Set automatically by Vercel, not editable |
| `NODE_ENV` | Runtime flag, not a credential |

Everything else (API keys, tokens) should move to Vault.

---

## Task 1: Create the Feature Branch

**Files:** None (git only)

**Step 1: Create and switch to the branch**

```bash
git checkout -b feature/admin-portal
```

**Step 2: Verify**

```bash
git branch --show-current
```

Expected: `feature/admin-portal`

**Step 3: Commit**

```bash
git commit --allow-empty -m "chore: start feature/admin-portal branch"
```

---

## Task 2: Add Supabase JS Dependency

**Files:** `package.json` (via npm)

**Step 1: Install**

```bash
npm install @supabase/supabase-js
```

**Step 2: Verify**

```bash
node -e "require('@supabase/supabase-js'); console.log('ok')"
```

Expected: `ok`

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add @supabase/supabase-js dependency"
```

---

## Task 3: Add Supabase Env Vars

**Files:**
- Modify: `.env.example`
- Modify: `server/env.d.ts`

**Step 1: Add to `.env.example`** — after the `# ------ Registration DB (Convex) ------` block:

```
# ------ Admin Portal (Supabase) ------

# Supabase project URL
# Find at: https://supabase.com/dashboard/project/fmultmlsevqgtnqzaylg/settings/api
SUPABASE_URL=https://fmultmlsevqgtnqzaylg.supabase.co

# Supabase anon key (public — used for browser auth flows only)
SUPABASE_ANON_KEY=

# Supabase service role key (SECRET — server only, NEVER expose in browser)
SUPABASE_SERVICE_ROLE_KEY=

# Client-side Supabase config (safe in VITE_ prefix — used by admin portal UI)
VITE_SUPABASE_URL=https://fmultmlsevqgtnqzaylg.supabase.co
VITE_SUPABASE_ANON_KEY=
```

**Step 2: Add to `server/env.d.ts`** — extend the `process` declaration:

```typescript
/** Ambient declaration for process.env — shared by all server-side modules. */
declare const process: {
  env: Record<string, string | undefined> & {
    SUPABASE_URL?: string;
    SUPABASE_ANON_KEY?: string;
    SUPABASE_SERVICE_ROLE_KEY?: string;
  };
};
```

**Step 3: Add to local `.env`** with real values from:
https://supabase.com/dashboard/project/fmultmlsevqgtnqzaylg/settings/api

**Step 4: Commit**

```bash
git add .env.example server/env.d.ts
git commit -m "chore: add Supabase env var declarations for admin portal"
```

---

## Task 4: Create the Supabase Database Schema (Migration)

**Files:**
- Create: `supabase/migrations/20260303000001_admin_schema.sql`

**Step 1: Create directory**

```bash
mkdir -p supabase/migrations
```

**Step 2: Create the migration file** at `supabase/migrations/20260303000001_admin_schema.sql`:

```sql
-- Admin portal schema: feature flags, news sources, LLM config/prompts, vault RPCs

-- ============================================================
-- Schema
-- ============================================================
CREATE SCHEMA IF NOT EXISTS wm_admin;

-- ============================================================
-- 1. Feature Flags
-- Stores ML feature flags, variant config, beta flags.
-- key: dot-namespaced identifier (e.g. 'ml.semanticClustering')
-- value: JSONB — bool, number, string, or object
-- ============================================================
CREATE TABLE wm_admin.feature_flags (
  key         TEXT        PRIMARY KEY,
  value       JSONB       NOT NULL,
  description TEXT,
  category    TEXT        NOT NULL DEFAULT 'general',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  UUID        REFERENCES auth.users(id)
);

INSERT INTO wm_admin.feature_flags (key, value, description, category) VALUES
  ('ml.semanticClustering',     'true',    'Enable semantic news clustering via ONNX embeddings',   'ml'),
  ('ml.mlSentiment',            'true',    'Enable ML-based sentiment analysis',                    'ml'),
  ('ml.summarization',          'true',    'Enable local ONNX summarization',                      'ml'),
  ('ml.mlNER',                  'true',    'Enable named entity recognition',                      'ml'),
  ('ml.insightsPanel',          'true',    'Show ML insights panel in UI',                         'ml'),
  ('ml.semanticClusterThreshold','0.75',   'Cosine similarity threshold for clustering',           'ml'),
  ('ml.minClustersForML',       '5',       'Minimum cluster count before enabling ML features',    'ml'),
  ('ml.maxTextsPerBatch',       '20',      'Max headlines per ML inference batch',                 'ml'),
  ('ml.modelLoadTimeoutMs',     '600000',  'Model load timeout in milliseconds',                   'ml'),
  ('ml.inferenceTimeoutMs',     '120000',  'Single inference timeout in milliseconds',             'ml'),
  ('ml.memoryBudgetMB',         '200',     'Memory budget for loaded ONNX models (MB)',            'ml'),
  ('site.betaMode',             'false',   'Enable beta features for all users',                   'site'),
  ('site.defaultVariant',       '"full"',  'Default site variant (full|tech|finance|happy)',       'site');

-- ============================================================
-- 2. News Sources
-- Replaces hard-coded feed lists in src/config/feeds.ts.
-- url: JSONB — stores string OR Record<lang, url> for multi-language feeds
-- variants: which site variants show this feed (full, tech, finance, happy)
-- ============================================================
CREATE TABLE wm_admin.news_sources (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT        NOT NULL,
  url         JSONB       NOT NULL,  -- string | { en: string, de: string, ... }
  tier        INTEGER     NOT NULL DEFAULT 3 CHECK (tier BETWEEN 1 AND 4),
  variants    TEXT[]      NOT NULL DEFAULT '{full}',
  category    TEXT        NOT NULL DEFAULT 'general',
  source_type TEXT,                  -- 'defense', 'intl', 'research', 'cyber', etc.
  lang        TEXT        NOT NULL DEFAULT 'en',
  proxy_mode  TEXT        NOT NULL DEFAULT 'rss' CHECK (proxy_mode IN ('rss', 'railway', 'direct')),
  enabled     BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  UUID        REFERENCES auth.users(id),
  UNIQUE (name)
);

CREATE INDEX idx_news_sources_variant ON wm_admin.news_sources USING GIN (variants);
CREATE INDEX idx_news_sources_enabled  ON wm_admin.news_sources (enabled);

-- ============================================================
-- 3. LLM Providers
-- Groq (primary) + OpenRouter (fallback) — extensible to others.
-- priority: lower = higher priority (1 = try first)
-- api_key_secret_name: name of the Vault secret holding the API key
-- ============================================================
CREATE TABLE wm_admin.llm_providers (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                TEXT        NOT NULL UNIQUE,
  api_url             TEXT        NOT NULL,
  default_model       TEXT        NOT NULL,
  priority            INTEGER     NOT NULL DEFAULT 1,
  enabled             BOOLEAN     NOT NULL DEFAULT true,
  api_key_secret_name TEXT        NOT NULL, -- e.g. 'GROQ_API_KEY'
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by          UUID        REFERENCES auth.users(id)
);

INSERT INTO wm_admin.llm_providers
  (name, api_url, default_model, priority, api_key_secret_name)
VALUES
  ('groq',       'https://api.groq.com/openai/v1/chat/completions', 'llama-3.1-8b-instant', 1, 'GROQ_API_KEY'),
  ('openrouter', 'https://openrouter.ai/api/v1/chat/completions',   'openai/gpt-4o-mini',   2, 'OPENROUTER_API_KEY');

-- ============================================================
-- 4. LLM Prompts
-- System + user prompts per (prompt_key, variant, mode).
-- NULL variant = applies to all variants.
-- NULL mode    = applies to all modes.
-- Placeholder tokens replaced at runtime: {date}, {dateContext},
-- {headlineText}, {intelSection}, {langInstruction}
-- ============================================================
CREATE TABLE wm_admin.llm_prompts (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_key    TEXT        NOT NULL,
  variant       TEXT,
  mode          TEXT,
  system_prompt TEXT        NOT NULL,
  user_prompt   TEXT,
  description   TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    UUID        REFERENCES auth.users(id),
  UNIQUE (prompt_key, variant, mode)
);

-- Seed intel_brief system prompt
INSERT INTO wm_admin.llm_prompts (prompt_key, variant, mode, system_prompt, description) VALUES
  ('intel_brief', NULL, NULL,
   'You are a senior intelligence analyst providing comprehensive country situation briefs. Current date: {date}. Provide geopolitical context appropriate for the current date.

Write a concise intelligence brief for the requested country covering:
1. Current Situation - what is happening right now
2. Military & Security Posture
3. Key Risk Factors
4. Regional Context
5. Outlook & Watch Items

Rules:
- Be specific and analytical
- 4-5 paragraphs, 250-350 words
- No speculation beyond what data supports
- Use plain language, not jargon
- If a context snapshot is provided, explicitly reflect each non-zero signal category in the brief',
   'Country intelligence brief system prompt. Placeholder: {date}');

-- Seed news_summary prompts (from server/worldmonitor/news/v1/_shared.ts)
INSERT INTO wm_admin.llm_prompts
  (prompt_key, variant, mode, system_prompt, user_prompt, description)
VALUES
  ('news_summary', 'tech', 'brief',
   '{dateContext}

Summarize the single most important tech/startup headline in 2 concise sentences MAX (under 60 words total).
Rules:
- Each numbered headline below is a SEPARATE, UNRELATED story
- Pick the ONE most significant headline and summarize ONLY that story
- NEVER combine or merge facts, names, or details from different headlines
- Focus ONLY on technology, startups, AI, funding, product launches, or developer news
- IGNORE political news, trade policy, tariffs, government actions unless directly about tech regulation
- Lead with the company/product/technology name
- No bullet points, no meta-commentary, no elaboration beyond the core facts{langInstruction}',
   'Each headline below is a separate story. Pick the most important ONE and summarize only that story:
{headlineText}{intelSection}',
   'Tech variant brief mode. Placeholders: {dateContext}, {langInstruction}, {headlineText}, {intelSection}'),

  ('news_summary', NULL, 'brief',
   '{dateContext}

Summarize the single most important headline in 2 concise sentences MAX (under 60 words total).
Rules:
- Each numbered headline below is a SEPARATE, UNRELATED story
- Pick the ONE most significant headline and summarize ONLY that story
- NEVER combine or merge people, places, or facts from different headlines into one sentence
- Lead with WHAT happened and WHERE - be specific
- NEVER start with "Breaking news", "Good evening", "Tonight", or TV-style openings
- Start directly with the subject of the chosen headline
- If intelligence context is provided, use it only if it relates to your chosen headline
- No bullet points, no meta-commentary, no elaboration beyond the core facts{langInstruction}',
   'Each headline below is a separate story. Pick the most important ONE and summarize only that story:
{headlineText}{intelSection}',
   'Default (non-tech) brief mode. Placeholders: {dateContext}, {langInstruction}, {headlineText}, {intelSection}'),

  ('news_summary', 'tech', 'analysis',
   '{dateContext}

Analyze the most significant tech/startup development in 2 concise sentences MAX (under 60 words total).
Rules:
- Each numbered headline below is a SEPARATE, UNRELATED story
- Pick the ONE most significant story and analyze ONLY that
- NEVER combine facts from different headlines
- Focus ONLY on technology implications: funding trends, AI developments, market shifts, product strategy
- IGNORE political implications, trade wars, government unless directly about tech policy
- Lead with the insight, no filler or elaboration',
   'Each headline is a separate story. What''s the key tech trend?
{headlineText}{intelSection}',
   'Tech variant analysis mode. Placeholders: {dateContext}, {headlineText}, {intelSection}'),

  ('news_summary', NULL, 'analysis',
   '{dateContext}

Analyze the most significant development in 2 concise sentences MAX (under 60 words total). Be direct and specific.
Rules:
- Each numbered headline below is a SEPARATE, UNRELATED story
- Pick the ONE most significant story and analyze ONLY that
- NEVER combine or merge people, places, or facts from different headlines
- Lead with the insight - what''s significant and why
- NEVER start with "Breaking news", "Tonight", "The key/dominant narrative is"
- Start with substance, no filler or elaboration
- If intelligence context is provided, use it only if it relates to your chosen headline',
   'Each headline is a separate story. What''s the key pattern or risk?
{headlineText}{intelSection}',
   'Default (non-tech) analysis mode. Placeholders: {dateContext}, {headlineText}, {intelSection}');

-- ============================================================
-- 5. App API Keys (desktop cloud fallback key rotation)
-- Replaces WORLDMONITOR_VALID_KEYS env var (comma-separated).
-- Allows adding/revoking desktop app keys without redeploying.
-- ============================================================
CREATE TABLE wm_admin.app_keys (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  key_hash    TEXT        NOT NULL UNIQUE, -- SHA-256 hex of the raw key
  description TEXT,
  enabled     BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at  TIMESTAMPTZ,
  created_by  UUID        REFERENCES auth.users(id)
);

-- ============================================================
-- 6. Admin Users (which Supabase Auth users are admins)
-- ============================================================
CREATE TABLE wm_admin.admin_users (
  user_id     UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role        TEXT        NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'superadmin')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  UUID        REFERENCES auth.users(id)
);

-- ============================================================
-- 7. RLS Policies
-- Admin tables only accessible via service role OR admin users.
-- ============================================================
ALTER TABLE wm_admin.feature_flags  ENABLE ROW LEVEL SECURITY;
ALTER TABLE wm_admin.news_sources   ENABLE ROW LEVEL SECURITY;
ALTER TABLE wm_admin.llm_providers  ENABLE ROW LEVEL SECURITY;
ALTER TABLE wm_admin.llm_prompts    ENABLE ROW LEVEL SECURITY;
ALTER TABLE wm_admin.app_keys       ENABLE ROW LEVEL SECURITY;
ALTER TABLE wm_admin.admin_users    ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION wm_admin.is_admin()
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM wm_admin.admin_users WHERE user_id = auth.uid()
  );
$$;

CREATE POLICY "admins_all_feature_flags"  ON wm_admin.feature_flags  FOR ALL USING (wm_admin.is_admin());
CREATE POLICY "admins_all_news_sources"   ON wm_admin.news_sources   FOR ALL USING (wm_admin.is_admin());
CREATE POLICY "admins_all_llm_providers"  ON wm_admin.llm_providers  FOR ALL USING (wm_admin.is_admin());
CREATE POLICY "admins_all_llm_prompts"    ON wm_admin.llm_prompts    FOR ALL USING (wm_admin.is_admin());
CREATE POLICY "admins_all_app_keys"       ON wm_admin.app_keys       FOR ALL USING (wm_admin.is_admin());
CREATE POLICY "admins_read_admin_users"   ON wm_admin.admin_users    FOR SELECT USING (wm_admin.is_admin());
CREATE POLICY "superadmins_write_admin_users" ON wm_admin.admin_users FOR ALL
  USING (EXISTS (
    SELECT 1 FROM wm_admin.admin_users
    WHERE user_id = auth.uid() AND role = 'superadmin'
  ));

-- ============================================================
-- 8. Vault RPCs (callable by service role only)
-- ============================================================
CREATE OR REPLACE FUNCTION wm_admin.get_vault_secret(secret_name TEXT)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_secret TEXT;
BEGIN
  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets WHERE name = secret_name LIMIT 1;
  RETURN v_secret;
END;
$$;

CREATE OR REPLACE FUNCTION wm_admin.upsert_vault_secret(
  p_name TEXT, p_secret TEXT, p_description TEXT DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_id UUID;
BEGIN
  SELECT id INTO v_id FROM vault.secrets WHERE name = p_name LIMIT 1;
  IF v_id IS NOT NULL THEN
    PERFORM vault.update_secret(v_id, p_secret, p_name, p_description);
  ELSE
    PERFORM vault.create_secret(p_secret, p_name, p_description);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION wm_admin.list_vault_secret_names()
RETURNS TABLE(name TEXT, description TEXT, updated_at TIMESTAMPTZ)
LANGUAGE sql SECURITY DEFINER AS $$
  SELECT name, description, updated_at FROM vault.secrets ORDER BY name;
$$;

CREATE OR REPLACE FUNCTION wm_admin.delete_vault_secret(p_name TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_id UUID;
BEGIN
  SELECT id INTO v_id FROM vault.secrets WHERE name = p_name LIMIT 1;
  IF v_id IS NOT NULL THEN DELETE FROM vault.secrets WHERE id = v_id; END IF;
END;
$$;

-- Revoke public/anon/authenticated access — service role only
REVOKE ALL ON FUNCTION wm_admin.get_vault_secret(TEXT)                   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION wm_admin.upsert_vault_secret(TEXT, TEXT, TEXT)    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION wm_admin.list_vault_secret_names()                FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION wm_admin.delete_vault_secret(TEXT)                FROM PUBLIC, anon, authenticated;

-- ============================================================
-- 9. RPC: verify_app_key (used by _api-key.js to replace WORLDMONITOR_VALID_KEYS)
-- Returns true if a SHA-256 hex of the raw key matches an enabled app_key row.
-- ============================================================
CREATE OR REPLACE FUNCTION wm_admin.verify_app_key(p_key_hash TEXT)
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM wm_admin.app_keys
    WHERE key_hash = p_key_hash AND enabled = true AND revoked_at IS NULL
  );
$$;

REVOKE ALL ON FUNCTION wm_admin.verify_app_key(TEXT) FROM PUBLIC, anon, authenticated;

-- ============================================================
-- 10. Updated_at triggers
-- ============================================================
CREATE OR REPLACE FUNCTION wm_admin.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

CREATE TRIGGER trg_news_sources_upd   BEFORE UPDATE ON wm_admin.news_sources   FOR EACH ROW EXECUTE FUNCTION wm_admin.set_updated_at();
CREATE TRIGGER trg_llm_providers_upd  BEFORE UPDATE ON wm_admin.llm_providers  FOR EACH ROW EXECUTE FUNCTION wm_admin.set_updated_at();
CREATE TRIGGER trg_llm_prompts_upd    BEFORE UPDATE ON wm_admin.llm_prompts    FOR EACH ROW EXECUTE FUNCTION wm_admin.set_updated_at();
CREATE TRIGGER trg_feature_flags_upd  BEFORE UPDATE ON wm_admin.feature_flags  FOR EACH ROW EXECUTE FUNCTION wm_admin.set_updated_at();
```

**Step 3: Run the migration**

Option A — Supabase CLI:
```bash
npx supabase db push --db-url "postgresql://postgres:[password]@db.fmultmlsevqgtnqzaylg.supabase.co:5432/postgres"
```

Option B — paste in Supabase SQL Editor:
https://supabase.com/dashboard/project/fmultmlsevqgtnqzaylg/sql/new

**Step 4: Verify**

```sql
SELECT table_name FROM information_schema.tables WHERE table_schema = 'wm_admin' ORDER BY table_name;
```

Expected: `admin_users`, `app_keys`, `feature_flags`, `llm_prompts`, `llm_providers`, `news_sources`

**Step 5: Commit**

```bash
git add supabase/
git commit -m "feat: add wm_admin schema — feature flags, news sources, LLM config, vault RPCs, app keys"
```

---

## Task 5: Create the First Admin User

**Step 1:** In the Supabase dashboard, create a user:
https://supabase.com/dashboard/project/fmultmlsevqgtnqzaylg/auth/users → "Add user"

**Step 2:** Copy the user UUID, then run in SQL Editor:

```sql
INSERT INTO wm_admin.admin_users (user_id, role)
VALUES ('YOUR-USER-UUID-HERE', 'superadmin');
```

---

## Task 6: Create the Supabase Server Client Helper

**Files:**
- Create: `server/_shared/supabase.ts`
- Create: `tests/supabase-client.test.mts`

**Step 1: Write the failing test**

```typescript
// tests/supabase-client.test.mts
import { strict as assert } from 'assert';
import { test } from 'node:test';

test('createServiceClient returns object with rpc method', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';

  const { createServiceClient } = await import('../server/_shared/supabase.js');
  const client = createServiceClient();
  assert.ok(typeof client.rpc === 'function', 'client.rpc must be a function');
});
```

**Step 2: Run — expect FAIL**

```bash
npx tsx --test tests/supabase-client.test.mts
```

**Step 3: Create `server/_shared/supabase.ts`**

```typescript
// server/_shared/supabase.ts
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Service-role client — bypasses RLS.
 * ONLY for Vercel server functions. NEVER expose to browser.
 */
export function createServiceClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  }

  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
```

**Step 4: Run — expect PASS**

```bash
npx tsx --test tests/supabase-client.test.mts
```

**Step 5: Commit**

```bash
git add server/_shared/supabase.ts tests/supabase-client.test.mts
git commit -m "feat: add Supabase service client helper"
```

---

## Task 7: Create the `getSecret()` Vault Helper

**Files:**
- Create: `server/_shared/secrets.ts`
- Create: `tests/secrets.test.mts`

**Step 1: Write the failing test**

```typescript
// tests/secrets.test.mts
import { strict as assert } from 'assert';
import { test } from 'node:test';

test('getSecret: returns env var when SUPABASE_URL not set', async () => {
  delete process.env.SUPABASE_URL;
  process.env.GROQ_API_KEY = 'env-groq-key';

  const { getSecret } = await import('../server/_shared/secrets.js');
  const result = await getSecret('GROQ_API_KEY');
  assert.strictEqual(result, 'env-groq-key');
});

test('getSecret: returns undefined when key missing everywhere', async () => {
  delete process.env.SUPABASE_URL;
  delete process.env.MISSING_KEY_XYZ;

  const { getSecret } = await import('../server/_shared/secrets.js');
  const result = await getSecret('MISSING_KEY_XYZ');
  assert.strictEqual(result, undefined);
});
```

**Step 2: Run — expect FAIL**

```bash
npx tsx --test tests/secrets.test.mts
```

**Step 3: Create `server/_shared/secrets.ts`**

```typescript
// server/_shared/secrets.ts
/**
 * Secret resolution with layered fallback:
 * 1. Upstash Redis cache (15-minute TTL — avoids Supabase roundtrip per request)
 * 2. Supabase Vault (wm_admin.get_vault_secret RPC)
 * 3. process.env fallback (existing env var deployments keep working)
 *
 * Secrets that MUST stay in process.env (never in Vault):
 *   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN — used by this module itself
 *   RELAY_SHARED_SECRET, RELAY_AUTH_HEADER — also read by Railway relay server
 *   SUPABASE_*, CONVEX_URL, VERCEL_*, NODE_ENV
 */

import { redis } from './redis';
import { createServiceClient } from './supabase';

const CACHE_TTL_SECONDS = 900; // 15 minutes

// These must never be fetched from Vault — they bootstrap the infrastructure
const ENV_ONLY = new Set([
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'RELAY_SHARED_SECRET',
  'RELAY_AUTH_HEADER',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'CONVEX_URL',
  'NODE_ENV',
  'VERCEL_ENV',
  'VERCEL_GIT_COMMIT_SHA',
]);

function vaultCacheKey(name: string): string {
  return `wm:vault:v1:${name}`;
}

export async function getSecret(secretName: string): Promise<string | undefined> {
  // Infrastructure secrets always come from env
  if (ENV_ONLY.has(secretName)) {
    return process.env[secretName] ?? undefined;
  }

  // If Supabase is not configured, fall through to env
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return process.env[secretName] ?? undefined;
  }

  // 1. Redis cache
  try {
    const cached = await redis.get<string>(vaultCacheKey(secretName));
    if (cached !== null && cached !== undefined) return cached;
  } catch {
    // Redis miss — continue
  }

  // 2. Supabase Vault
  try {
    const supabase = createServiceClient();
    const { data, error } = await supabase.rpc(
      'get_vault_secret',
      { secret_name: secretName },
      { schema: 'wm_admin' },
    );
    if (!error && data) {
      try { await redis.setex(vaultCacheKey(secretName), CACHE_TTL_SECONDS, data); } catch { /* non-fatal */ }
      return data as string;
    }
  } catch {
    // Vault unavailable — fall through
  }

  // 3. Env fallback
  return process.env[secretName] ?? undefined;
}

/** Call after updating a secret via admin portal to clear the cache. */
export async function invalidateSecretCache(secretName: string): Promise<void> {
  try { await redis.del(vaultCacheKey(secretName)); } catch { /* non-fatal */ }
}
```

**Step 4: Run — expect PASS**

```bash
npx tsx --test tests/secrets.test.mts
```

**Step 5: Commit**

```bash
git add server/_shared/secrets.ts tests/secrets.test.mts
git commit -m "feat: add getSecret() vault helper with Redis cache and env fallback"
```

---

## Task 8: Create the `getLlmProvider()` and `getLlmPrompt()` Helpers

These allow server handlers to read LLM config dynamically from Supabase instead of hard-coded constants.

**Files:**
- Create: `server/_shared/llm.ts`
- Create: `tests/llm-helpers.test.mts`

**Step 1: Write the failing test**

```typescript
// tests/llm-helpers.test.mts
import { strict as assert } from 'assert';
import { test } from 'node:test';

test('buildPrompt: replaces {date} placeholder', async () => {
  const { buildPrompt } = await import('../server/_shared/llm.js');
  const result = buildPrompt('Hello {date}', { date: '2026-03-03' });
  assert.strictEqual(result, 'Hello 2026-03-03');
});

test('buildPrompt: leaves unknown placeholders untouched', async () => {
  const { buildPrompt } = await import('../server/_shared/llm.js');
  const result = buildPrompt('Hi {unknown}', { date: '2026-03-03' });
  assert.strictEqual(result, 'Hi {unknown}');
});
```

**Step 2: Run — expect FAIL**

```bash
npx tsx --test tests/llm-helpers.test.mts
```

**Step 3: Create `server/_shared/llm.ts`**

```typescript
// server/_shared/llm.ts
/**
 * LLM provider resolution.
 * Fetches active provider config from wm_admin.llm_providers (Redis-cached).
 * Falls back to hard-coded constants if Supabase is unavailable.
 */

import { redis } from './redis';
import { createServiceClient } from './supabase';
import { getSecret } from './secrets';

// Hard-coded fallbacks (used when Supabase is unavailable)
const FALLBACK_GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const FALLBACK_GROQ_MODEL = 'llama-3.1-8b-instant';

const PROVIDER_CACHE_TTL = 900; // 15 minutes
const PROMPT_CACHE_TTL = 900;

export interface LlmProvider {
  name: string;
  apiUrl: string;
  model: string;
  apiKey: string;
}

export interface LlmPromptResult {
  systemPrompt: string;
  userPrompt: string;
}

/**
 * Returns the highest-priority enabled LLM provider with its API key resolved.
 * Falls back to Groq env var if Supabase is unavailable.
 */
export async function getActiveLlmProvider(): Promise<LlmProvider | null> {
  // Try Redis cache first
  try {
    const cached = await redis.get<LlmProvider>('wm:llm:active-provider:v1');
    if (cached) return cached;
  } catch { /* non-fatal */ }

  // Try Supabase
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const supabase = createServiceClient();
      const { data, error } = await supabase
        .schema('wm_admin')
        .from('llm_providers')
        .select('name, api_url, default_model, api_key_secret_name')
        .eq('enabled', true)
        .order('priority', { ascending: true })
        .limit(1)
        .single();

      if (!error && data) {
        const apiKey = await getSecret(data.api_key_secret_name);
        if (apiKey) {
          const provider: LlmProvider = {
            name: data.name,
            apiUrl: data.api_url,
            model: data.default_model,
            apiKey,
          };
          try { await redis.setex('wm:llm:active-provider:v1', PROVIDER_CACHE_TTL, JSON.stringify(provider)); } catch { /* non-fatal */ }
          return provider;
        }
      }
    } catch { /* fall through */ }
  }

  // Env fallback
  const apiKey = await getSecret('GROQ_API_KEY');
  if (!apiKey) return null;

  return {
    name: 'groq',
    apiUrl: process.env.LLM_API_URL || FALLBACK_GROQ_URL,
    model: process.env.LLM_MODEL || FALLBACK_GROQ_MODEL,
    apiKey,
  };
}

/**
 * Fetches a prompt by key/variant/mode from wm_admin.llm_prompts.
 * Tries exact match (variant+mode), then variant-only, then mode-only, then wildcard.
 * Falls back to null if Supabase unavailable.
 */
export async function getLlmPrompt(
  promptKey: string,
  variant: string,
  mode: string,
): Promise<LlmPromptResult | null> {
  const cacheKey = `wm:llm:prompt:v1:${promptKey}:${variant}:${mode}`;

  try {
    const cached = await redis.get<LlmPromptResult>(cacheKey);
    if (cached) return cached;
  } catch { /* non-fatal */ }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return null;
  }

  try {
    const supabase = createServiceClient();

    // Try most-specific match first, then fall back
    const candidates = [
      { variant, mode },
      { variant, mode: null },
      { variant: null, mode },
      { variant: null, mode: null },
    ];

    for (const { variant: v, mode: m } of candidates) {
      let query = supabase
        .schema('wm_admin')
        .from('llm_prompts')
        .select('system_prompt, user_prompt')
        .eq('prompt_key', promptKey);

      query = v ? query.eq('variant', v) : query.is('variant', null);
      query = m ? query.eq('mode', m) : query.is('mode', null);

      const { data, error } = await query.single();

      if (!error && data) {
        const result: LlmPromptResult = {
          systemPrompt: data.system_prompt,
          userPrompt: data.user_prompt ?? '',
        };
        try { await redis.setex(cacheKey, PROMPT_CACHE_TTL, JSON.stringify(result)); } catch { /* non-fatal */ }
        return result;
      }
    }
  } catch { /* fall through */ }

  return null;
}

/**
 * Replace {placeholder} tokens in a prompt template.
 * Unknown placeholders are left untouched.
 */
export function buildPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key) => vars[key] ?? match);
}

/** Invalidate LLM caches after admin changes */
export async function invalidateLlmCache(): Promise<void> {
  try {
    await redis.del('wm:llm:active-provider:v1');
    // Prompt caches will expire naturally after 15 min
  } catch { /* non-fatal */ }
}
```

**Step 4: Run — expect PASS**

```bash
npx tsx --test tests/llm-helpers.test.mts
```

**Step 5: Commit**

```bash
git add server/_shared/llm.ts tests/llm-helpers.test.mts
git commit -m "feat: add getLlmProvider() and getLlmPrompt() helpers with Supabase fallback"
```

---

## Task 9: Migrate Server Handlers to Use `getSecret()` and `getLlmProvider()`

**Complete list of files to migrate:**

### 9a. API Keys — use `getSecret()`

For each file below, replace `process.env.XXX` with `await getSecret('XXX')` (functions are already async).

| File | Old | New |
|---|---|---|
| `server/worldmonitor/intelligence/v1/get-country-intel-brief.ts` | `process.env.GROQ_API_KEY` | `await getSecret('GROQ_API_KEY')` |
| `server/worldmonitor/intelligence/v1/get-risk-scores.ts` | `process.env.GROQ_API_KEY` | `await getSecret('GROQ_API_KEY')` |
| `server/worldmonitor/intelligence/v1/classify-event.ts` | `process.env.GROQ_API_KEY` | `await getSecret('GROQ_API_KEY')` |
| `server/worldmonitor/economic/v1/get-fred-series.ts` | `process.env.FRED_API_KEY` | `await getSecret('FRED_API_KEY')` |
| `server/worldmonitor/economic/v1/get-energy-prices.ts` | `process.env.EIA_API_KEY` | `await getSecret('EIA_API_KEY')` |
| `server/worldmonitor/economic/v1/get-energy-capacity.ts` | `process.env.EIA_API_KEY` | `await getSecret('EIA_API_KEY')` |
| `server/worldmonitor/supply-chain/v1/get-shipping-rates.ts` | `process.env.FRED_API_KEY` | `await getSecret('FRED_API_KEY')` |
| `server/worldmonitor/military/v1/get-aircraft-details-batch.ts` | `process.env.WINGBITS_API_KEY` | `await getSecret('WINGBITS_API_KEY')` |
| `server/worldmonitor/market/v1/list-market-quotes.ts` | `process.env.FINNHUB_API_KEY` | `await getSecret('FINNHUB_API_KEY')` |
| `server/worldmonitor/wildfire/v1/list-fire-detections.ts` | `process.env.NASA_FIRMS_API_KEY \|\| process.env.FIRMS_API_KEY` | `await getSecret('NASA_FIRMS_API_KEY') ?? await getSecret('FIRMS_API_KEY')` |
| `server/worldmonitor/cyber/v1/_shared.ts` | `process.env.OTX_API_KEY` | `await getSecret('OTX_API_KEY')` |
| `server/worldmonitor/cyber/v1/_shared.ts` | `process.env.ABUSEIPDB_API_KEY` | `await getSecret('ABUSEIPDB_API_KEY')` |
| `server/worldmonitor/cyber/v1/_shared.ts` | `process.env.URLHAUS_AUTH_KEY` | `await getSecret('URLHAUS_AUTH_KEY')` |
| `server/worldmonitor/trade/v1/_shared.ts` | `process.env.WTO_API_KEY` | `await getSecret('WTO_API_KEY')` |
| `server/_shared/acled.ts` | `process.env.ACLED_ACCESS_TOKEN` | `await getSecret('ACLED_ACCESS_TOKEN')` |
| `api/eia/[[...path]].js` | `process.env.EIA_API_KEY` | *(JS file — add supabase client or keep as env-only for now; see note below)* |

> **Note on JS files in `/api/`:** The plain JS Vercel functions (`api/eia/...`, etc.) cannot import TypeScript helpers directly. For these files, keep using `process.env` for now — the Vault migration covers the TypeScript server handlers first. The JS files can be migrated in a follow-up once they're converted to TypeScript, or they can call `getSecret` if the build compiles them.

### 9b. `deduct-situation.ts` — use `getActiveLlmProvider()`

This file already has a generic LLM config pattern (`LLM_API_KEY || GROQ_API_KEY`, `LLM_API_URL`, `LLM_MODEL`). Replace it:

**Before** (in `server/worldmonitor/intelligence/v1/deduct-situation.ts`):

```typescript
const apiKey = process.env.LLM_API_KEY || process.env.GROQ_API_KEY;
const apiUrl = process.env.LLM_API_URL || DEFAULT_API_URL;
const model = process.env.LLM_MODEL || DEFAULT_MODEL;
if (!apiKey) { ... }
```

**After:**

```typescript
import { getActiveLlmProvider } from '../../../_shared/llm';
// ...
const provider = await getActiveLlmProvider();
if (!provider) { return empty; }
const { apiKey, apiUrl, model } = provider;
// use apiKey, apiUrl, model below (same variable names, no other changes needed)
```

### 9c. News summary `buildArticlePrompts()` — use `getLlmPrompt()`

In `server/worldmonitor/news/v1/_shared.ts`, the `buildArticlePrompts()` function has all prompts hard-coded. Refactor it to accept an optional DB-fetched prompt override:

**Before** (function signature):

```typescript
export function buildArticlePrompts(
  headlines: string[],
  uniqueHeadlines: string[],
  opts: { mode: string; geoContext: string; variant: string; lang: string },
): { systemPrompt: string; userPrompt: string }
```

**After** (add optional `dbPrompt` param for the Supabase-fetched override):

```typescript
export function buildArticlePrompts(
  headlines: string[],
  uniqueHeadlines: string[],
  opts: { mode: string; geoContext: string; variant: string; lang: string },
  dbPrompt?: { systemPrompt: string; userPrompt: string } | null,
): { systemPrompt: string; userPrompt: string }
```

Inside the function, add at the top:

```typescript
// If a DB-managed prompt is provided, use it with placeholder substitution
if (dbPrompt?.systemPrompt) {
  const { buildPrompt } = await import('../../../_shared/llm');
  const headlineText = uniqueHeadlines.map((h, i) => `${i + 1}. ${h}`).join('\n');
  const intelSection = opts.geoContext ? `\n\n${opts.geoContext}` : '';
  const dateContext = `Current date: ${new Date().toISOString().split('T')[0]}.`;
  const langInstruction = opts.lang && opts.lang !== 'en'
    ? `\nIMPORTANT: Output the summary in ${opts.lang.toUpperCase()} language.`
    : '';

  return {
    systemPrompt: buildPrompt(dbPrompt.systemPrompt, { dateContext, langInstruction }),
    userPrompt: buildPrompt(dbPrompt.userPrompt ?? '', { headlineText, intelSection }),
  };
}
// ... existing hard-coded logic follows as fallback
```

Then in the handler that calls `buildArticlePrompts()`, fetch the prompt first:

```typescript
import { getLlmPrompt } from '../../../_shared/llm';
// ...
const dbPrompt = await getLlmPrompt('news_summary', opts.variant, opts.mode);
const { systemPrompt, userPrompt } = buildArticlePrompts(headlines, unique, opts, dbPrompt);
```

**Step: Typecheck after all migrations**

```bash
npx tsc --noEmit && npx tsc --noEmit -p tsconfig.api.json
```

Expected: No new errors.

**Step: Commit**

```bash
git add server/
git commit -m "feat: migrate server handlers to getSecret(), getActiveLlmProvider(), getLlmPrompt()"
```

---

## Task 10: Create Admin API Routes (Vercel Functions)

**Files:**
- Create: `api/admin/_auth.ts`
- Create: `api/admin/secrets.ts`
- Create: `api/admin/feature-flags.ts`
- Create: `api/admin/news-sources.ts`
- Create: `api/admin/llm-providers.ts`
- Create: `api/admin/llm-prompts.ts`
- Create: `api/admin/app-keys.ts`

**Step 1: Create the auth guard** `api/admin/_auth.ts`

```typescript
// api/admin/_auth.ts
import { createClient } from '@supabase/supabase-js';

export interface AdminUser {
  id: string;
  email: string;
  role: string;
}

export async function requireAdmin(req: Request): Promise<AdminUser> {
  const auth = req.headers.get('Authorization') ?? '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();

  if (!token) throw { status: 401, body: 'Missing Authorization header' };

  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anonKey || !serviceKey) throw { status: 500, body: 'Supabase not configured' };

  // Verify JWT
  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user }, error } = await userClient.auth.getUser();
  if (error || !user) throw { status: 401, body: 'Invalid or expired token' };

  // Check admin role
  const serviceClient = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: adminRecord, error: adminError } = await serviceClient
    .schema('wm_admin')
    .from('admin_users')
    .select('role')
    .eq('user_id', user.id)
    .single();

  if (adminError || !adminRecord) throw { status: 403, body: 'Not an admin user' };

  return { id: user.id, email: user.email!, role: adminRecord.role };
}

export function errorResponse(err: unknown): Response {
  if (err && typeof err === 'object' && 'status' in err) {
    const e = err as { status: number; body: string };
    return new Response(JSON.stringify({ error: e.body }), {
      status: e.status,
      headers: corsHeaders(),
    });
  }
  console.error('[admin] Unexpected error:', err);
  return new Response(JSON.stringify({ error: 'Internal server error' }), {
    status: 500,
    headers: corsHeaders(),
  });
}

export function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };
}
```

**Step 2: Create `api/admin/secrets.ts`** (CRUD for Vault secrets)

```typescript
// api/admin/secrets.ts
import { requireAdmin, errorResponse, corsHeaders } from './_auth';
import { createServiceClient } from '../../server/_shared/supabase';
import { invalidateSecretCache } from '../../server/_shared/secrets';
import { invalidateLlmCache } from '../../server/_shared/llm';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  const headers = corsHeaders();
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });

  try { await requireAdmin(req); } catch (err) { return errorResponse(err); }

  const supabase = createServiceClient();
  const url = new URL(req.url);
  const secretName = url.searchParams.get('name');

  // GET — list names (never values)
  if (req.method === 'GET') {
    const { data, error } = await supabase.rpc('list_vault_secret_names', {}, { schema: 'wm_admin' });
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    return new Response(JSON.stringify({ secrets: data }), { status: 200, headers });
  }

  // POST — create or update
  if (req.method === 'POST') {
    const body = await req.json() as { name: string; value: string; description?: string };
    if (!body.name || !body.value)
      return new Response(JSON.stringify({ error: 'name and value required' }), { status: 400, headers });

    const { error } = await supabase.rpc(
      'upsert_vault_secret',
      { p_name: body.name, p_secret: body.value, p_description: body.description ?? null },
      { schema: 'wm_admin' },
    );
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });

    await invalidateSecretCache(body.name);
    // If this is an LLM key, also invalidate the provider cache
    if (body.name.includes('GROQ') || body.name.includes('OPENROUTER') || body.name.includes('LLM')) {
      await invalidateLlmCache();
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  }

  // DELETE
  if (req.method === 'DELETE') {
    if (!secretName)
      return new Response(JSON.stringify({ error: 'name param required' }), { status: 400, headers });

    const { error } = await supabase.rpc(
      'delete_vault_secret', { p_name: secretName }, { schema: 'wm_admin' }
    );
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    await invalidateSecretCache(secretName);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
}
```

**Step 3: Create the remaining CRUD routes** following the same pattern as `secrets.ts`:

**`api/admin/feature-flags.ts`** — table: `wm_admin.feature_flags`
- `GET` → select all, order by `category, key`
- `PUT` body `{ key, value, description? }` → upsert on conflict `key`

**`api/admin/news-sources.ts`** — table: `wm_admin.news_sources`
- `GET` → select all, order by `tier, name`; supports `?variant=tech` filter
- `POST` body `{ name, url, tier, variants, category, lang, proxy_mode? }` → insert
- `PUT ?id=UUID` body (partial update) → update where `id`
- `DELETE ?id=UUID` → delete where `id`

**`api/admin/llm-providers.ts`** — table: `wm_admin.llm_providers`
- `GET` → select all, order by `priority`
- `PUT ?id=UUID` body (partial update) → update; call `invalidateLlmCache()`

**`api/admin/llm-prompts.ts`** — table: `wm_admin.llm_prompts`
- `GET ?key=intel_brief` → select all matching `prompt_key`; no `key` param = all rows
- `PUT ?id=UUID` body `{ system_prompt, user_prompt? }` → update; Redis prompts expire naturally

**`api/admin/app-keys.ts`** — table: `wm_admin.app_keys`
- `GET` → select `id, description, enabled, created_at, revoked_at` (never `key_hash`)
- `POST` body `{ rawKey, description? }` → SHA-256 hash the rawKey server-side, insert `key_hash`
- `DELETE ?id=UUID` → set `enabled=false, revoked_at=now()` (soft delete)

> For `app-keys.ts` POST, hash the raw key server-side using Web Crypto:
> ```typescript
> const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.rawKey));
> const keyHash = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
> ```

**Step 4: Typecheck**

```bash
npx tsc --noEmit -p tsconfig.api.json
```

**Step 5: Commit**

```bash
git add api/admin/
git commit -m "feat: add admin API routes for secrets, flags, news sources, LLM config, app keys"
```

---

## Task 11: Update `api/_api-key.js` to Use Supabase App Keys

**Files:**
- Modify: `api/_api-key.js`

Currently `api/_api-key.js` reads `WORLDMONITOR_VALID_KEYS` (comma-separated env var) to validate desktop app access keys. Replace with a Supabase lookup that checks the `wm_admin.app_keys` table via the `verify_app_key` RPC.

**Step 1: Read the current file**

```bash
cat api/_api-key.js
```

**Step 2: Add Supabase key validation alongside the existing env var check**

Find the function that validates keys (it reads `WORLDMONITOR_VALID_KEYS`) and update it to:

```javascript
// api/_api-key.js (relevant section)
async function isValidKey(rawKey) {
  // 1. Fast env var check (WORLDMONITOR_VALID_KEYS remains as fallback/override)
  const validKeys = (process.env.WORLDMONITOR_VALID_KEYS || '').split(',').filter(Boolean);
  if (validKeys.includes(rawKey)) return true;

  // 2. Supabase app_keys table check
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return false;

  try {
    const keyHash = await sha256hex(rawKey);
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/verify_app_key`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Accept-Profile': 'wm_admin',
      },
      body: JSON.stringify({ p_key_hash: keyHash }),
    });
    if (!res.ok) return false;
    const result = await res.json();
    return result === true;
  } catch {
    return false;
  }
}

async function sha256hex(input) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
```

**Step 3: Commit**

```bash
git add api/_api-key.js
git commit -m "feat: update app key validation to check Supabase wm_admin.app_keys via verify_app_key RPC"
```

---

## Task 12: Add Admin Entry to Vite Config

**Files:**
- Modify: `vite.config.ts`

**Step 1: Find the existing input block** (around line 749):

```typescript
input: {
  main: resolve(__dirname, 'index.html'),
  settings: resolve(__dirname, 'settings.html'),
  liveChannels: resolve(__dirname, 'live-channels.html'),
},
```

**Step 2: Add admin entry** — exact replacement:

```typescript
input: {
  main: resolve(__dirname, 'index.html'),
  settings: resolve(__dirname, 'settings.html'),
  liveChannels: resolve(__dirname, 'live-channels.html'),
  admin: resolve(__dirname, 'admin.html'),
},
```

**Step 3: Commit**

```bash
git add vite.config.ts
git commit -m "chore: add admin.html as Vite multi-page entry point"
```

---

## Task 13: Create the Admin Portal HTML & Bundle

**Files:**
- Create: `admin.html`
- Create: `src/admin-main.ts`
- Create: `src/admin/login.ts`
- Create: `src/admin/dashboard.ts`

**Step 1: Create `admin.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>World Monitor — Admin</title>
  <meta name="robots" content="noindex, nofollow" />
  <style>
    :root {
      --bg: #0d1117; --surface: #161b22; --border: #30363d;
      --text: #e6edf3; --text-muted: #8b949e;
      --accent: #388bfd; --accent-hover: #58a6ff;
      --danger: #da3633; --success: #3fb950; --warning: #d29922;
      --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      --radius: 6px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg); color: var(--text); font-family: var(--font); font-size: 14px; min-height: 100vh; }
    #app { display: flex; flex-direction: column; min-height: 100vh; }
  </style>
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/src/admin-main.ts"></script>
</body>
</html>
```

**Step 2: Create `src/admin-main.ts`**

```typescript
// src/admin-main.ts
import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';
import { renderLoginPage } from './admin/login';
import { renderDashboard } from './admin/dashboard';

const supabase: SupabaseClient = createClient(
  import.meta.env.VITE_SUPABASE_URL as string,
  import.meta.env.VITE_SUPABASE_ANON_KEY as string,
  { auth: { persistSession: true } },
);

const app = document.getElementById('app')!;

async function init(): Promise<void> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    renderLoginPage(app, supabase, onSignIn);
    return;
  }
  await onSignIn(session.user, session.access_token);
}

async function onSignIn(user: User, accessToken: string): Promise<void> {
  const res = await fetch('/api/admin/feature-flags', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 401 || res.status === 403) {
    app.innerHTML = `<div style="padding:40px;text-align:center;color:var(--danger)">
      <h2>Access Denied</h2><p>This account does not have admin access.</p>
      <button onclick="location.reload()" style="margin-top:16px;padding:8px 16px;cursor:pointer">Sign Out</button>
    </div>`;
    await supabase.auth.signOut();
    return;
  }

  renderDashboard(app, supabase, accessToken, user);
}

init().catch(console.error);
```

**Step 3: Create `src/admin/login.ts`**

```typescript
// src/admin/login.ts
import type { SupabaseClient, User } from '@supabase/supabase-js';

export function renderLoginPage(
  container: HTMLElement,
  supabase: SupabaseClient,
  onSuccess: (user: User, token: string) => void,
): void {
  container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;min-height:100vh">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:40px;width:360px">
        <h1 style="font-size:20px;margin-bottom:4px">World Monitor</h1>
        <p style="color:var(--text-muted);margin-bottom:24px">Admin Portal</p>

        <label style="display:block;color:var(--text-muted);margin-bottom:4px">Email</label>
        <input id="admin-email" type="email" autocomplete="email" style="
          width:100%;padding:8px 12px;margin-bottom:16px;
          background:var(--bg);border:1px solid var(--border);
          border-radius:var(--radius);color:var(--text);font-size:14px;
        "/>

        <label style="display:block;color:var(--text-muted);margin-bottom:4px">Password</label>
        <input id="admin-password" type="password" autocomplete="current-password" style="
          width:100%;padding:8px 12px;margin-bottom:24px;
          background:var(--bg);border:1px solid var(--border);
          border-radius:var(--radius);color:var(--text);font-size:14px;
        "/>

        <button id="admin-login-btn" style="
          width:100%;padding:10px;background:var(--accent);color:#fff;
          border:none;border-radius:var(--radius);cursor:pointer;font-size:14px;font-weight:600;
        ">Sign In</button>
        <p id="admin-login-error" style="color:var(--danger);margin-top:12px;display:none"></p>
      </div>
    </div>
  `;

  const btn = container.querySelector<HTMLButtonElement>('#admin-login-btn')!;
  const errEl = container.querySelector<HTMLParagraphElement>('#admin-login-error')!;

  async function attempt(): Promise<void> {
    const email = (container.querySelector<HTMLInputElement>('#admin-email')!).value.trim();
    const password = (container.querySelector<HTMLInputElement>('#admin-password')!).value;
    if (!email || !password) { errEl.textContent = 'Email and password required.'; errEl.style.display = 'block'; return; }

    btn.disabled = true; btn.textContent = 'Signing in…'; errEl.style.display = 'none';
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error || !data.session) {
      btn.disabled = false; btn.textContent = 'Sign In';
      errEl.textContent = 'Invalid email or password.'; errEl.style.display = 'block';
      return;
    }
    onSuccess(data.user, data.session.access_token);
  }

  btn.addEventListener('click', attempt);
  container.querySelector<HTMLInputElement>('#admin-password')!
    .addEventListener('keydown', e => { if (e.key === 'Enter') attempt(); });
}
```

**Step 4: Create `src/admin/dashboard.ts`**

```typescript
// src/admin/dashboard.ts
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { renderSecretsPage }      from './pages/secrets';
import { renderFeatureFlagsPage } from './pages/feature-flags';
import { renderNewsSourcesPage }  from './pages/news-sources';
import { renderLlmConfigPage }    from './pages/llm-config';
import { renderAppKeysPage }      from './pages/app-keys';

type PageId = 'secrets' | 'feature-flags' | 'news-sources' | 'llm-config' | 'app-keys';

const NAV: Array<{ id: PageId; label: string; icon: string }> = [
  { id: 'secrets',       label: 'API Keys & Secrets',  icon: '🔑' },
  { id: 'feature-flags', label: 'Feature Flags',        icon: '🚩' },
  { id: 'news-sources',  label: 'News Sources',         icon: '📡' },
  { id: 'llm-config',    label: 'LLM Config & Prompts', icon: '🤖' },
  { id: 'app-keys',      label: 'App Access Keys',      icon: '🗝️'  },
];

export function renderDashboard(
  container: HTMLElement,
  supabase: SupabaseClient,
  accessToken: string,
  user: User,
): void {
  container.innerHTML = `
    <div style="display:flex;min-height:100vh">
      <nav style="width:220px;background:var(--surface);border-right:1px solid var(--border);padding:20px 0;display:flex;flex-direction:column">
        <div style="padding:0 16px 20px;border-bottom:1px solid var(--border)">
          <div style="font-weight:700">World Monitor</div>
          <div style="color:var(--text-muted);font-size:12px">Admin Portal</div>
        </div>
        <ul id="admin-nav" style="list-style:none;padding:12px 0;flex:1">
          ${NAV.map(item => `
            <li><a href="#${item.id}" data-page="${item.id}" style="
              display:flex;align-items:center;gap:10px;padding:8px 16px;
              color:var(--text-muted);text-decoration:none;border-radius:var(--radius);
              margin:2px 8px;cursor:pointer;
            ">${item.icon} ${item.label}</a></li>
          `).join('')}
        </ul>
        <div style="padding:16px;border-top:1px solid var(--border)">
          <div style="color:var(--text-muted);font-size:12px;margin-bottom:8px">${user.email}</div>
          <button id="admin-signout" style="
            width:100%;padding:6px;background:transparent;
            border:1px solid var(--border);border-radius:var(--radius);
            color:var(--text-muted);cursor:pointer;font-size:13px;
          ">Sign Out</button>
        </div>
      </nav>
      <main id="admin-content" style="flex:1;padding:32px;overflow-y:auto"></main>
    </div>
  `;

  const content = container.querySelector<HTMLElement>('#admin-content')!;
  const nav = container.querySelector<HTMLElement>('#admin-nav')!;

  function navigateTo(pageId: PageId): void {
    nav.querySelectorAll('a').forEach(a => {
      const active = a.dataset['page'] === pageId;
      a.style.background = active ? 'rgba(56,139,253,0.15)' : 'transparent';
      a.style.color = active ? 'var(--accent)' : 'var(--text-muted)';
    });
    content.innerHTML = '';
    switch (pageId) {
      case 'secrets':       renderSecretsPage(content, accessToken);      break;
      case 'feature-flags': renderFeatureFlagsPage(content, accessToken); break;
      case 'news-sources':  renderNewsSourcesPage(content, accessToken);  break;
      case 'llm-config':    renderLlmConfigPage(content, accessToken);    break;
      case 'app-keys':      renderAppKeysPage(content, accessToken);      break;
    }
  }

  nav.addEventListener('click', e => {
    const link = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[data-page]');
    if (!link) return;
    e.preventDefault();
    navigateTo(link.dataset['page'] as PageId);
  });

  container.querySelector('#admin-signout')!.addEventListener('click', async () => {
    await supabase.auth.signOut();
    location.reload();
  });

  const hash = location.hash.replace('#', '') as PageId;
  navigateTo(NAV.some(n => n.id === hash) ? hash : 'secrets');
}
```

**Step 5: Build verify**

```bash
npm run build 2>&1 | tail -20
```

Expected: Build succeeds, `dist/admin.html` created.

**Step 6: Commit**

```bash
git add admin.html src/admin-main.ts src/admin/
git commit -m "feat: add admin portal HTML shell, login page, and dashboard navigation"
```

---

## Task 14: Admin Pages — Secrets Manager

**Files:** Create `src/admin/pages/secrets.ts`

Full implementation: renders a table of vault secret names (no values), add form with `name`, `value` (password input), `description`, delete button per row.

Key logic:
- `GET /api/admin/secrets` → load list
- `POST /api/admin/secrets` with `{ name, value, description }` → save
- `DELETE /api/admin/secrets?name=FOO` → delete with confirmation

**Step: Commit**

```bash
git add src/admin/pages/secrets.ts
git commit -m "feat: add admin secrets manager page"
```

---

## Task 15: Admin Pages — Feature Flags

**Files:** Create `src/admin/pages/feature-flags.ts`

Groups rows by `category`. Booleans render as toggles, numbers as number inputs, strings as text inputs. On change, debounce 500ms then `PUT /api/admin/feature-flags` with `{ key, value }`.

**Step: Commit**

```bash
git add src/admin/pages/feature-flags.ts
git commit -m "feat: add admin feature flags page with inline toggle/edit"
```

---

## Task 16: Admin Pages — News Sources Manager

**Files:** Create `src/admin/pages/news-sources.ts`

Features:
- Searchable, filterable table (search by name/URL, filter by variant or enabled)
- Columns: Name, URL (show if string, or `{multi-lang}` badge if object), Tier, Variants (chips), Category, Lang, Proxy Mode, Enabled toggle
- Add form for new sources
- Edit inline (click row to expand)
- Bulk import: textarea accepting JSON array of `{ name, url, tier, variants, category, lang }`

**Step: Commit**

```bash
git add src/admin/pages/news-sources.ts
git commit -m "feat: add admin news sources manager with CRUD, search, and bulk import"
```

---

## Task 17: Admin Pages — LLM Config & Prompts

**Files:** Create `src/admin/pages/llm-config.ts`

Two sections:

**Section A — Providers**: table with Name, API URL, Default Model, Priority, Enabled toggle. Edit inline. Changes call `PUT /api/admin/llm-providers?id=UUID`.

**Section B — Prompts**: Tab per `prompt_key` (`intel_brief`, `news_summary`). Within each tab, show a row per `(variant, mode)` combo. Large `<textarea>` for system and user prompt. Save button per row. Show placeholder reference:
```
Available placeholders: {date}, {dateContext}, {headlineText}, {intelSection}, {langInstruction}
```

**Step: Commit**

```bash
git add src/admin/pages/llm-config.ts
git commit -m "feat: add admin LLM config and prompts editor"
```

---

## Task 18: Admin Pages — App Access Keys

**Files:** Create `src/admin/pages/app-keys.ts`

Manages desktop app API keys (replaces `WORLDMONITOR_VALID_KEYS`):
- Table: Description, Created At, Status (Active/Revoked)
- "Generate New Key" button: generates a `wm_XXX` key client-side (`crypto.getRandomValues`), shows it ONCE, calls `POST /api/admin/app-keys` with the raw key + description
- "Revoke" button: calls `DELETE /api/admin/app-keys?id=UUID` (soft delete)
- Warning banner: "Each key is shown once — copy and store it immediately"

**Step: Commit**

```bash
git add src/admin/pages/app-keys.ts
git commit -m "feat: add admin app access keys page with generate and revoke"
```

---

## Task 19: Seed News Sources into Supabase

**Files:** Create `scripts/seed-news-sources.mts`

> **Important:** `feeds.ts` exports `FULL_FEEDS`, `TECH_FEEDS`, `FINANCE_FEEDS`, `HAPPY_FEEDS` as `Record<string, Feed[]>` (category → feeds array) and `INTEL_SOURCES` as `Feed[]`. Import these directly — **not** the runtime-conditional `FEEDS` export. The `Feed` type has `name`, `url` (`string | Record<string, string>`), `type?`, `lang?`. Tier is NOT on `Feed` — look it up via `SOURCE_TIERS[name]`.

```typescript
// scripts/seed-news-sources.mts
import { createClient } from '@supabase/supabase-js';
import { SOURCE_TIERS } from '../src/config/feeds.ts';

// Import the actual feed dicts (not the runtime conditional FEEDS export)
// Using a dynamic import workaround since SITE_VARIANT would be undefined in Node
const { FULL_FEEDS, TECH_FEEDS, FINANCE_FEEDS, HAPPY_FEEDS, INTEL_SOURCES } =
  await import('../src/config/feeds.ts');

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

// Track which (name, variant) combos we've seen to build variants array per name
const feedMap = new Map<string, {
  url: string | Record<string, string>;
  tier: number;
  variants: Set<string>;
  category: string;
  source_type: string | null;
  lang: string;
}>();

function addFeeds(
  dict: Record<string, Array<{ name: string; url: string | Record<string, string>; type?: string; lang?: string }>>,
  variant: string,
): void {
  for (const [category, feeds] of Object.entries(dict)) {
    for (const f of feeds) {
      if (!feedMap.has(f.name)) {
        feedMap.set(f.name, {
          url: f.url,
          tier: SOURCE_TIERS[f.name] ?? 3,
          variants: new Set([variant]),
          category,
          source_type: null,
          lang: f.lang ?? 'en',
        });
      } else {
        feedMap.get(f.name)!.variants.add(variant);
      }
    }
  }
}

addFeeds(FULL_FEEDS,    'full');
addFeeds(TECH_FEEDS,    'tech');
addFeeds(FINANCE_FEEDS, 'finance');
addFeeds(HAPPY_FEEDS,   'happy');

// INTEL_SOURCES are always 'full'
for (const f of INTEL_SOURCES) {
  if (!feedMap.has(f.name)) {
    feedMap.set(f.name, {
      url: f.url,
      tier: SOURCE_TIERS[f.name] ?? 3,
      variants: new Set(['full']),
      category: 'intel',
      source_type: (f as { type?: string }).type ?? null,
      lang: (f as { lang?: string }).lang ?? 'en',
    });
  }
}

const records = [...feedMap.entries()].map(([name, data]) => ({
  name,
  url: typeof data.url === 'string' ? data.url : data.url, // JSONB accepts both
  tier: data.tier,
  variants: [...data.variants],
  category: data.category,
  source_type: data.source_type,
  lang: data.lang,
  proxy_mode: typeof data.url === 'string' && data.url.includes('rss-proxy') ? 'rss' : 'direct',
  enabled: true,
}));

console.log(`Seeding ${records.length} news sources…`);

// Upsert in batches of 100 (Supabase batch limit)
for (let i = 0; i < records.length; i += 100) {
  const batch = records.slice(i, i + 100);
  const { error } = await supabase
    .schema('wm_admin')
    .from('news_sources')
    .upsert(batch, { onConflict: 'name' });

  if (error) { console.error('Batch failed:', error); process.exit(1); }
  console.log(`  Seeded batch ${Math.floor(i / 100) + 1} (${i}–${i + batch.length})`);
}

console.log('Done.');
```

**Step 1: Verify the import works before running**

```bash
npx tsx -e "
  const { FULL_FEEDS } = await import('./src/config/feeds.ts');
  const cats = Object.keys(FULL_FEEDS);
  console.log('Categories:', cats.length, cats.slice(0, 3));
"
```

Expected: prints categories like `['politics', 'us', 'europe', ...]`

**Step 2: Run the seed**

```bash
npx tsx scripts/seed-news-sources.mts
```

Expected: `Seeding N news sources… Done.`

**Step 3: Commit**

```bash
git add scripts/seed-news-sources.mts
git commit -m "chore: add news sources seed script (correct Feed type + FULL/TECH/FINANCE/HAPPY/INTEL)"
```

---

## Task 20: Update Vercel Config for Admin Route

**Files:** Modify `vercel.json`

Add to the `headers` array (before the existing `"/(.*)"` entry):

```json
{
  "source": "/admin",
  "headers": [
    { "key": "Cache-Control", "value": "no-cache, no-store, must-revalidate" },
    { "key": "X-Robots-Tag", "value": "noindex, nofollow" }
  ]
},
{
  "source": "/admin.html",
  "headers": [
    { "key": "Cache-Control", "value": "no-cache, no-store, must-revalidate" },
    { "key": "X-Robots-Tag", "value": "noindex, nofollow" }
  ]
}
```

**Step: Commit**

```bash
git add vercel.json
git commit -m "feat: add no-cache and noindex headers for admin portal"
```

---

## Task 21: Smoke Tests for Admin API

**Files:** Create `e2e/admin-portal.spec.ts`

```typescript
// e2e/admin-portal.spec.ts
import { test, expect } from '@playwright/test';

test.describe('Admin Portal', () => {
  test('shows login form at /admin.html', async ({ page }) => {
    await page.goto('/admin.html');
    await expect(page.locator('#admin-email')).toBeVisible();
    await expect(page.locator('#admin-password')).toBeVisible();
    await expect(page.locator('#admin-login-btn')).toBeVisible();
  });

  test('shows error on invalid credentials', async ({ page }) => {
    await page.goto('/admin.html');
    await page.fill('#admin-email', 'notanadmin@example.com');
    await page.fill('#admin-password', 'wrongpassword');
    await page.click('#admin-login-btn');
    await expect(page.locator('#admin-login-error')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#admin-login-error')).toContainText('Invalid email or password');
  });

  test('/api/admin/secrets returns 401 without token', async ({ request }) => {
    const res = await request.get('/api/admin/secrets');
    expect(res.status()).toBe(401);
  });

  test('/api/admin/feature-flags returns 401 without token', async ({ request }) => {
    const res = await request.get('/api/admin/feature-flags');
    expect(res.status()).toBe(401);
  });

  test('/api/admin/news-sources returns 401 without token', async ({ request }) => {
    const res = await request.get('/api/admin/news-sources');
    expect(res.status()).toBe(401);
  });

  test('/api/admin/app-keys returns 401 without token', async ({ request }) => {
    const res = await request.get('/api/admin/app-keys');
    expect(res.status()).toBe(401);
  });

  test('/api/admin/llm-prompts returns 401 without token', async ({ request }) => {
    const res = await request.get('/api/admin/llm-prompts');
    expect(res.status()).toBe(401);
  });
});
```

**Step 1: Run**

```bash
npx playwright test e2e/admin-portal.spec.ts
```

Expected: All 7 tests pass.

**Step 2: Commit**

```bash
git add e2e/admin-portal.spec.ts
git commit -m "test: add smoke tests for admin portal auth and API 401 enforcement"
```

---

## Task 22: Final Typecheck, README, and Cleanup

**Step 1: Full typecheck**

```bash
npx tsc --noEmit && npx tsc --noEmit -p tsconfig.api.json
```

Expected: No errors.

**Step 2: Run all smoke tests**

```bash
npx playwright test e2e/admin-portal.spec.ts
```

Expected: All pass.

**Step 3: Add admin portal section to README**

After the configuration section, add:

```markdown
## Admin Portal

A password-protected admin portal is available at `/admin.html`.

**Setup:** Create a Supabase Auth account, then insert the user UUID into `wm_admin.admin_users`.

**What you can manage:**
- **API Keys & Secrets** — stored in Supabase Vault (encrypted); values never returned after save
- **Feature Flags** — ML feature toggles, site configuration
- **News Sources** — add/edit/disable RSS feeds; bulk JSON import
- **LLM Config & Prompts** — provider selection (Groq/OpenRouter), model, system prompts per variant/mode
- **App Access Keys** — generate/revoke desktop cloud fallback keys (replaces `WORLDMONITOR_VALID_KEYS`)

**Required Vercel env vars:**
```
SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
```

**Secrets that must stay in env (not Vault):**
`UPSTASH_REDIS_*`, `RELAY_SHARED_SECRET`, `RELAY_AUTH_HEADER`, all `SUPABASE_*`, `CONVEX_URL`
```

**Step 4: Final commit**

```bash
git add README.md
git commit -m "docs: add admin portal documentation to README"
```

---

## Deployment Notes

1. **Apply migration SQL** to Supabase project `fmultmlsevqgtnqzaylg` (Task 4)
2. **Create the first admin user** in Supabase Auth (Task 5)
3. **Set Vercel env vars**: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
4. **Run news sources seed** once after migration: `npx tsx scripts/seed-news-sources.mts`
5. **Migrate API keys to Vault** via the admin portal after first deploy — existing `process.env` values continue working as fallback until migrated
6. **Gradually retire `WORLDMONITOR_VALID_KEYS`** — add keys via admin portal App Keys page; remove from Vercel env once all keys are in Supabase

---

## Security Summary

| Control | Implementation |
|---|---|
| Auth | Supabase Auth (email/password) + `wm_admin.admin_users` role check on every API request |
| Secret storage | Supabase Vault (`pgsodium` encryption at rest) |
| Secret exposure | Values never returned by any API; list endpoint returns names + metadata only |
| Vault access | `get_vault_secret` RPC revoked from `anon`/`authenticated` — service role only |
| App key hashing | SHA-256 of raw key stored; raw key shown once to operator, never stored |
| Bot protection | Admin portal served from `admin.html`; `noindex` + no-cache headers; not in middleware matcher |
| HTTPS | Enforced by Vercel HSTS headers (`max-age=63072000; includeSubDomains; preload`) |
| Infrastructure secrets | Explicitly excluded from Vault lookup via `ENV_ONLY` set in `secrets.ts` |
| CORS | Origin allowlist from `api/_cors.js` (not wildcard `*`) |
| Rate limiting | Admin endpoints limited to 60 req/60s per IP via `@upstash/ratelimit` |
| Audit logging | `wm_admin.audit_log` table records every admin action (actor, resource, old/new values; secret values redacted) |
| Input validation | All admin API request bodies validated with Zod schemas |
| Token refresh | `onAuthStateChange` keeps session fresh; all API calls use current token |

---

## Addendum — Brainstorm Review (2026-03-03)

> Design doc: `docs/plans/2026-03-03-admin-portal-addendum-design.md`

The original Tasks 1–22 build the admin CRUD layer. This addendum wires the main application to read from Supabase at runtime (eliminating all hardcoded config), hardens security, and adds UX consistency.

**Design principles:**
1. No hardcoded fallbacks — database is the single source of truth
2. Resolution order: Redis cache → Supabase query → feature unavailable
3. All security gaps addressed
4. Full UX consistency with the settings page

### Modifications to Existing Tasks

#### Task 2 — Also Install Zod

Add to the install step:

```bash
npm install @supabase/supabase-js zod
```

#### Task 4 — Additional Schema Objects

Add these to the migration SQL file **after** the existing `news_sources` table definition:

**Extra columns on `news_sources`:**

```sql
ALTER TABLE wm_admin.news_sources ADD COLUMN IF NOT EXISTS propaganda_risk TEXT NOT NULL DEFAULT 'low'
  CHECK (propaganda_risk IN ('low', 'medium', 'high'));
ALTER TABLE wm_admin.news_sources ADD COLUMN IF NOT EXISTS state_affiliated TEXT;
ALTER TABLE wm_admin.news_sources ADD COLUMN IF NOT EXISTS propaganda_note TEXT;
ALTER TABLE wm_admin.news_sources ADD COLUMN IF NOT EXISTS default_enabled BOOLEAN NOT NULL DEFAULT true;
```

**Audit log table:**

```sql
CREATE TABLE wm_admin.audit_log (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id    UUID        NOT NULL REFERENCES auth.users(id),
  action      TEXT        NOT NULL CHECK (action IN ('create', 'update', 'delete')),
  resource    TEXT        NOT NULL,
  resource_id TEXT,
  details     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE wm_admin.audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admins_read_audit_log" ON wm_admin.audit_log FOR SELECT USING (wm_admin.is_admin());
CREATE POLICY "service_insert_audit_log" ON wm_admin.audit_log FOR INSERT WITH CHECK (true);
CREATE INDEX idx_audit_log_created ON wm_admin.audit_log (created_at DESC);
CREATE INDEX idx_audit_log_resource ON wm_admin.audit_log (resource, resource_id);
```

**Prompt history table + trigger:**

```sql
CREATE TABLE wm_admin.llm_prompt_history (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_id       UUID        NOT NULL REFERENCES wm_admin.llm_prompts(id) ON DELETE CASCADE,
  prompt_key      TEXT        NOT NULL,
  variant         TEXT,
  mode            TEXT,
  system_prompt   TEXT        NOT NULL,
  user_prompt     TEXT,
  changed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  changed_by      UUID        REFERENCES auth.users(id)
);

ALTER TABLE wm_admin.llm_prompt_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admins_read_prompt_history" ON wm_admin.llm_prompt_history FOR SELECT USING (wm_admin.is_admin());
CREATE INDEX idx_prompt_history_prompt ON wm_admin.llm_prompt_history (prompt_id, changed_at DESC);

CREATE OR REPLACE FUNCTION wm_admin.archive_prompt_on_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO wm_admin.llm_prompt_history
    (prompt_id, prompt_key, variant, mode, system_prompt, user_prompt, changed_by)
  VALUES
    (OLD.id, OLD.prompt_key, OLD.variant, OLD.mode, OLD.system_prompt, OLD.user_prompt, NEW.updated_by);
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_llm_prompts_history
  BEFORE UPDATE ON wm_admin.llm_prompts
  FOR EACH ROW EXECUTE FUNCTION wm_admin.archive_prompt_on_update();
```

**Additional feature flag seeds** (add to existing INSERT):

```sql
INSERT INTO wm_admin.feature_flags (key, value, description, category) VALUES
  ('site.alertKeywords',        '["breaking","urgent","emergency","developing","crisis","attack","killed","earthquake","tsunami","explosion","missile","nuclear"]',
   'Keywords that trigger breaking news alerts', 'site'),
  ('site.alertExclusions',      '["sale","deal","review","opinion","editorial","podcast","newsletter"]',
   'Keywords that prevent breaking news alerts', 'site'),
  ('site.sourceRegionMap',      '{"worldwide":{"labelKey":"header.sourceRegionWorldwide","feedKeys":["politics","crisis"]},"us":{"labelKey":"header.sourceRegionUS","feedKeys":["us","gov"]},"europe":{"labelKey":"header.sourceRegionEurope","feedKeys":["europe"]},"middleeast":{"labelKey":"header.sourceRegionMiddleEast","feedKeys":["middleeast"]},"asia":{"labelKey":"header.sourceRegionAsia","feedKeys":["asia"]},"africa":{"labelKey":"header.sourceRegionAfrica","feedKeys":["africa"]},"latam":{"labelKey":"header.sourceRegionLatAm","feedKeys":["latam"]}}',
   'Region-to-feed-category mapping for UI', 'site');
```

#### Task 10 — Security Hardening of Admin API Routes

**Replace `corsHeaders()` in `api/admin/_auth.ts`** with the existing origin-based CORS:

```typescript
import { getCorsHeaders } from '../_cors';

export function adminCorsHeaders(req: Request): Record<string, string> {
  return getCorsHeaders(req, 'GET, POST, PUT, DELETE, OPTIONS');
}
```

**Add rate limiting** — create a separate admin rate limiter:

```typescript
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

let adminRl: Ratelimit | null = null;
function getAdminRatelimit(): Ratelimit | null {
  if (adminRl) return adminRl;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  adminRl = new Ratelimit({
    redis: new Redis({ url, token }),
    limiter: Ratelimit.slidingWindow(60, '60 s'),
    prefix: 'rl:admin',
    analytics: false,
  });
  return adminRl;
}

export async function checkAdminRateLimit(req: Request, headers: Record<string, string>): Promise<Response | null> {
  const rl = getAdminRatelimit();
  if (!rl) return null;
  const ip = req.headers.get('x-real-ip') || req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || '0.0.0.0';
  try {
    const { success, limit, reset } = await rl.limit(ip);
    if (!success) {
      return new Response(JSON.stringify({ error: 'Too many requests' }), {
        status: 429,
        headers: { ...headers, 'Retry-After': String(Math.ceil((reset - Date.now()) / 1000)) },
      });
    }
    return null;
  } catch { return null; }
}
```

**Add audit log helper:**

```typescript
import { createServiceClient } from '../../server/_shared/supabase';

export async function logAuditEvent(
  actorId: string,
  action: 'create' | 'update' | 'delete',
  resource: string,
  resourceId: string | null,
  details?: Record<string, unknown>,
): Promise<void> {
  try {
    const supabase = createServiceClient();
    await supabase.schema('wm_admin').from('audit_log').insert({
      actor_id: actorId,
      action,
      resource,
      resource_id: resourceId,
      details: details ?? null,
    });
  } catch { /* non-fatal — never block the request */ }
}
```

**Update every CRUD handler** to:
1. Call `checkAdminRateLimit()` before `requireAdmin()`
2. Use `adminCorsHeaders(req)` instead of `corsHeaders()`
3. Pass `admin.id` as `updated_by` / `created_by` in all insert/update queries
4. Call `logAuditEvent()` after successful mutations

**Add Zod validation** — create `api/admin/_validation.ts`:

```typescript
import { z } from 'zod';

export const SecretCreateSchema = z.object({
  name: z.string().min(1).max(100).regex(/^[A-Z][A-Z0-9_]*$/),
  value: z.string().min(1).max(10_000),
  description: z.string().max(500).optional(),
});

export const FeatureFlagSchema = z.object({
  key: z.string().min(1).max(200),
  value: z.unknown(),
  description: z.string().max(500).optional(),
});

export const NewsSourceSchema = z.object({
  name: z.string().min(1).max(200),
  url: z.union([z.string().url(), z.record(z.string(), z.string().url())]),
  tier: z.number().int().min(1).max(4).optional(),
  variants: z.array(z.enum(['full', 'tech', 'finance', 'happy'])).optional(),
  category: z.string().min(1).max(50).optional(),
  source_type: z.string().max(50).nullable().optional(),
  lang: z.string().min(2).max(5).optional(),
  proxy_mode: z.enum(['rss', 'railway', 'direct']).optional(),
  propaganda_risk: z.enum(['low', 'medium', 'high']).optional(),
  state_affiliated: z.string().max(100).nullable().optional(),
  propaganda_note: z.string().max(500).nullable().optional(),
  default_enabled: z.boolean().optional(),
});

export const LlmProviderSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  api_url: z.string().url().optional(),
  default_model: z.string().min(1).max(100).optional(),
  priority: z.number().int().min(1).max(10).optional(),
  enabled: z.boolean().optional(),
  api_key_secret_name: z.string().min(1).max(100).optional(),
});

export const LlmPromptSchema = z.object({
  system_prompt: z.string().min(1).max(50_000),
  user_prompt: z.string().max(50_000).nullable().optional(),
  description: z.string().max(500).optional(),
});

export const AppKeySchema = z.object({
  rawKey: z.string().min(10).max(200),
  description: z.string().max(500).optional(),
});
```

Each handler wraps body parsing:

```typescript
const parsed = SecretCreateSchema.safeParse(await req.json());
if (!parsed.success) {
  return new Response(JSON.stringify({ error: 'Validation failed', details: parsed.error.flatten() }),
    { status: 400, headers });
}
const body = parsed.data;
```

#### Task 13 — UX Consistency

Update `admin.html` to link external CSS and remove inline styles:

```html
<link rel="stylesheet" href="/src/styles/admin.css" />
```

Update `src/admin-main.ts` to init i18n and theme:

```typescript
import { initI18n } from '@/services/i18n';
import { applyStoredTheme } from '@/utils/theme-manager';

async function init(): Promise<void> {
  await initI18n();
  applyStoredTheme();
  // ... rest of init
}
```

#### Tasks 14–18 — Use `t()` for All Strings

All admin page files use `import { t } from '@/services/i18n'` and reference keys like:
- `t('modals.admin.secrets.title')`, `t('modals.admin.secrets.addNew')`, etc.
- `t('modals.admin.flags.title')`, `t('modals.admin.flags.toggle')`, etc.
- `t('modals.admin.news.title')`, `t('modals.admin.news.search')`, etc.

#### Task 19 — Expanded Seed Script

Update `scripts/seed-news-sources.mts` to:
1. Also import from `server/worldmonitor/news/v1/_feeds.ts` (`VARIANT_FEEDS`, `INTEL_SOURCES`)
2. Merge server-side feeds with client-side feeds (server feeds have raw URLs, client feeds have proxy-wrapped URLs — store raw URLs in the database)
3. Include `propaganda_risk`, `state_affiliated`, `propaganda_note`, `default_enabled` metadata from `SOURCE_PROPAGANDA_RISK` and `DEFAULT_ENABLED_SOURCES`

#### Task 20 — Add Vercel Rewrite

Add to `vercel.json` a new top-level `rewrites` array (or append if it exists):

```json
{
  "rewrites": [
    { "source": "/admin", "destination": "/admin.html" }
  ]
}
```

---

## Task 23: Create `server/_shared/news-sources.ts` Helper

**Files:**
- Create: `server/_shared/news-sources.ts`

```typescript
// server/_shared/news-sources.ts
import { redis } from './redis';
import { createServiceClient } from './supabase';

export interface DynamicFeed {
  name: string;
  url: string;
  lang: string;
  category: string;
  tier: number;
}

const CACHE_TTL = 900; // 15 minutes

/**
 * Fetch news sources for a given variant and language.
 * Resolution: Redis → Supabase → empty array (no hardcoded fallback).
 */
export async function getNewsSources(
  variant: string,
  lang: string,
): Promise<Record<string, DynamicFeed[]>> {
  const cacheKey = `wm:feeds:v1:${variant}:${lang}`;

  // 1. Redis cache
  try {
    const cached = await redis.get<Record<string, DynamicFeed[]>>(cacheKey);
    if (cached) return cached;
  } catch { /* non-fatal */ }

  // 2. Supabase
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return {};
  }

  try {
    const supabase = createServiceClient();
    const { data, error } = await supabase
      .schema('wm_admin')
      .from('news_sources')
      .select('name, url, lang, category, tier')
      .eq('enabled', true)
      .contains('variants', [variant]);

    if (error || !data) return {};

    const feeds: DynamicFeed[] = data.map(row => ({
      name: row.name,
      url: typeof row.url === 'string' ? row.url : (row.url[lang] ?? row.url['en'] ?? Object.values(row.url)[0]),
      lang: row.lang,
      category: row.category,
      tier: row.tier,
    }));

    // Filter by language
    const filtered = feeds.filter(f => !f.lang || f.lang === lang || f.lang === 'en');

    // Group by category
    const grouped: Record<string, DynamicFeed[]> = {};
    for (const feed of filtered) {
      (grouped[feed.category] ??= []).push(feed);
    }

    try { await redis.setex(cacheKey, CACHE_TTL, JSON.stringify(grouped)); } catch { /* non-fatal */ }
    return grouped;
  } catch { return {}; }
}

/**
 * Fetch intel sources (variant='full', source_type IS NOT NULL).
 */
export async function getIntelSources(lang: string): Promise<DynamicFeed[]> {
  const cacheKey = `wm:feeds:intel:v1:${lang}`;

  try {
    const cached = await redis.get<DynamicFeed[]>(cacheKey);
    if (cached) return cached;
  } catch { /* non-fatal */ }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return [];

  try {
    const supabase = createServiceClient();
    const { data, error } = await supabase
      .schema('wm_admin')
      .from('news_sources')
      .select('name, url, lang, category, tier')
      .eq('enabled', true)
      .eq('category', 'intel')
      .not('source_type', 'is', null);

    if (error || !data) return [];

    const feeds: DynamicFeed[] = data
      .filter(row => !row.lang || row.lang === lang || row.lang === 'en')
      .map(row => ({
        name: row.name,
        url: typeof row.url === 'string' ? row.url : (row.url[lang] ?? row.url['en'] ?? Object.values(row.url)[0]),
        lang: row.lang,
        category: 'intel',
        tier: row.tier,
      }));

    try { await redis.setex(cacheKey, CACHE_TTL, JSON.stringify(feeds)); } catch { /* non-fatal */ }
    return feeds;
  } catch { return []; }
}

export async function invalidateNewsFeedCache(): Promise<void> {
  // Invalidation is approximate — delete known keys; others expire naturally
  try {
    const keys = await redis.keys('wm:feeds:*');
    if (keys.length) await redis.del(...keys);
  } catch { /* non-fatal */ }
}
```

**Commit:**

```bash
git add server/_shared/news-sources.ts
git commit -m "feat: add getNewsSources() helper — reads from Supabase with Redis cache, no hardcoded fallback"
```

---

## Task 24: Migrate `list-feed-digest.ts` to Dynamic News Sources

**Files:**
- Modify: `server/worldmonitor/news/v1/list-feed-digest.ts`

**Step 1: Replace static imports with dynamic helper**

**Before:**

```typescript
import { VARIANT_FEEDS, INTEL_SOURCES, type ServerFeed } from './_feeds';
```

**After:**

```typescript
import { getNewsSources, getIntelSources, type DynamicFeed } from '../../../_shared/news-sources';
```

**Step 2: Update `buildDigest()`**

**Before:**

```typescript
async function buildDigest(variant: string, lang: string): Promise<ListFeedDigestResponse> {
  const feedsByCategory = VARIANT_FEEDS[variant] ?? {};
  // ...
  for (const [category, feeds] of Object.entries(feedsByCategory)) {
    const filtered = feeds.filter(f => !f.lang || f.lang === lang);
    // ...
  }
  if (variant === 'full') {
    const filteredIntel = INTEL_SOURCES.filter(f => !f.lang || f.lang === lang);
    // ...
  }
```

**After:**

```typescript
async function buildDigest(variant: string, lang: string): Promise<ListFeedDigestResponse> {
  const feedsByCategory = await getNewsSources(variant, lang);
  // ...
  for (const [category, feeds] of Object.entries(feedsByCategory)) {
    for (const feed of feeds) {
      allEntries.push({ category, feed });
    }
  }
  if (variant === 'full') {
    const intelFeeds = await getIntelSources(lang);
    for (const feed of intelFeeds) {
      allEntries.push({ category: 'intel', feed });
    }
  }
```

**Step 3: Update the `ServerFeed` references** — replace with `DynamicFeed` (same shape: `name`, `url`, `lang`).

**Step 4: Typecheck**

```bash
npx tsc --noEmit -p tsconfig.api.json
```

**Commit:**

```bash
git add server/worldmonitor/news/v1/list-feed-digest.ts
git commit -m "feat: migrate list-feed-digest to dynamic news sources from Supabase"
```

---

## Task 25: Create Public Config API Endpoints

**Files:**
- Create: `api/config/feature-flags.ts`
- Create: `api/config/news-sources.ts`

These are **unauthenticated** endpoints for the main app to read config at runtime. Edge-cached with 5-minute TTL.

**`api/config/feature-flags.ts`:**

```typescript
import { getCorsHeaders } from '../_cors';
import { redis } from '../../server/_shared/redis';
import { createServiceClient } from '../../server/_shared/supabase';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  const headers = {
    ...getCorsHeaders(req),
    'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60',
  };

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'GET') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });

  const cacheKey = 'wm:config:flags:v1';

  // Redis cache
  try {
    const cached = await redis.get<Record<string, unknown>>(cacheKey);
    if (cached) return new Response(JSON.stringify(cached), { status: 200, headers });
  } catch { /* non-fatal */ }

  // Supabase
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ error: 'Configuration unavailable' }), { status: 503, headers });
  }

  try {
    const supabase = createServiceClient();
    const { data, error } = await supabase
      .schema('wm_admin')
      .from('feature_flags')
      .select('key, value, category');

    if (error) return new Response(JSON.stringify({ error: 'Failed to load flags' }), { status: 500, headers });

    const flags: Record<string, unknown> = {};
    for (const row of data ?? []) {
      flags[row.key] = row.value;
    }

    try { await redis.setex(cacheKey, 300, JSON.stringify(flags)); } catch { /* non-fatal */ }
    return new Response(JSON.stringify(flags), { status: 200, headers });
  } catch {
    return new Response(JSON.stringify({ error: 'Configuration unavailable' }), { status: 503, headers });
  }
}
```

**`api/config/news-sources.ts`:**

```typescript
import { getCorsHeaders } from '../_cors';
import { redis } from '../../server/_shared/redis';
import { createServiceClient } from '../../server/_shared/supabase';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  const headers = {
    ...getCorsHeaders(req),
    'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60',
  };

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'GET') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });

  const url = new URL(req.url);
  const variant = url.searchParams.get('variant') || 'full';
  const cacheKey = `wm:config:sources:v1:${variant}`;

  // Redis cache
  try {
    const cached = await redis.get(cacheKey);
    if (cached) return new Response(JSON.stringify(cached), { status: 200, headers });
  } catch { /* non-fatal */ }

  // Supabase
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ error: 'Configuration unavailable' }), { status: 503, headers });
  }

  try {
    const supabase = createServiceClient();
    const { data, error } = await supabase
      .schema('wm_admin')
      .from('news_sources')
      .select('name, url, tier, variants, category, source_type, lang, proxy_mode, propaganda_risk, state_affiliated, propaganda_note, default_enabled')
      .eq('enabled', true)
      .contains('variants', [variant])
      .order('tier', { ascending: true })
      .order('name', { ascending: true });

    if (error) return new Response(JSON.stringify({ error: 'Failed to load sources' }), { status: 500, headers });

    try { await redis.setex(cacheKey, 300, JSON.stringify(data)); } catch { /* non-fatal */ }
    return new Response(JSON.stringify(data), { status: 200, headers });
  } catch {
    return new Response(JSON.stringify({ error: 'Configuration unavailable' }), { status: 503, headers });
  }
}
```

**Commit:**

```bash
git add api/config/
git commit -m "feat: add public config endpoints for feature flags and news sources"
```

---

## Task 26: Create `src/services/feature-flag-client.ts`

**Files:**
- Create: `src/services/feature-flag-client.ts`
- Modify: `src/config/ml-config.ts` — strip to type exports only

**Step 1: Gut `ml-config.ts`** — keep only the types:

```typescript
// src/config/ml-config.ts
// Types only — runtime values come from /api/config/feature-flags

export interface ModelConfig {
  id: string;
  name: string;
  hfModel: string;
  size: number;
  priority: number;
  required: boolean;
  task: 'feature-extraction' | 'text-classification' | 'text2text-generation' | 'token-classification';
}

export interface MlFeatureFlags {
  semanticClustering: boolean;
  mlSentiment: boolean;
  summarization: boolean;
  mlNER: boolean;
  insightsPanel: boolean;
}

export interface MlThresholds {
  semanticClusterThreshold: number;
  minClustersForML: number;
  maxTextsPerBatch: number;
  modelLoadTimeoutMs: number;
  inferenceTimeoutMs: number;
  memoryBudgetMB: number;
}
```

**Step 2: Create `src/services/feature-flag-client.ts`:**

```typescript
// src/services/feature-flag-client.ts
import type { MlFeatureFlags, MlThresholds, ModelConfig } from '@/config/ml-config';

const FETCH_TIMEOUT_MS = 3_000;
let _flags: Record<string, unknown> | null = null;

export async function loadFeatureFlags(): Promise<void> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch('/api/config/feature-flags', { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      _flags = await res.json();
    }
  } catch { _flags = null; }
}

function flag<T>(key: string): T | undefined {
  if (!_flags) return undefined;
  const val = _flags[key];
  if (val === undefined) return undefined;
  return (typeof val === 'string' ? JSON.parse(val) : val) as T;
}

export function getMLFeatureFlags(): MlFeatureFlags {
  return {
    semanticClustering:  flag<boolean>('ml.semanticClustering')  ?? false,
    mlSentiment:         flag<boolean>('ml.mlSentiment')          ?? false,
    summarization:       flag<boolean>('ml.summarization')        ?? false,
    mlNER:               flag<boolean>('ml.mlNER')                ?? false,
    insightsPanel:       flag<boolean>('ml.insightsPanel')        ?? false,
  };
}

export function getMLThresholds(): MlThresholds {
  return {
    semanticClusterThreshold: flag<number>('ml.semanticClusterThreshold') ?? 0.75,
    minClustersForML:         flag<number>('ml.minClustersForML')          ?? 5,
    maxTextsPerBatch:         flag<number>('ml.maxTextsPerBatch')          ?? 20,
    modelLoadTimeoutMs:       flag<number>('ml.modelLoadTimeoutMs')        ?? 600_000,
    inferenceTimeoutMs:       flag<number>('ml.inferenceTimeoutMs')        ?? 120_000,
    memoryBudgetMB:           flag<number>('ml.memoryBudgetMB')            ?? 200,
  };
}

export function isFeatureEnabled(key: string): boolean {
  return flag<boolean>(key) ?? false;
}

export function areFlagsLoaded(): boolean {
  return _flags !== null;
}
```

> **Note on the `?? defaults`:** These are NOT hardcoded fallbacks — they are safe-off values used only when the fetch fails entirely. `false` means disabled, numeric defaults are the minimum safe values. The database is still the source of truth.

**Commit:**

```bash
git add src/config/ml-config.ts src/services/feature-flag-client.ts
git commit -m "feat: add feature flag client service — fetches from API, no static config"
```

---

## Task 27: Migrate ML Consumers to Dynamic Feature Flags

**Files:**
- Modify: `src/workers/ml.worker.ts`
- Modify: `src/services/ml-worker.ts`
- Modify: `src/services/ml-capabilities.ts`
- Modify: `src/services/clustering.ts`

In each file, replace:

```typescript
import { ML_FEATURE_FLAGS, ML_THRESHOLDS, MODEL_CONFIGS } from '@/config/ml-config';
```

With:

```typescript
import { getMLFeatureFlags, getMLThresholds } from '@/services/feature-flag-client';
import type { ModelConfig } from '@/config/ml-config';
```

Then replace static constant references with function calls:
- `ML_FEATURE_FLAGS.semanticClustering` → `getMLFeatureFlags().semanticClustering`
- `ML_THRESHOLDS.maxTextsPerBatch` → `getMLThresholds().maxTextsPerBatch`

For `MODEL_CONFIGS`: add to the feature flags table as `ml.modelConfigs` (JSONB array) and fetch via `flag<ModelConfig[]>('ml.modelConfigs')`.

**Note on ML worker:** The worker runs in a separate thread. It needs to receive flags via `postMessage` from the main thread. Update the worker initialization to pass current flags when starting the worker, and re-send when flags change.

**Commit:**

```bash
git add src/workers/ src/services/
git commit -m "feat: migrate ML consumers from static ml-config to dynamic feature flags"
```

---

## Task 28: Create `src/services/feed-client.ts` and Migrate Client Code

**Files:**
- Create: `src/services/feed-client.ts`
- Modify: `src/components/UnifiedSettings.ts`, `src/services/correlation.ts`, `src/services/breaking-news-alerts.ts`, `src/services/analysis-worker.ts`, `src/components/NewsPanel.ts`, `src/components/CountryDeepDivePanel.ts`, `src/components/BreakingNewsBanner.ts`, `src/App.ts`

**Step 1: Create `src/services/feed-client.ts`:**

```typescript
// src/services/feed-client.ts
import type { Feed } from '@/types';
import { SITE_VARIANT } from '@/config/variant';

export type SourceType = 'wire' | 'gov' | 'intel' | 'mainstream' | 'market' | 'tech' | 'other';
export type PropagandaRisk = 'low' | 'medium' | 'high';
export interface SourceRiskProfile {
  risk: PropagandaRisk;
  stateAffiliated?: string;
  note?: string;
}

interface NewsSourceRow {
  name: string;
  url: string | Record<string, string>;
  tier: number;
  variants: string[];
  category: string;
  source_type: string | null;
  lang: string;
  proxy_mode: string;
  propaganda_risk: PropagandaRisk;
  state_affiliated: string | null;
  propaganda_note: string | null;
  default_enabled: boolean;
}

const FETCH_TIMEOUT_MS = 5_000;
let _sources: NewsSourceRow[] | null = null;
let _feeds: Record<string, Feed[]> | null = null;
let _intelSources: Feed[] | null = null;

export async function loadNewsSources(): Promise<void> {
  try {
    const variant = SITE_VARIANT || 'full';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(`/api/config/news-sources?variant=${variant}`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return;
    _sources = await res.json();

    // Build grouped feeds
    _feeds = {};
    _intelSources = [];
    for (const src of _sources!) {
      const url = typeof src.url === 'string'
        ? `/api/rss-proxy?url=${encodeURIComponent(src.url)}`
        : src.url;
      const feed: Feed = { name: src.name, url };
      if (src.category === 'intel') {
        _intelSources.push(feed);
      } else {
        (_feeds[src.category] ??= []).push(feed);
      }
    }
  } catch { /* fetch failed — features degrade */ }
}

export function getFeeds(): Record<string, Feed[]> {
  return _feeds ?? {};
}

export function getIntelSources(): Feed[] {
  return _intelSources ?? [];
}

export function getSourceTier(sourceName: string): number {
  return _sources?.find(s => s.name === sourceName)?.tier ?? 3;
}

export function getSourceType(sourceName: string): SourceType {
  const st = _sources?.find(s => s.name === sourceName)?.source_type;
  return (st as SourceType) ?? 'other';
}

export function getSourcePropagandaRisk(sourceName: string): SourceRiskProfile {
  const src = _sources?.find(s => s.name === sourceName);
  if (!src) return { risk: 'low' };
  return {
    risk: src.propaganda_risk,
    stateAffiliated: src.state_affiliated ?? undefined,
    note: src.propaganda_note ?? undefined,
  };
}

export function isStateAffiliatedSource(sourceName: string): boolean {
  return !!_sources?.find(s => s.name === sourceName)?.state_affiliated;
}

export function getSourcePanelId(sourceName: string): string {
  return _sources?.find(s => s.name === sourceName)?.category ?? 'other';
}

export function computeDefaultDisabledSources(locale?: string): string[] {
  if (!_sources) return [];
  const enabled = new Set(_sources.filter(s => s.default_enabled).map(s => s.name));
  if (locale) {
    const lang = (locale.split('-')[0] ?? 'en').toLowerCase();
    if (lang !== 'en') {
      for (const s of _sources) {
        if (s.lang === lang || (typeof s.url === 'object' && lang in s.url)) {
          enabled.add(s.name);
        }
      }
    }
  }
  return _sources.filter(s => !enabled.has(s.name)).map(s => s.name);
}

export function getTotalFeedCount(): number {
  if (!_feeds) return 0;
  let count = 0;
  for (const feeds of Object.values(_feeds)) count += feeds.length;
  count += (_intelSources?.length ?? 0);
  return count;
}

export function areFeedsLoaded(): boolean {
  return _sources !== null;
}
```

**Step 2: Update imports** in all 8 consumer files:

Replace `import { ... } from '@/config/feeds'` with `import { ... } from '@/services/feed-client'`.

The function signatures are identical, so no other changes needed.

**Step 3: Call `loadNewsSources()` early in app initialization** (in `src/App.ts` or main entry):

```typescript
import { loadNewsSources } from '@/services/feed-client';
await loadNewsSources();
```

**Commit:**

```bash
git add src/services/feed-client.ts src/components/ src/services/ src/App.ts
git commit -m "feat: migrate client from static feeds.ts to dynamic feed-client service"
```

---

## Task 29: Add Prompt Versioning UI

**Files:**
- Modify: `src/admin/pages/llm-config.ts`

Add a "History" button next to each prompt row. Clicking it opens a panel showing past versions from `wm_admin.llm_prompt_history` (fetched via a new admin API sub-route or query param).

Each history entry shows: date, changed_by email, truncated system_prompt preview, and a "Revert" button that copies the old version into the edit form.

**API addition** — in `api/admin/llm-prompts.ts`, support `GET ?id=UUID&history=true` to return history rows for a specific prompt.

**Commit:**

```bash
git add src/admin/pages/llm-config.ts api/admin/llm-prompts.ts
git commit -m "feat: add prompt versioning UI with history and revert"
```

---

## Task 30: Add Config Export Endpoint and Admin UI

**Files:**
- Create: `api/admin/export.ts`
- Modify: `src/admin/dashboard.ts`

**`api/admin/export.ts`:**

```typescript
import { requireAdmin, errorResponse } from './_auth';
import { adminCorsHeaders } from './_auth';
import { createServiceClient } from '../../server/_shared/supabase';

export default async function handler(req: Request): Promise<Response> {
  const headers = adminCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  try { await requireAdmin(req); } catch (err) { return errorResponse(err); }

  const supabase = createServiceClient();

  const [flags, sources, providers, prompts, appKeys] = await Promise.all([
    supabase.schema('wm_admin').from('feature_flags').select('*'),
    supabase.schema('wm_admin').from('news_sources').select('*'),
    supabase.schema('wm_admin').from('llm_providers').select('*'),
    supabase.schema('wm_admin').from('llm_prompts').select('*'),
    supabase.schema('wm_admin').from('app_keys').select('id, description, enabled, created_at, revoked_at'),
  ]);

  // Vault secret names only — never values
  const { data: secretNames } = await supabase.rpc('list_vault_secret_names', {}, { schema: 'wm_admin' });

  const exportData = {
    exported_at: new Date().toISOString(),
    feature_flags: flags.data,
    news_sources: sources.data,
    llm_providers: providers.data,
    llm_prompts: prompts.data,
    app_keys: appKeys.data,
    vault_secret_names: secretNames,
  };

  return new Response(JSON.stringify(exportData, null, 2), {
    status: 200,
    headers: {
      ...headers,
      'Content-Disposition': `attachment; filename="worldmonitor-config-${new Date().toISOString().split('T')[0]}.json"`,
    },
  });
}
```

**Dashboard addition** — add an "Export Configuration" button in the sidebar footer:

```typescript
const exportBtn = document.createElement('button');
exportBtn.textContent = t('modals.admin.export');
exportBtn.addEventListener('click', async () => {
  const res = await fetch('/api/admin/export', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return;
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `worldmonitor-config-${new Date().toISOString().split('T')[0]}.json`;
  a.click();
});
```

**Commit:**

```bash
git add api/admin/export.ts src/admin/dashboard.ts
git commit -m "feat: add config export endpoint and download button in admin dashboard"
```

---

## Task 31: Create `src/styles/admin.css`

**Files:**
- Create: `src/styles/admin.css`
- Modify: `admin.html`

Create `src/styles/admin.css` following `settings-window.css` conventions:
- Root variables: `--admin-bg`, `--admin-surface`, `--admin-border`, `--admin-text`, `--admin-accent`, etc. inheriting from existing theme variables
- Layout: `.admin-shell`, `.admin-sidebar`, `.admin-content`, `.admin-section-header`
- Components: `.admin-table`, `.admin-form`, `.admin-btn`, `.admin-badge`, `.admin-toggle`
- Responsive breakpoint at 860px

Update `admin.html`:
- Remove inline `<style>` block
- Add `<link rel="stylesheet" href="/src/styles/admin.css" />`

**Commit:**

```bash
git add src/styles/admin.css admin.html
git commit -m "feat: add external admin.css — matches settings-window.css patterns"
```

---

## Task 32: Add i18n Keys for Admin Portal

**Files:**
- Modify: locale JSON files (e.g. `src/locales/en.json` or equivalent)

Add keys under `modals.admin`:

```json
{
  "modals": {
    "admin": {
      "title": "Admin Portal",
      "signOut": "Sign Out",
      "export": "Export Configuration",
      "secrets": {
        "title": "API Keys & Secrets",
        "addNew": "Add Secret",
        "name": "Secret Name",
        "value": "Secret Value",
        "description": "Description",
        "delete": "Delete",
        "confirmDelete": "Are you sure you want to delete this secret?"
      },
      "flags": {
        "title": "Feature Flags",
        "saved": "Flag updated"
      },
      "news": {
        "title": "News Sources",
        "addNew": "Add Source",
        "search": "Search sources...",
        "bulkImport": "Bulk Import",
        "name": "Source Name",
        "tier": "Tier",
        "variants": "Variants",
        "enabled": "Enabled"
      },
      "llm": {
        "title": "LLM Config & Prompts",
        "providers": "Providers",
        "prompts": "Prompts",
        "history": "History",
        "revert": "Revert to this version",
        "placeholders": "Available placeholders"
      },
      "appKeys": {
        "title": "App Access Keys",
        "generate": "Generate New Key",
        "revoke": "Revoke",
        "warning": "Each key is shown once — copy and store it immediately",
        "description": "Description"
      },
      "login": {
        "email": "Email",
        "password": "Password",
        "signIn": "Sign In",
        "signingIn": "Signing in…",
        "error": "Invalid email or password.",
        "required": "Email and password required.",
        "denied": "Access Denied",
        "notAdmin": "This account does not have admin access."
      }
    }
  }
}
```

**Commit:**

```bash
git add src/locales/
git commit -m "feat: add i18n keys for admin portal"
```

---

## Task 33: Archive Old Static Config Files

**Files:**
- Modify: `src/config/feeds.ts` — remove hardcoded data, keep only type re-exports from `feed-client.ts`
- Modify: `server/worldmonitor/news/v1/_feeds.ts` — delete or move to `_feeds.ts.archived`
- Modify: `src/config/ml-config.ts` — already gutted in Task 26

**Step 1: `src/config/feeds.ts`** — replace with thin re-export:

```typescript
// src/config/feeds.ts — DEPRECATED: all data now comes from Supabase via feed-client.ts
// This file re-exports the feed-client API for backward compatibility during transition.
export {
  getFeeds as FEEDS_GETTER,
  getIntelSources,
  getSourceTier,
  getSourceType,
  getSourcePropagandaRisk,
  isStateAffiliatedSource,
  getSourcePanelId,
  computeDefaultDisabledSources,
  getTotalFeedCount,
  type SourceType,
  type PropagandaRisk,
  type SourceRiskProfile,
} from '@/services/feed-client';
```

**Step 2: Remove `_feeds.ts`:**

```bash
git rm server/worldmonitor/news/v1/_feeds.ts
```

**Commit:**

```bash
git add src/config/feeds.ts
git commit -m "chore: archive static config files — all config now served from Supabase"
```

---

## Task 34: Final Integration Test

Same as original Task 22, but expanded:

**Step 1: Full typecheck**

```bash
npx tsc --noEmit && npx tsc --noEmit -p tsconfig.api.json
```

**Step 2: Run unit tests**

```bash
npx tsx --test tests/*.test.mts
```

**Step 3: Run smoke tests**

```bash
npx playwright test e2e/admin-portal.spec.ts
```

**Step 4: Build**

```bash
npm run build
```

**Step 5: Verify all admin pages render** — manual smoke test of each page in the admin portal.

**Step 6: Final commit**

```bash
git add .
git commit -m "chore: final integration verification — all config from Supabase, no hardcoded fallbacks"
```

---

## Updated Deployment Notes

1. **Apply migration SQL** to Supabase project `fmultmlsevqgtnqzaylg` (Task 4 — now includes audit_log, prompt_history)
2. **Create the first admin user** in Supabase Auth (Task 5)
3. **Set Vercel env vars**: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
4. **Run news sources seed** once: `npx tsx scripts/seed-news-sources.mts`
5. **Seed feature flags** are applied automatically via migration SQL
6. **Migrate API keys to Vault** via admin portal
7. **Verify public config endpoints** return data: `GET /api/config/feature-flags`, `GET /api/config/news-sources?variant=full`
8. **Monitor audit log** after first admin session: `SELECT * FROM wm_admin.audit_log ORDER BY created_at DESC LIMIT 20;`
