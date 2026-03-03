# Admin Portal Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a password-protected admin portal that manages API keys (via Supabase Vault), news feeds, LLM config/prompts, and feature flags — replacing hard-coded env vars and TypeScript config files with database-driven configuration.

**Architecture:** A new `admin.html` entry page (matching the existing `settings.html` pattern) backed by Vercel serverless API routes at `/api/admin/*` that validate Supabase JWTs. All secrets live in Supabase Vault (project `fmultmlsevqgtnqzaylg`); server handlers are updated to call a new `getSecret()` helper that reads from Vault (Redis-cached) with a fallback to `process.env`.

**Tech Stack:** Supabase (Auth + Vault + Postgres `wm_admin` schema), Vite (vanilla TypeScript, no React — matching existing `settings-window.ts` pattern), Vercel serverless functions, Upstash Redis (caching vault reads), `@supabase/supabase-js` v2.

---

## Pre-flight Checklist (Read Before Starting)

- Supabase project ID: `fmultmlsevqgtnqzaylg`
- Vault is enabled on all Supabase projects by default (uses `pgsodium`)
- Existing HTML multi-page pattern: `settings.html` → `src/settings-main.ts` → `src/settings-window.ts`
- All Vercel API routes live in `/api/` and can be TypeScript (`.ts`) or JavaScript (`.js`)
- Redis client: `server/_shared/redis.ts` already exports `cachedFetchJson` and a `redis` client
- The project uses `@supabase/supabase-js` — it may need to be added as a dependency

---

## Task 1: Create the Feature Branch

**Files:** None (git only)

**Step 1: Create and switch to the branch**

```bash
git checkout -b feature/admin-portal
```

**Step 2: Verify you are on the right branch**

```bash
git branch --show-current
```

Expected output: `feature/admin-portal`

**Step 3: Commit**

```bash
git commit --allow-empty -m "chore: start feature/admin-portal branch"
```

---

## Task 2: Add Supabase JS Dependency

**Files:**
- Modify: `package.json` (via npm)

**Step 1: Install the Supabase client**

```bash
npm install @supabase/supabase-js
```

**Step 2: Verify install**

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
- Create: Update your local `.env` with real values

**Step 1: Add to `.env.example`** (after the `# ------ Registration DB (Convex) ------` block)

```
# ------ Admin Portal (Supabase) ------

# Supabase project URL — find it at: https://supabase.com/dashboard/project/fmultmlsevqgtnqzaylg/settings/api
SUPABASE_URL=https://fmultmlsevqgtnqzaylg.supabase.co

# Supabase anon key (public, safe in browser for auth flows)
SUPABASE_ANON_KEY=

# Supabase service role key (SECRET — server only, never expose in browser)
SUPABASE_SERVICE_ROLE_KEY=

# Client-side Supabase config (exposed to browser for admin portal auth)
VITE_SUPABASE_URL=https://fmultmlsevqgtnqzaylg.supabase.co
VITE_SUPABASE_ANON_KEY=
```

**Step 2: Add to local `.env` with real values from Supabase dashboard**

Navigate to: https://supabase.com/dashboard/project/fmultmlsevqgtnqzaylg/settings/api

Copy:
- `Project URL` → `SUPABASE_URL` and `VITE_SUPABASE_URL`
- `anon public` key → `SUPABASE_ANON_KEY` and `VITE_SUPABASE_ANON_KEY`
- `service_role` key → `SUPABASE_SERVICE_ROLE_KEY`

**Step 3: Add to `server/env.d.ts`** — append at end of the interface:

```typescript
SUPABASE_URL: string;
SUPABASE_ANON_KEY: string;
SUPABASE_SERVICE_ROLE_KEY: string;
```

**Step 4: Add to `src/types/process-env.d.ts` or `vite-env.d.ts`** for VITE_ prefixed vars:

```typescript
interface ImportMetaEnv {
  // ... existing ...
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
}
```

**Step 5: Commit**

```bash
git add .env.example server/env.d.ts
git commit -m "chore: add Supabase env var declarations for admin portal"
```

---

## Task 4: Create the Supabase Database Schema (Migration)

**Files:**
- Create: `supabase/migrations/20260303000001_admin_schema.sql`

**Step 1: Create the migrations directory**

```bash
mkdir -p supabase/migrations
```

**Step 2: Create the migration file**

```sql
-- supabase/migrations/20260303000001_admin_schema.sql
-- Admin portal schema: feature flags, news sources, LLM config/prompts

-- ============================================================
-- Schema
-- ============================================================
CREATE SCHEMA IF NOT EXISTS wm_admin;

-- ============================================================
-- 1. Feature Flags
-- Stores ML feature flags, variant config, beta flags.
-- key: camelCase identifier (e.g. 'semanticClustering')
-- value: JSONB so we can store bool, number, string, or object
-- ============================================================
CREATE TABLE wm_admin.feature_flags (
  key         TEXT PRIMARY KEY,
  value       JSONB    NOT NULL,
  description TEXT,
  category    TEXT     NOT NULL DEFAULT 'general',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  UUID REFERENCES auth.users(id)
);

-- Seed with current hard-coded defaults from src/config/ml-config.ts
INSERT INTO wm_admin.feature_flags (key, value, description, category) VALUES
  ('ml.semanticClustering',  'true',  'Enable semantic news clustering via ONNX embeddings',     'ml'),
  ('ml.mlSentiment',         'true',  'Enable ML-based sentiment analysis',                       'ml'),
  ('ml.summarization',       'true',  'Enable local ONNX summarization',                         'ml'),
  ('ml.mlNER',               'true',  'Enable named entity recognition',                         'ml'),
  ('ml.insightsPanel',       'true',  'Show ML insights panel in UI',                            'ml'),
  ('ml.semanticClusterThreshold', '0.75', 'Cosine similarity threshold for clustering',          'ml'),
  ('ml.minClustersForML',    '5',     'Minimum cluster count before enabling ML features',        'ml'),
  ('ml.maxTextsPerBatch',    '20',    'Max headlines per ML inference batch',                    'ml'),
  ('ml.modelLoadTimeoutMs',  '600000','Model load timeout in milliseconds',                      'ml'),
  ('ml.inferenceTimeoutMs',  '120000','Single inference timeout in milliseconds',                'ml'),
  ('ml.memoryBudgetMB',      '200',   'Memory budget for loaded ONNX models',                   'ml'),
  ('site.betaMode',          'false', 'Enable beta features for all users',                      'site'),
  ('site.defaultVariant',    '"full"','Default site variant (full|tech|finance|happy)',           'site');

-- ============================================================
-- 2. News Sources
-- Replaces hard-coded feed list in src/config/feeds.ts.
-- url: the RSS feed URL (before proxy wrapping)
-- proxy_mode: 'rss' (Vercel rss-proxy) or 'railway' (relay)
-- ============================================================
CREATE TABLE wm_admin.news_sources (
  id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT    NOT NULL,
  url         TEXT    NOT NULL,
  tier        INTEGER NOT NULL DEFAULT 3 CHECK (tier BETWEEN 1 AND 4),
  variants    TEXT[]  NOT NULL DEFAULT '{full}',
  category    TEXT    NOT NULL DEFAULT 'general',
  language    TEXT    NOT NULL DEFAULT 'en',
  proxy_mode  TEXT    NOT NULL DEFAULT 'rss' CHECK (proxy_mode IN ('rss', 'railway', 'direct')),
  enabled     BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  UUID REFERENCES auth.users(id)
);

CREATE INDEX idx_news_sources_variant ON wm_admin.news_sources USING GIN (variants);
CREATE INDEX idx_news_sources_enabled  ON wm_admin.news_sources (enabled);

-- ============================================================
-- 3. LLM Providers
-- Groq (primary) + OpenRouter (fallback) — extensible to others.
-- priority: lower number = higher priority
-- ============================================================
CREATE TABLE wm_admin.llm_providers (
  id            UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT    NOT NULL UNIQUE,
  api_url       TEXT    NOT NULL,
  default_model TEXT    NOT NULL,
  priority      INTEGER NOT NULL DEFAULT 1,
  enabled       BOOLEAN NOT NULL DEFAULT true,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    UUID REFERENCES auth.users(id)
);

INSERT INTO wm_admin.llm_providers (name, api_url, default_model, priority) VALUES
  ('groq',       'https://api.groq.com/openai/v1/chat/completions', 'llama-3.1-8b-instant', 1),
  ('openrouter', 'https://openrouter.ai/api/v1/chat/completions',   'openai/gpt-4o-mini',   2);

-- ============================================================
-- 4. LLM Prompts
-- System + user prompts per (prompt_key, variant, mode).
-- prompt_key: 'intel_brief' | 'news_summary' | 'classify_event' | 'deduct_situation'
-- variant: NULL = applies to all variants, or 'tech'|'full'|'finance'|'happy'
-- mode: NULL = applies to all modes, or 'brief'|'analysis'|'translate'
-- ============================================================
CREATE TABLE wm_admin.llm_prompts (
  id            UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_key    TEXT    NOT NULL,
  variant       TEXT,
  mode          TEXT,
  system_prompt TEXT    NOT NULL,
  user_prompt   TEXT,
  description   TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    UUID REFERENCES auth.users(id),
  UNIQUE (prompt_key, variant, mode)
);

-- Seed intel_brief prompt (from server/worldmonitor/intelligence/v1/get-country-intel-brief.ts)
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
   'Country intelligence brief system prompt. Use {date} placeholder for current date.');

-- Seed news_summary prompts (from server/worldmonitor/news/v1/_shared.ts)
INSERT INTO wm_admin.llm_prompts (prompt_key, variant, mode, system_prompt, user_prompt, description) VALUES
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
   'Tech variant brief mode summary prompt. Placeholders: {dateContext}, {langInstruction}, {headlineText}, {intelSection}'),

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
   'Default (non-tech) brief mode summary prompt. Placeholders: {dateContext}, {langInstruction}, {headlineText}, {intelSection}'),

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
   'Tech variant analysis mode prompt. Placeholders: {dateContext}, {headlineText}, {intelSection}'),

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
   'Default (non-tech) analysis mode prompt. Placeholders: {dateContext}, {headlineText}, {intelSection}');

-- ============================================================
-- 5. Admin Users table (which Supabase Auth users are admins)
-- ============================================================
CREATE TABLE wm_admin.admin_users (
  user_id     UUID    PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role        TEXT    NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'superadmin')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  UUID REFERENCES auth.users(id)
);

-- ============================================================
-- 6. RLS Policies
-- Admin tables are only accessible via service role (server-side)
-- OR by authenticated users listed in admin_users.
-- ============================================================
ALTER TABLE wm_admin.feature_flags  ENABLE ROW LEVEL SECURITY;
ALTER TABLE wm_admin.news_sources   ENABLE ROW LEVEL SECURITY;
ALTER TABLE wm_admin.llm_providers  ENABLE ROW LEVEL SECURITY;
ALTER TABLE wm_admin.llm_prompts    ENABLE ROW LEVEL SECURITY;
ALTER TABLE wm_admin.admin_users    ENABLE ROW LEVEL SECURITY;

-- Helper function: is the current user an admin?
CREATE OR REPLACE FUNCTION wm_admin.is_admin()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM wm_admin.admin_users
    WHERE user_id = auth.uid()
  );
$$;

-- Feature flags: admins can read/write; public cannot
CREATE POLICY "admins_read_feature_flags"
  ON wm_admin.feature_flags FOR SELECT
  USING (wm_admin.is_admin());

CREATE POLICY "admins_write_feature_flags"
  ON wm_admin.feature_flags FOR ALL
  USING (wm_admin.is_admin());

-- Repeat for each table
CREATE POLICY "admins_all_news_sources"
  ON wm_admin.news_sources FOR ALL
  USING (wm_admin.is_admin());

CREATE POLICY "admins_all_llm_providers"
  ON wm_admin.llm_providers FOR ALL
  USING (wm_admin.is_admin());

CREATE POLICY "admins_all_llm_prompts"
  ON wm_admin.llm_prompts FOR ALL
  USING (wm_admin.is_admin());

CREATE POLICY "admins_read_admin_users"
  ON wm_admin.admin_users FOR SELECT
  USING (wm_admin.is_admin());

CREATE POLICY "superadmins_write_admin_users"
  ON wm_admin.admin_users FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM wm_admin.admin_users
      WHERE user_id = auth.uid() AND role = 'superadmin'
    )
  );

-- ============================================================
-- 7. RPC: get_vault_secret (server-side only, service role)
-- Called from Vercel functions using service_role key.
-- Returns NULL if secret not found (handler falls back to env).
-- ============================================================
CREATE OR REPLACE FUNCTION wm_admin.get_vault_secret(secret_name TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_secret TEXT;
BEGIN
  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets
  WHERE name = secret_name
  LIMIT 1;

  RETURN v_secret;
END;
$$;

-- Revoke public access — only service role can call this
REVOKE ALL ON FUNCTION wm_admin.get_vault_secret(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION wm_admin.get_vault_secret(TEXT) FROM anon;
REVOKE ALL ON FUNCTION wm_admin.get_vault_secret(TEXT) FROM authenticated;

-- ============================================================
-- 8. RPC: upsert_vault_secret (server-side admin only)
-- ============================================================
CREATE OR REPLACE FUNCTION wm_admin.upsert_vault_secret(
  p_name        TEXT,
  p_secret      TEXT,
  p_description TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_existing_id UUID;
BEGIN
  SELECT id INTO v_existing_id
  FROM vault.secrets
  WHERE name = p_name
  LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    PERFORM vault.update_secret(v_existing_id, p_secret, p_name, p_description);
  ELSE
    PERFORM vault.create_secret(p_secret, p_name, p_description);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION wm_admin.upsert_vault_secret(TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION wm_admin.upsert_vault_secret(TEXT, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION wm_admin.upsert_vault_secret(TEXT, TEXT, TEXT) FROM authenticated;

-- ============================================================
-- 9. RPC: list_vault_secret_names (names only, not values)
-- ============================================================
CREATE OR REPLACE FUNCTION wm_admin.list_vault_secret_names()
RETURNS TABLE(name TEXT, description TEXT, updated_at TIMESTAMPTZ)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT name, description, updated_at
  FROM vault.secrets
  ORDER BY name;
$$;

REVOKE ALL ON FUNCTION wm_admin.list_vault_secret_names() FROM PUBLIC;
REVOKE ALL ON FUNCTION wm_admin.list_vault_secret_names() FROM anon;
REVOKE ALL ON FUNCTION wm_admin.list_vault_secret_names() FROM authenticated;

-- ============================================================
-- 10. RPC: delete_vault_secret
-- ============================================================
CREATE OR REPLACE FUNCTION wm_admin.delete_vault_secret(p_name TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_id UUID;
BEGIN
  SELECT id INTO v_id FROM vault.secrets WHERE name = p_name LIMIT 1;
  IF v_id IS NOT NULL THEN
    DELETE FROM vault.secrets WHERE id = v_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION wm_admin.delete_vault_secret(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION wm_admin.delete_vault_secret(TEXT) FROM anon;
REVOKE ALL ON FUNCTION wm_admin.delete_vault_secret(TEXT) FROM authenticated;

-- ============================================================
-- 11. Timestamp triggers
-- ============================================================
CREATE OR REPLACE FUNCTION wm_admin.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_news_sources_updated_at
  BEFORE UPDATE ON wm_admin.news_sources
  FOR EACH ROW EXECUTE FUNCTION wm_admin.set_updated_at();

CREATE TRIGGER trg_llm_providers_updated_at
  BEFORE UPDATE ON wm_admin.llm_providers
  FOR EACH ROW EXECUTE FUNCTION wm_admin.set_updated_at();

CREATE TRIGGER trg_llm_prompts_updated_at
  BEFORE UPDATE ON wm_admin.llm_prompts
  FOR EACH ROW EXECUTE FUNCTION wm_admin.set_updated_at();

CREATE TRIGGER trg_feature_flags_updated_at
  BEFORE UPDATE ON wm_admin.feature_flags
  FOR EACH ROW EXECUTE FUNCTION wm_admin.set_updated_at();
```

**Step 3: Run the migration against Supabase**

Option A — Supabase CLI (preferred if installed):

```bash
npx supabase db push --db-url "postgresql://postgres:[password]@db.fmultmlsevqgtnqzaylg.supabase.co:5432/postgres"
```

Option B — Paste directly in Supabase SQL Editor:
- Open: https://supabase.com/dashboard/project/fmultmlsevqgtnqzaylg/sql/new
- Paste the SQL file contents and run.

**Step 4: Verify tables exist**

```sql
SELECT table_name FROM information_schema.tables WHERE table_schema = 'wm_admin';
```

Expected: `feature_flags`, `news_sources`, `llm_providers`, `llm_prompts`, `admin_users`

**Step 5: Commit**

```bash
git add supabase/
git commit -m "feat: add wm_admin schema with feature flags, news sources, LLM config, vault RPCs"
```

---

## Task 5: Create the First Admin User in Supabase

**Step 1: Create an admin user via Supabase Auth**

In the Supabase dashboard:
1. Go to https://supabase.com/dashboard/project/fmultmlsevqgtnqzaylg/auth/users
2. Click "Add user" → create with your email/password
3. Copy the user's UUID

**Step 2: Insert into admin_users table**

```sql
-- Replace with actual UUID from step 1
INSERT INTO wm_admin.admin_users (user_id, role)
VALUES ('YOUR-USER-UUID-HERE', 'superadmin');
```

Run this in the Supabase SQL Editor.

---

## Task 6: Create the Supabase Server Client Helper

**Files:**
- Create: `server/_shared/supabase.ts`

**Step 1: Write the failing test** — Create `tests/supabase-client.test.mts`:

```typescript
import { strict as assert } from 'assert';
import { test } from 'node:test';

test('createServiceClient returns object with rpc method', async () => {
  // This is a smoke test — we only verify the client is constructed
  // without throwing when env vars are present.
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';

  const { createServiceClient } = await import('../server/_shared/supabase.js');
  const client = createServiceClient();
  assert.ok(typeof client.rpc === 'function', 'client.rpc must be a function');
});
```

**Step 2: Run test to see it fail**

```bash
npx tsx --test tests/supabase-client.test.mts
```

Expected: FAIL — `Cannot find module '../server/_shared/supabase.js'`

**Step 3: Create the Supabase client helper**

```typescript
// server/_shared/supabase.ts
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Creates a Supabase client using the service role key.
 * This client bypasses RLS and must ONLY be used in server-side Vercel functions.
 * NEVER expose this client or the service role key to the browser.
 */
export function createServiceClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set for admin operations',
    );
  }

  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

/**
 * Creates a Supabase client using the anon key and a user's JWT.
 * Used in admin API routes to verify the caller is an authenticated admin.
 */
export function createUserClient(jwt: string): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be set');
  }

  return createClient(url, key, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
```

**Step 4: Run test again**

```bash
npx tsx --test tests/supabase-client.test.mts
```

Expected: PASS

**Step 5: Commit**

```bash
git add server/_shared/supabase.ts tests/supabase-client.test.mts
git commit -m "feat: add Supabase service/user client helpers for admin portal"
```

---

## Task 7: Create the `getSecret()` Vault Helper

This replaces `process.env.GROQ_API_KEY` etc. with a Vault lookup (Redis-cached, env fallback).

**Files:**
- Create: `server/_shared/secrets.ts`
- Create: `tests/secrets.test.mts`

**Step 1: Write the failing test**

```typescript
// tests/secrets.test.mts
import { strict as assert } from 'assert';
import { test, mock } from 'node:test';

test('getSecret: returns env var when SUPABASE_URL not set', async () => {
  delete process.env.SUPABASE_URL;
  process.env.GROQ_API_KEY = 'env-groq-key';

  const { getSecret } = await import('../server/_shared/secrets.js');
  const result = await getSecret('GROQ_API_KEY');
  assert.strictEqual(result, 'env-groq-key');
});

test('getSecret: returns undefined when key missing in env and no Supabase', async () => {
  delete process.env.SUPABASE_URL;
  delete process.env.MISSING_KEY;

  const { getSecret } = await import('../server/_shared/secrets.js');
  const result = await getSecret('MISSING_KEY');
  assert.strictEqual(result, undefined);
});
```

**Step 2: Run test to see it fail**

```bash
npx tsx --test tests/secrets.test.mts
```

Expected: FAIL — `Cannot find module '../server/_shared/secrets.js'`

**Step 3: Implement `getSecret()`**

```typescript
// server/_shared/secrets.ts
/**
 * Secret resolution with layered fallback:
 * 1. Upstash Redis cache (15-minute TTL — avoids Supabase roundtrip per request)
 * 2. Supabase Vault (wm_admin.get_vault_secret RPC)
 * 3. process.env fallback (existing env var deployment continues to work)
 *
 * This means operators can add/rotate API keys in the admin portal without
 * redeploying Vercel. Old env vars keep working as fallback.
 */

import { redis } from './redis';
import { createServiceClient } from './supabase';

const CACHE_TTL_SECONDS = 900; // 15 minutes

function vaultCacheKey(secretName: string): string {
  return `wm:vault:v1:${secretName}`;
}

/**
 * Resolve a secret by name.
 * Returns the string value or undefined if not found anywhere.
 */
export async function getSecret(secretName: string): Promise<string | undefined> {
  // If Supabase is not configured, fall straight through to env
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return process.env[secretName] ?? undefined;
  }

  // 1. Check Redis cache
  try {
    const cached = await redis.get<string>(vaultCacheKey(secretName));
    if (cached !== null && cached !== undefined) {
      return cached;
    }
  } catch {
    // Redis unavailable — continue to Vault
  }

  // 2. Query Supabase Vault
  try {
    const supabase = createServiceClient();
    const { data, error } = await supabase.rpc('get_vault_secret', {
      secret_name: secretName,
    }, { schema: 'wm_admin' });

    if (!error && data) {
      // Cache the result
      try {
        await redis.setex(vaultCacheKey(secretName), CACHE_TTL_SECONDS, data);
      } catch {
        // Cache write failure is non-fatal
      }
      return data as string;
    }
  } catch {
    // Vault unavailable — fall through to env
  }

  // 3. Env var fallback
  return process.env[secretName] ?? undefined;
}

/**
 * Invalidate a secret's cache entry (call after updating via admin portal).
 */
export async function invalidateSecretCache(secretName: string): Promise<void> {
  try {
    await redis.del(vaultCacheKey(secretName));
  } catch {
    // Non-fatal
  }
}
```

**Step 4: Run tests**

```bash
npx tsx --test tests/secrets.test.mts
```

Expected: PASS

**Step 5: Commit**

```bash
git add server/_shared/secrets.ts tests/secrets.test.mts
git commit -m "feat: add getSecret() vault helper with Redis cache and env fallback"
```

---

## Task 8: Migrate Server Handlers to Use `getSecret()`

Replace `process.env.GROQ_API_KEY` etc. in server handlers with `await getSecret()`.

**Files to modify:**
- `server/worldmonitor/intelligence/v1/get-country-intel-brief.ts`
- `server/worldmonitor/intelligence/v1/get-risk-scores.ts`
- `server/worldmonitor/intelligence/v1/deduct-situation.ts`
- `server/worldmonitor/intelligence/v1/classify-event.ts`
- `server/worldmonitor/news/v1/` (all files using GROQ/OpenRouter)
- `server/_shared/acled.ts`
- `server/_shared/redis.ts` (UPSTASH vars — these stay as env only; Vault is for data API keys)
- `server/worldmonitor/supply-chain/v1/get-shipping-rates.ts`

**Pattern for each file (example for `get-country-intel-brief.ts`):**

**Step 1: Before (find this pattern):**

```typescript
const apiKey = process.env.GROQ_API_KEY;
if (!apiKey) return empty;
```

**Step 2: After (replace with):**

```typescript
import { getSecret } from '../../../_shared/secrets';
// ...
const apiKey = await getSecret('GROQ_API_KEY');
if (!apiKey) return empty;
```

**Step 3: Apply the pattern to each file**

For `server/_shared/acled.ts`:

```typescript
// Before:
const token = process.env.ACLED_ACCESS_TOKEN;

// After:
import { getSecret } from './secrets';
const token = await getSecret('ACLED_ACCESS_TOKEN');
```

**Full list of env var replacements:**

| Handler file | Old env var | New `getSecret()` call |
|---|---|---|
| `intelligence/v1/get-country-intel-brief.ts` | `process.env.GROQ_API_KEY` | `await getSecret('GROQ_API_KEY')` |
| `intelligence/v1/get-risk-scores.ts` | `process.env.GROQ_API_KEY` | `await getSecret('GROQ_API_KEY')` |
| `intelligence/v1/deduct-situation.ts` | `process.env.GROQ_API_KEY` | `await getSecret('GROQ_API_KEY')` |
| `intelligence/v1/classify-event.ts` | `process.env.GROQ_API_KEY` | `await getSecret('GROQ_API_KEY')` |
| `news/v1/*` (GROQ) | `process.env.GROQ_API_KEY` | `await getSecret('GROQ_API_KEY')` |
| `news/v1/*` (OpenRouter) | `process.env.OPENROUTER_API_KEY` | `await getSecret('OPENROUTER_API_KEY')` |
| `_shared/acled.ts` | `process.env.ACLED_ACCESS_TOKEN` | `await getSecret('ACLED_ACCESS_TOKEN')` |
| `supply-chain/v1/get-shipping-rates.ts` | Various | `await getSecret(...)` |

**Step 4: TypeCheck after each file**

```bash
npx tsc --noEmit
```

Expected: No new errors (functions are already async, `await` is valid)

**Step 5: Commit after all migrations**

```bash
git add server/
git commit -m "feat: migrate server handlers from process.env to getSecret() vault lookup"
```

---

## Task 9: Create Admin API Routes (Vercel Functions)

These are the protected REST endpoints consumed by the admin portal UI.

**Files:**
- Create: `api/admin/_auth.ts` — JWT verification middleware
- Create: `api/admin/secrets.ts` — CRUD for Vault secrets
- Create: `api/admin/feature-flags.ts` — CRUD for feature flags
- Create: `api/admin/news-sources.ts` — CRUD for news sources
- Create: `api/admin/llm-providers.ts` — CRUD for LLM providers
- Create: `api/admin/llm-prompts.ts` — CRUD for LLM prompts

**Step 1: Create the auth guard** `api/admin/_auth.ts`

```typescript
// api/admin/_auth.ts
import { createClient } from '@supabase/supabase-js';

export interface AdminUser {
  id: string;
  email: string;
  role: string;
}

/**
 * Verifies the Bearer token in Authorization header.
 * Returns the admin user record or throws a Response-like error object.
 */
export async function requireAdmin(req: Request): Promise<AdminUser> {
  const auth = req.headers.get('Authorization') ?? '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();

  if (!token) {
    throw { status: 401, body: 'Missing Authorization header' };
  }

  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw { status: 500, body: 'Supabase not configured' };
  }

  // Verify JWT and get user
  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: { user }, error } = await userClient.auth.getUser();
  if (error || !user) {
    throw { status: 401, body: 'Invalid or expired token' };
  }

  // Check admin_users table using service role
  const serviceClient = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: adminRecord, error: adminError } = await serviceClient
    .schema('wm_admin')
    .from('admin_users')
    .select('role')
    .eq('user_id', user.id)
    .single();

  if (adminError || !adminRecord) {
    throw { status: 403, body: 'Not an admin user' };
  }

  return { id: user.id, email: user.email!, role: adminRecord.role };
}

export function errorResponse(err: unknown): Response {
  if (err && typeof err === 'object' && 'status' in err) {
    const e = err as { status: number; body: string };
    return new Response(JSON.stringify({ error: e.body }), {
      status: e.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  console.error('[admin] Unexpected error:', err);
  return new Response(JSON.stringify({ error: 'Internal server error' }), {
    status: 500,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*', // tightened in production via gateway
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };
}
```

**Step 2: Create secrets CRUD** `api/admin/secrets.ts`

```typescript
// api/admin/secrets.ts
import { requireAdmin, errorResponse, corsHeaders } from './_auth';
import { createServiceClient } from '../../server/_shared/supabase';
import { invalidateSecretCache } from '../../server/_shared/secrets';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  const headers = corsHeaders();

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }

  try {
    await requireAdmin(req);
  } catch (err) {
    return errorResponse(err);
  }

  const supabase = createServiceClient();
  const url = new URL(req.url);
  const secretName = url.searchParams.get('name');

  // GET /api/admin/secrets — list secret names (never values)
  if (req.method === 'GET') {
    const { data, error } = await supabase.rpc(
      'list_vault_secret_names',
      {},
      { schema: 'wm_admin' },
    );

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    }

    return new Response(JSON.stringify({ secrets: data }), { status: 200, headers });
  }

  // POST /api/admin/secrets — create or update a secret
  if (req.method === 'POST') {
    const body = await req.json() as { name: string; value: string; description?: string };

    if (!body.name || !body.value) {
      return new Response(
        JSON.stringify({ error: 'name and value are required' }),
        { status: 400, headers },
      );
    }

    const { error } = await supabase.rpc(
      'upsert_vault_secret',
      { p_name: body.name, p_secret: body.value, p_description: body.description ?? null },
      { schema: 'wm_admin' },
    );

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    }

    await invalidateSecretCache(body.name);

    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  }

  // DELETE /api/admin/secrets?name=FOO
  if (req.method === 'DELETE') {
    if (!secretName) {
      return new Response(JSON.stringify({ error: 'name query param required' }), { status: 400, headers });
    }

    const { error } = await supabase.rpc(
      'delete_vault_secret',
      { p_name: secretName },
      { schema: 'wm_admin' },
    );

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    }

    await invalidateSecretCache(secretName);

    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
}
```

**Step 3: Create feature-flags CRUD** `api/admin/feature-flags.ts`

```typescript
// api/admin/feature-flags.ts
import { requireAdmin, errorResponse, corsHeaders } from './_auth';
import { createServiceClient } from '../../server/_shared/supabase';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  const headers = corsHeaders();

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });

  try {
    await requireAdmin(req);
  } catch (err) {
    return errorResponse(err);
  }

  const supabase = createServiceClient();

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .schema('wm_admin')
      .from('feature_flags')
      .select('*')
      .order('category', { ascending: true })
      .order('key', { ascending: true });

    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    return new Response(JSON.stringify({ flags: data }), { status: 200, headers });
  }

  if (req.method === 'PUT') {
    const body = await req.json() as { key: string; value: unknown; description?: string };

    if (!body.key) {
      return new Response(JSON.stringify({ error: 'key is required' }), { status: 400, headers });
    }

    const { error } = await supabase
      .schema('wm_admin')
      .from('feature_flags')
      .upsert({
        key: body.key,
        value: body.value,
        description: body.description,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'key' });

    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
}
```

**Step 4: Create news-sources CRUD** `api/admin/news-sources.ts`

```typescript
// api/admin/news-sources.ts
import { requireAdmin, errorResponse, corsHeaders } from './_auth';
import { createServiceClient } from '../../server/_shared/supabase';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  const headers = corsHeaders();

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });

  try {
    await requireAdmin(req);
  } catch (err) {
    return errorResponse(err);
  }

  const supabase = createServiceClient();
  const url = new URL(req.url);
  const id = url.searchParams.get('id');

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .schema('wm_admin')
      .from('news_sources')
      .select('*')
      .order('tier', { ascending: true })
      .order('name', { ascending: true });

    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    return new Response(JSON.stringify({ sources: data }), { status: 200, headers });
  }

  if (req.method === 'POST') {
    const body = await req.json();

    const { data, error } = await supabase
      .schema('wm_admin')
      .from('news_sources')
      .insert(body)
      .select()
      .single();

    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    return new Response(JSON.stringify({ source: data }), { status: 201, headers });
  }

  if (req.method === 'PUT') {
    if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers });

    const body = await req.json();

    const { data, error } = await supabase
      .schema('wm_admin')
      .from('news_sources')
      .update({ ...body, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    return new Response(JSON.stringify({ source: data }), { status: 200, headers });
  }

  if (req.method === 'DELETE') {
    if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers });

    const { error } = await supabase
      .schema('wm_admin')
      .from('news_sources')
      .delete()
      .eq('id', id);

    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
}
```

**Step 5: Create llm-providers.ts and llm-prompts.ts** following the exact same CRUD pattern as `news-sources.ts`, swapping the table names `llm_providers` and `llm_prompts`.

**Step 6: Typecheck**

```bash
npx tsc --noEmit -p tsconfig.api.json
```

Expected: No errors

**Step 7: Commit**

```bash
git add api/admin/
git commit -m "feat: add admin API routes for secrets, feature flags, news sources, LLM config"
```

---

## Task 10: Create the Admin Portal HTML & Bundle

**Files:**
- Create: `admin.html`
- Create: `src/admin-main.ts`
- Create: `src/admin/` directory with page modules
- Modify: `vite.config.ts` (add admin entry point)

**Step 1: Add admin entry to Vite config**

Open `vite.config.ts`. Find the `build.rollupOptions.input` section. Add `admin` entry:

```typescript
// In vite.config.ts build.rollupOptions.input:
input: {
  main: resolve(__dirname, 'index.html'),
  // ... existing entries ...
  admin: resolve(__dirname, 'admin.html'),
},
```

**Step 2: Create `admin.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>World Monitor — Admin Portal</title>
  <meta name="robots" content="noindex, nofollow" />
  <style>
    :root {
      --bg: #0d1117;
      --surface: #161b22;
      --border: #30363d;
      --text: #e6edf3;
      --text-muted: #8b949e;
      --accent: #388bfd;
      --accent-hover: #58a6ff;
      --danger: #da3633;
      --success: #3fb950;
      --warning: #d29922;
      --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      --radius: 6px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--font);
      font-size: 14px;
      min-height: 100vh;
    }
    #app { display: flex; flex-direction: column; min-height: 100vh; }
  </style>
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/src/admin-main.ts"></script>
</body>
</html>
```

**Step 3: Create `src/admin-main.ts`** — the entry point that handles auth gate + routing

```typescript
// src/admin-main.ts
import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';
import { renderLoginPage } from './admin/login';
import { renderDashboard } from './admin/dashboard';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true },
});

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
  // Verify admin role against admin API
  const res = await fetch('/api/admin/feature-flags', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 403 || res.status === 401) {
    app.innerHTML = `
      <div style="padding:40px;text-align:center;color:#da3633">
        <h2>Access Denied</h2>
        <p>Your account does not have admin access.</p>
        <button onclick="location.reload()" style="margin-top:16px;padding:8px 16px;cursor:pointer">
          Sign Out
        </button>
      </div>`;
    await supabase.auth.signOut();
    return;
  }

  renderDashboard(app, supabase, accessToken, user);
}

init().catch(console.error);
```

**Step 4: Create `src/admin/login.ts`**

```typescript
// src/admin/login.ts
import type { SupabaseClient, User } from '@supabase/supabase-js';

export function renderLoginPage(
  container: HTMLElement,
  supabase: SupabaseClient,
  onSuccess: (user: User, token: string) => void,
): void {
  container.innerHTML = `
    <div style="
      display:flex; align-items:center; justify-content:center;
      min-height:100vh; background:var(--bg);
    ">
      <div style="
        background:var(--surface); border:1px solid var(--border);
        border-radius:var(--radius); padding:40px; width:360px;
      ">
        <h1 style="font-size:20px;margin-bottom:8px">World Monitor</h1>
        <p style="color:var(--text-muted);margin-bottom:24px">Admin Portal</p>

        <label style="display:block;margin-bottom:4px;color:var(--text-muted)">Email</label>
        <input id="admin-email" type="email" autocomplete="email"
          style="
            width:100%;padding:8px 12px;margin-bottom:16px;
            background:var(--bg);border:1px solid var(--border);
            border-radius:var(--radius);color:var(--text);font-size:14px;
          "
        />

        <label style="display:block;margin-bottom:4px;color:var(--text-muted)">Password</label>
        <input id="admin-password" type="password" autocomplete="current-password"
          style="
            width:100%;padding:8px 12px;margin-bottom:24px;
            background:var(--bg);border:1px solid var(--border);
            border-radius:var(--radius);color:var(--text);font-size:14px;
          "
        />

        <button id="admin-login-btn" style="
          width:100%;padding:10px;background:var(--accent);color:#fff;
          border:none;border-radius:var(--radius);cursor:pointer;font-size:14px;
          font-weight:600;
        ">Sign In</button>

        <p id="admin-login-error" style="color:var(--danger);margin-top:12px;display:none"></p>
      </div>
    </div>
  `;

  const btn = container.querySelector<HTMLButtonElement>('#admin-login-btn')!;
  const errEl = container.querySelector<HTMLParagraphElement>('#admin-login-error')!;

  btn.addEventListener('click', async () => {
    const email = (container.querySelector<HTMLInputElement>('#admin-email')!).value.trim();
    const password = (container.querySelector<HTMLInputElement>('#admin-password')!).value;

    if (!email || !password) {
      errEl.textContent = 'Email and password are required.';
      errEl.style.display = 'block';
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Signing in…';
    errEl.style.display = 'none';

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error || !data.session) {
      btn.disabled = false;
      btn.textContent = 'Sign In';
      errEl.textContent = 'Invalid email or password.';
      errEl.style.display = 'block';
      return;
    }

    onSuccess(data.user, data.session.access_token);
  });

  // Allow Enter key
  container.querySelector<HTMLInputElement>('#admin-password')!
    .addEventListener('keydown', (e) => {
      if (e.key === 'Enter') btn.click();
    });
}
```

**Step 5: Create `src/admin/dashboard.ts`** — navigation shell

```typescript
// src/admin/dashboard.ts
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { renderSecretsPage } from './pages/secrets';
import { renderFeatureFlagsPage } from './pages/feature-flags';
import { renderNewsSourcesPage } from './pages/news-sources';
import { renderLlmConfigPage } from './pages/llm-config';

type PageId = 'secrets' | 'feature-flags' | 'news-sources' | 'llm-config';

const NAV_ITEMS: Array<{ id: PageId; label: string; icon: string }> = [
  { id: 'secrets',       label: 'API Keys & Secrets',  icon: '🔑' },
  { id: 'feature-flags', label: 'Feature Flags',        icon: '🚩' },
  { id: 'news-sources',  label: 'News Sources',         icon: '📡' },
  { id: 'llm-config',    label: 'LLM Config & Prompts', icon: '🤖' },
];

export function renderDashboard(
  container: HTMLElement,
  supabase: SupabaseClient,
  accessToken: string,
  user: User,
): void {
  let currentPage: PageId = 'secrets';

  container.innerHTML = `
    <div style="display:flex;min-height:100vh">
      <nav style="
        width:220px;background:var(--surface);border-right:1px solid var(--border);
        padding:20px 0;display:flex;flex-direction:column;
      ">
        <div style="padding:0 16px 20px;border-bottom:1px solid var(--border)">
          <div style="font-weight:700;font-size:15px">World Monitor</div>
          <div style="color:var(--text-muted);font-size:12px">Admin Portal</div>
        </div>
        <ul id="admin-nav" style="list-style:none;padding:12px 0;flex:1">
          ${NAV_ITEMS.map(item => `
            <li>
              <a href="#${item.id}" data-page="${item.id}" style="
                display:flex;align-items:center;gap:10px;
                padding:8px 16px;color:var(--text-muted);
                text-decoration:none;border-radius:var(--radius);
                margin:2px 8px;cursor:pointer;
                transition:background 0.15s;
              ">
                <span>${item.icon}</span>
                <span>${item.label}</span>
              </a>
            </li>
          `).join('')}
        </ul>
        <div style="padding:16px;border-top:1px solid var(--border)">
          <div style="color:var(--text-muted);font-size:12px;margin-bottom:8px">
            ${user.email}
          </div>
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
    currentPage = pageId;

    // Update active nav link
    nav.querySelectorAll('a').forEach(a => {
      const isActive = a.dataset['page'] === pageId;
      a.style.background = isActive ? 'rgba(56,139,253,0.15)' : 'transparent';
      a.style.color = isActive ? 'var(--accent)' : 'var(--text-muted)';
    });

    // Render page
    content.innerHTML = '';
    switch (pageId) {
      case 'secrets':       renderSecretsPage(content, accessToken);       break;
      case 'feature-flags': renderFeatureFlagsPage(content, accessToken);  break;
      case 'news-sources':  renderNewsSourcesPage(content, accessToken);   break;
      case 'llm-config':    renderLlmConfigPage(content, accessToken);     break;
    }
  }

  nav.addEventListener('click', (e) => {
    const link = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[data-page]');
    if (!link) return;
    e.preventDefault();
    navigateTo(link.dataset['page'] as PageId);
  });

  container.querySelector('#admin-signout')!.addEventListener('click', async () => {
    await supabase.auth.signOut();
    location.reload();
  });

  // Handle hash routing
  const hash = location.hash.replace('#', '') as PageId;
  navigateTo(NAV_ITEMS.some(n => n.id === hash) ? hash : 'secrets');
}
```

**Step 6: Build verify**

```bash
npm run build 2>&1 | tail -20
```

Expected: Build succeeds, `dist/admin.html` created

**Step 7: Commit**

```bash
git add admin.html src/admin-main.ts src/admin/ vite.config.ts
git commit -m "feat: add admin portal HTML shell with Supabase auth, navigation, login page"
```

---

## Task 11: Admin Pages — Secrets Manager

**Files:**
- Create: `src/admin/pages/secrets.ts`

**Step 1: Create the secrets page**

```typescript
// src/admin/pages/secrets.ts

interface SecretEntry {
  name: string;
  description: string;
  updated_at: string;
}

export function renderSecretsPage(container: HTMLElement, accessToken: string): void {
  container.innerHTML = `
    <h2 style="font-size:20px;margin-bottom:4px">API Keys & Secrets</h2>
    <p style="color:var(--text-muted);margin-bottom:24px">
      Stored in Supabase Vault (encrypted). Values are never returned after saving.
    </p>

    <div style="display:flex;gap:12px;margin-bottom:24px;align-items:flex-end;flex-wrap:wrap">
      <div style="flex:1;min-width:200px">
        <label style="display:block;color:var(--text-muted);margin-bottom:4px">Secret Name</label>
        <input id="new-secret-name" placeholder="e.g. GROQ_API_KEY" style="
          width:100%;padding:8px 12px;background:var(--bg);
          border:1px solid var(--border);border-radius:var(--radius);
          color:var(--text);font-size:14px;font-family:monospace;
        " />
      </div>
      <div style="flex:2;min-width:200px">
        <label style="display:block;color:var(--text-muted);margin-bottom:4px">Value</label>
        <input id="new-secret-value" type="password" placeholder="Paste secret value here" style="
          width:100%;padding:8px 12px;background:var(--bg);
          border:1px solid var(--border);border-radius:var(--radius);
          color:var(--text);font-size:14px;
        " />
      </div>
      <div style="flex:1;min-width:160px">
        <label style="display:block;color:var(--text-muted);margin-bottom:4px">Description (optional)</label>
        <input id="new-secret-desc" placeholder="What is this key for?" style="
          width:100%;padding:8px 12px;background:var(--bg);
          border:1px solid var(--border);border-radius:var(--radius);
          color:var(--text);font-size:14px;
        " />
      </div>
      <button id="add-secret-btn" style="
        padding:8px 20px;background:var(--accent);color:#fff;
        border:none;border-radius:var(--radius);cursor:pointer;
        font-size:14px;font-weight:600;white-space:nowrap;
      ">Save Secret</button>
    </div>

    <div id="secrets-status" style="margin-bottom:12px;display:none"></div>

    <table style="width:100%;border-collapse:collapse">
      <thead>
        <tr style="border-bottom:1px solid var(--border)">
          <th style="text-align:left;padding:10px 12px;color:var(--text-muted);font-weight:500">Name</th>
          <th style="text-align:left;padding:10px 12px;color:var(--text-muted);font-weight:500">Description</th>
          <th style="text-align:left;padding:10px 12px;color:var(--text-muted);font-weight:500">Last Updated</th>
          <th style="padding:10px 12px;color:var(--text-muted);font-weight:500;text-align:right">Actions</th>
        </tr>
      </thead>
      <tbody id="secrets-list">
        <tr><td colspan="4" style="padding:20px;color:var(--text-muted)">Loading…</td></tr>
      </tbody>
    </table>
  `;

  async function loadSecrets(): Promise<void> {
    const tbody = container.querySelector<HTMLElement>('#secrets-list')!;
    const res = await fetch('/api/admin/secrets', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      tbody.innerHTML = `<tr><td colspan="4" style="padding:20px;color:var(--danger)">Failed to load secrets</td></tr>`;
      return;
    }

    const { secrets } = await res.json() as { secrets: SecretEntry[] };

    if (!secrets || secrets.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" style="padding:20px;color:var(--text-muted)">No secrets stored yet. Add one above.</td></tr>`;
      return;
    }

    tbody.innerHTML = secrets.map(s => `
      <tr style="border-bottom:1px solid var(--border)">
        <td style="padding:12px;font-family:monospace">${s.name}</td>
        <td style="padding:12px;color:var(--text-muted)">${s.description || '—'}</td>
        <td style="padding:12px;color:var(--text-muted)">
          ${new Date(s.updated_at).toLocaleString()}
        </td>
        <td style="padding:12px;text-align:right">
          <button data-delete="${s.name}" style="
            padding:4px 12px;background:transparent;
            border:1px solid var(--danger);color:var(--danger);
            border-radius:var(--radius);cursor:pointer;font-size:13px;
          ">Delete</button>
        </td>
      </tr>
    `).join('');

    tbody.querySelectorAll<HTMLButtonElement>('[data-delete]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const name = btn.dataset['delete']!;
        if (!confirm(`Delete secret "${name}"? This cannot be undone.`)) return;

        const delRes = await fetch(`/api/admin/secrets?name=${encodeURIComponent(name)}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (delRes.ok) {
          await loadSecrets();
        } else {
          showStatus('Failed to delete secret', 'error');
        }
      });
    });
  }

  function showStatus(msg: string, type: 'success' | 'error'): void {
    const el = container.querySelector<HTMLElement>('#secrets-status')!;
    el.textContent = msg;
    el.style.color = type === 'success' ? 'var(--success)' : 'var(--danger)';
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 4000);
  }

  container.querySelector('#add-secret-btn')!.addEventListener('click', async () => {
    const name = (container.querySelector<HTMLInputElement>('#new-secret-name')!).value.trim();
    const value = (container.querySelector<HTMLInputElement>('#new-secret-value')!).value;
    const desc = (container.querySelector<HTMLInputElement>('#new-secret-desc')!).value.trim();

    if (!name || !value) {
      showStatus('Name and value are required', 'error');
      return;
    }

    const res = await fetch('/api/admin/secrets', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name, value, description: desc }),
    });

    if (res.ok) {
      (container.querySelector<HTMLInputElement>('#new-secret-name')!).value = '';
      (container.querySelector<HTMLInputElement>('#new-secret-value')!).value = '';
      (container.querySelector<HTMLInputElement>('#new-secret-desc')!).value = '';
      showStatus(`Secret "${name}" saved`, 'success');
      await loadSecrets();
    } else {
      showStatus('Failed to save secret', 'error');
    }
  });

  loadSecrets();
}
```

**Step 2: Commit**

```bash
git add src/admin/pages/secrets.ts
git commit -m "feat: add admin secrets manager page (Supabase Vault CRUD)"
```

---

## Task 12: Admin Pages — Feature Flags

**Files:**
- Create: `src/admin/pages/feature-flags.ts`

Create a page that loads all flags from `/api/admin/feature-flags` and renders them in a table with inline toggle/edit support. Follow the same pattern as `secrets.ts` — fetch, render table rows, PUT on change.

Key details:
- Boolean flags render as a toggle switch (`<input type="checkbox">`)
- Number flags render as `<input type="number">`
- String flags render as `<input type="text">`
- Group rows by `category` with a sticky category header
- On change, debounce 500ms then call `PUT /api/admin/feature-flags` with `{ key, value }`

**Step 1: Create the page** (implement fully following the `secrets.ts` pattern)

**Step 2: Commit**

```bash
git add src/admin/pages/feature-flags.ts
git commit -m "feat: add admin feature flags page with inline toggle/edit"
```

---

## Task 13: Admin Pages — News Sources Manager

**Files:**
- Create: `src/admin/pages/news-sources.ts`

Renders a searchable, filterable table of all news sources. Columns: Name, URL, Tier (1–4), Variants (chips), Category, Language, Proxy Mode, Enabled toggle, Actions (edit/delete).

Features:
- Search box (filters by name/URL in real time, client-side)
- Filter by variant: `full | tech | finance | happy`
- Filter by enabled state
- "Add New Source" form (same fields as table columns)
- Edit inline (click row to expand inline edit form)
- Bulk import: textarea to paste JSON array of sources

**Step 1: Create the page** (implement fully)

**Step 2: Commit**

```bash
git add src/admin/pages/news-sources.ts
git commit -m "feat: add admin news sources manager with CRUD, search, and bulk import"
```

---

## Task 14: Admin Pages — LLM Config & Prompts

**Files:**
- Create: `src/admin/pages/llm-config.ts`

Two sections:

**Section A — LLM Providers** (table, same CRUD pattern):
- Columns: Name, API URL, Default Model, Priority, Enabled toggle
- Edit inline

**Section B — LLM Prompts** (tabbed by prompt_key):
- Tabs: `intel_brief` | `news_summary`
- Within each tab, show rows for each (variant, mode) combination
- Large `<textarea>` for editing system_prompt and user_prompt
- "Save" button per row with visual feedback
- Show placeholder documentation below each textarea

**Step 1: Create the page** (implement fully)

**Step 2: Commit**

```bash
git add src/admin/pages/llm-config.ts
git commit -m "feat: add admin LLM config and prompts editor"
```

---

## Task 15: Update Vercel Config for Admin Route

**Files:**
- Modify: `vercel.json`

**Step 1: Add admin routes to headers** — ensure admin HTML is not cached and is not indexed:

```json
{
  "source": "/admin",
  "headers": [
    { "key": "Cache-Control", "value": "no-cache, no-store, must-revalidate" },
    { "key": "X-Robots-Tag", "value": "noindex, nofollow" }
  ]
}
```

Add this to the `headers` array in `vercel.json`.

**Step 2: Add admin API routes** to the existing CORS headers block. The existing `"/api/(.*)"` block already covers `/api/admin/*` — no change needed.

**Step 3: Verify the admin route resolves** locally:

```bash
npm run dev
# Navigate to http://localhost:5173/admin.html
```

Expected: Login page appears with email/password form.

**Step 4: Commit**

```bash
git add vercel.json
git commit -m "feat: add no-cache and noindex headers for admin portal route"
```

---

## Task 16: Seed News Sources into DB (from feeds.ts)

The `src/config/feeds.ts` file has 1000+ lines of feeds. We need to seed the database with them so the admin portal shows the existing sources on first load.

**Files:**
- Create: `scripts/seed-news-sources.mts`

**Step 1: Create the seed script**

```typescript
// scripts/seed-news-sources.mts
/**
 * One-time seed: imports all hard-coded feeds from src/config/feeds.ts
 * into the wm_admin.news_sources Supabase table.
 *
 * Run once after applying the migration:
 *   npx tsx scripts/seed-news-sources.mts
 */
import { createClient } from '@supabase/supabase-js';
import { FEEDS } from '../src/config/feeds.ts';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

// FEEDS is the exported array from feeds.ts — inspect the Feed type
// to know the shape: { name, url, tier, variants, category, language, proxyMode }
const records = FEEDS.map((f) => ({
  name: f.name,
  url: f.url,
  tier: f.tier ?? 3,
  variants: f.variants ?? ['full'],
  category: f.category ?? 'general',
  language: f.language ?? 'en',
  proxy_mode: f.proxyMode ?? 'rss',
  enabled: true,
}));

const { error } = await supabase
  .schema('wm_admin')
  .from('news_sources')
  .upsert(records, { onConflict: 'name,url' });

if (error) {
  console.error('Seed failed:', error);
  process.exit(1);
}

console.log(`Seeded ${records.length} news sources.`);
```

**Step 2: Run the seed**

```bash
npx tsx scripts/seed-news-sources.mts
```

Expected: `Seeded N news sources.`

> **Note:** You may need to adapt the script to match the actual exported shape of `feeds.ts`. Run `npx tsx -e "import { FEEDS } from './src/config/feeds.ts'; console.log(FEEDS[0])"` to inspect the first feed object before running the full seed.

**Step 3: Commit**

```bash
git add scripts/seed-news-sources.mts
git commit -m "chore: add script to seed news sources from hard-coded feeds.ts into Supabase"
```

---

## Task 17: Smoke Tests for Admin API

**Files:**
- Create: `e2e/admin-portal.spec.ts`

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

    const errorEl = page.locator('#admin-login-error');
    await expect(errorEl).toBeVisible({ timeout: 5000 });
    await expect(errorEl).toContainText('Invalid email or password');
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
});
```

**Step 1: Run the smoke tests**

```bash
npx playwright test e2e/admin-portal.spec.ts
```

Expected: All 5 tests pass.

**Step 2: Commit**

```bash
git add e2e/admin-portal.spec.ts
git commit -m "test: add smoke tests for admin portal auth and API 401 enforcement"
```

---

## Task 18: Update docs and Finalize

**Files:**
- Modify: `README.md` (brief admin portal section)
- Modify: `.env.example` (verify all new vars are documented — done in Task 3)

**Step 1: Add admin portal section to README**

After the existing configuration section, add:

```markdown
## Admin Portal

World Monitor includes a password-protected admin portal at `/admin.html`.

**Access:** Create an account via Supabase Auth, then add the user UUID to `wm_admin.admin_users`.

**What you can manage:**
- API Keys & Secrets (stored in Supabase Vault, never in source code)
- Feature Flags (ML models, UI features)
- News Sources (add/edit/disable RSS feeds)
- LLM Config & Prompts (model selection, system prompts per variant/mode)

**Required env vars (Vercel):**
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
```

**Step 2: Typecheck everything one final time**

```bash
npx tsc --noEmit && npx tsc --noEmit -p tsconfig.api.json
```

Expected: No errors.

**Step 3: Run all smoke tests**

```bash
npx playwright test e2e/admin-portal.spec.ts
```

Expected: All pass.

**Step 4: Final commit**

```bash
git add README.md
git commit -m "docs: add admin portal section to README"
```

---

## Deployment Notes

1. **Set Vercel env vars** for the production deployment:
   - `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
   - `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`

2. **Run migration SQL** against production Supabase (already same project `fmultmlsevqgtnqzaylg`).

3. **Migrate existing API keys** from Vercel env vars to Vault via the admin portal. Then remove them from Vercel env (or leave as fallback).

4. **The env vars in Vercel remain valid fallbacks** — `getSecret()` checks Vault first, then falls back to `process.env`. No hard cutover required.

5. **Admin portal URL:** `https://worldmonitor.app/admin.html` (or whichever domain hosts the deployment). This is `noindex` and protected by auth.

---

## Security Considerations

- `SUPABASE_SERVICE_ROLE_KEY` must never be in VITE_ env vars or browser bundles
- Admin API routes use Supabase JWT verification + `admin_users` table check on every request
- Vault RPC functions are `REVOKE`d from `anon` and `authenticated` roles — only callable by service role
- Secret values are never returned by any API endpoint (list shows names + metadata only)
- Admin portal has `noindex, nofollow` and no-cache headers
- All admin routes enforce HTTPS via existing Vercel HSTS headers
