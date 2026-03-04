-- =============================================================
-- Admin portal schema: feature flags, news sources, LLM config,
-- vault RPCs, app keys, audit log
--
-- Best-practice compliance:
--   security-rls-performance  : is_admin() uses (SELECT auth.uid()), SECURITY DEFINER,
--                               set search_path = ''; all policies use (SELECT is_admin())
--   security-rls-basics       : FORCE ROW LEVEL SECURITY on every table
--   security-privileges       : schema USAGE/CREATE revoked from public/anon/authenticated;
--                               all Vault RPCs explicitly revoked from non-service roles
--   schema-primary-keys       : UUIDv4 acceptable for low-volume admin tables; noted
--   schema-data-types         : timestamptz everywhere, text not varchar, boolean not text
--   schema-foreign-key-indexes: index on every FK column (updated_by, created_by, prompt_id)
--   advanced-jsonb-indexing   : GIN index on news_sources.url (JSONB, queried with @>)
--   query-partial-indexes     : partial indexes on enabled=true for hot query paths
--   query-composite-indexes   : composite index on llm_prompts(prompt_key, variant, mode)
--   schema-lowercase-identifiers: all identifiers snake_case, no quoted mixed-case
-- =============================================================

-- =============================================================
-- Schema
-- =============================================================
CREATE SCHEMA IF NOT EXISTS wm_admin;

-- Revoke all default access to the schema from non-service roles
-- (security-privileges: least privilege on schema itself)
REVOKE ALL ON SCHEMA wm_admin FROM PUBLIC;
REVOKE ALL ON SCHEMA wm_admin FROM anon;
REVOKE ALL ON SCHEMA wm_admin FROM authenticated;

-- =============================================================
-- 1. Feature Flags
-- key: dot-namespaced (e.g. 'ml.semanticClustering')
-- value: JSONB — bool, number, string, or object
-- =============================================================
CREATE TABLE wm_admin.feature_flags (
  key         TEXT        PRIMARY KEY,
  value       JSONB       NOT NULL,
  description TEXT,
  category    TEXT        NOT NULL DEFAULT 'general',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  UUID        REFERENCES auth.users(id) ON DELETE SET NULL
);

-- FK index: updated_by (schema-foreign-key-indexes)
CREATE INDEX idx_feature_flags_updated_by ON wm_admin.feature_flags (updated_by)
  WHERE updated_by IS NOT NULL;

INSERT INTO wm_admin.feature_flags (key, value, description, category) VALUES
  ('ml.semanticClustering',      'true',   'Enable semantic news clustering via ONNX embeddings',  'ml'),
  ('ml.mlSentiment',             'true',   'Enable ML-based sentiment analysis',                   'ml'),
  ('ml.summarization',           'true',   'Enable local ONNX summarization',                      'ml'),
  ('ml.mlNER',                   'true',   'Enable named entity recognition',                      'ml'),
  ('ml.insightsPanel',           'true',   'Show ML insights panel in UI',                         'ml'),
  ('ml.semanticClusterThreshold','0.75',   'Cosine similarity threshold for clustering',           'ml'),
  ('ml.minClustersForML',        '5',      'Minimum cluster count before enabling ML features',    'ml'),
  ('ml.maxTextsPerBatch',        '20',     'Max headlines per ML inference batch',                 'ml'),
  ('ml.modelLoadTimeoutMs',      '600000', 'Model load timeout in milliseconds',                   'ml'),
  ('ml.inferenceTimeoutMs',      '120000', 'Single inference timeout in milliseconds',             'ml'),
  ('ml.memoryBudgetMB',          '200',    'Memory budget for loaded ONNX models (MB)',            'ml'),
  ('site.betaMode',              'false',  'Enable beta features for all users',                   'site'),
  ('site.defaultVariant',        '"full"', 'Default site variant (full|tech|finance|happy)',       'site');

-- =============================================================
-- 2. News Sources
-- url: JSONB — string | Record<lang, url>
-- variants: which site variants include this feed
-- =============================================================
CREATE TABLE wm_admin.news_sources (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT        NOT NULL,
  url          JSONB       NOT NULL,   -- string | { "en": "...", "de": "...", ... }
  tier         INTEGER     NOT NULL DEFAULT 3 CHECK (tier BETWEEN 1 AND 4),
  variants     TEXT[]      NOT NULL DEFAULT '{full}',
  category     TEXT        NOT NULL DEFAULT 'general',
  source_type  TEXT,
  lang         TEXT        NOT NULL DEFAULT 'en',
  proxy_mode   TEXT        NOT NULL DEFAULT 'rss'
                           CHECK (proxy_mode IN ('rss', 'relay', 'direct')),
  propaganda_risk      TEXT    NOT NULL DEFAULT 'low'
                               CHECK (propaganda_risk IN ('low', 'medium', 'high')),
  state_affiliated     TEXT,
  propaganda_note      TEXT,
  default_enabled      BOOLEAN NOT NULL DEFAULT true,
  enabled      BOOLEAN     NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (name)
);

-- GIN on variants array — app queries: .contains('variants', [variant])
-- (query-missing-indexes: array containment needs GIN)
CREATE INDEX idx_news_sources_variants ON wm_admin.news_sources USING GIN (variants);

-- GIN on url JSONB — future containment queries (advanced-jsonb-indexing)
CREATE INDEX idx_news_sources_url ON wm_admin.news_sources USING GIN (url jsonb_path_ops);

-- Partial index: only enabled sources (query-partial-indexes)
-- Hot path: .eq('enabled', true).contains('variants', [variant])
CREATE INDEX idx_news_sources_enabled_variants ON wm_admin.news_sources USING GIN (variants)
  WHERE enabled = true;

-- FK index: updated_by (schema-foreign-key-indexes)
CREATE INDEX idx_news_sources_updated_by ON wm_admin.news_sources (updated_by)
  WHERE updated_by IS NOT NULL;

-- =============================================================
-- 3. LLM Providers
-- priority: lower = higher priority (1 = try first)
-- api_key_secret_name: name of the Vault secret holding the API key
-- =============================================================
CREATE TABLE wm_admin.llm_providers (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 TEXT        NOT NULL UNIQUE,
  api_url              TEXT        NOT NULL,
  default_model        TEXT        NOT NULL,
  priority             INTEGER     NOT NULL DEFAULT 1,
  enabled              BOOLEAN     NOT NULL DEFAULT true,
  api_key_secret_name  TEXT        NOT NULL,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by           UUID        REFERENCES auth.users(id) ON DELETE SET NULL
);

-- Partial index: active providers by priority (query-partial-indexes)
CREATE INDEX idx_llm_providers_active_priority ON wm_admin.llm_providers (priority)
  WHERE enabled = true;

-- FK index: updated_by (schema-foreign-key-indexes)
CREATE INDEX idx_llm_providers_updated_by ON wm_admin.llm_providers (updated_by)
  WHERE updated_by IS NOT NULL;

INSERT INTO wm_admin.llm_providers (name, api_url, default_model, priority, api_key_secret_name)
VALUES
  ('groq',       'https://api.groq.com/openai/v1/chat/completions',  'llama-3.1-8b-instant', 1, 'GROQ_API_KEY'),
  ('openrouter', 'https://openrouter.ai/api/v1/chat/completions',    'openai/gpt-4o-mini',   2, 'OPENROUTER_API_KEY');

-- =============================================================
-- 4. LLM Prompts
-- UNIQUE(prompt_key, variant, mode) — NULLs are distinct in unique
-- constraints, so composite index handles the lookup path
-- =============================================================
CREATE TABLE wm_admin.llm_prompts (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_key    TEXT        NOT NULL,
  variant       TEXT,
  mode          TEXT,
  system_prompt TEXT        NOT NULL,
  user_prompt   TEXT,
  description   TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (prompt_key, variant, mode)
);

-- Composite index for the primary lookup path (query-composite-indexes)
-- App calls: .eq('prompt_key', key).is('variant', null) etc.
CREATE INDEX idx_llm_prompts_lookup ON wm_admin.llm_prompts (prompt_key, variant, mode);

-- FK index: updated_by (schema-foreign-key-indexes)
CREATE INDEX idx_llm_prompts_updated_by ON wm_admin.llm_prompts (updated_by)
  WHERE updated_by IS NOT NULL;

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

-- =============================================================
-- 5. LLM Prompt History (audit trail for prompt edits)
-- =============================================================
CREATE TABLE wm_admin.llm_prompt_history (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_id     UUID        NOT NULL REFERENCES wm_admin.llm_prompts(id) ON DELETE CASCADE,
  system_prompt TEXT        NOT NULL,
  user_prompt   TEXT,
  changed_by    UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  changed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- FK index: prompt_id — the primary access pattern (schema-foreign-key-indexes)
CREATE INDEX idx_llm_prompt_history_prompt_id ON wm_admin.llm_prompt_history (prompt_id, changed_at DESC);

-- FK index: changed_by (schema-foreign-key-indexes)
CREATE INDEX idx_llm_prompt_history_changed_by ON wm_admin.llm_prompt_history (changed_by)
  WHERE changed_by IS NOT NULL;

-- =============================================================
-- 6. App API Keys
-- Replaces WORLDMONITOR_VALID_KEYS env var.
-- key_hash: SHA-256 hex of raw key — never store raw keys
-- =============================================================
CREATE TABLE wm_admin.app_keys (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  key_hash    TEXT        NOT NULL UNIQUE,
  description TEXT,
  enabled     BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at  TIMESTAMPTZ,
  created_by  UUID        REFERENCES auth.users(id) ON DELETE SET NULL
);

-- Partial index: only active (non-revoked) keys — the hot verify path
-- (query-partial-indexes: most lookups are enabled=true AND revoked_at IS NULL)
CREATE INDEX idx_app_keys_active ON wm_admin.app_keys (key_hash)
  WHERE enabled = true AND revoked_at IS NULL;

-- FK index: created_by (schema-foreign-key-indexes)
CREATE INDEX idx_app_keys_created_by ON wm_admin.app_keys (created_by)
  WHERE created_by IS NOT NULL;

-- =============================================================
-- 7. Admin Users
-- =============================================================
CREATE TABLE wm_admin.admin_users (
  user_id     UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role        TEXT        NOT NULL DEFAULT 'admin'
                          CHECK (role IN ('admin', 'superadmin')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  UUID        REFERENCES auth.users(id) ON DELETE SET NULL
);

-- FK index: created_by (schema-foreign-key-indexes)
CREATE INDEX idx_admin_users_created_by ON wm_admin.admin_users (created_by)
  WHERE created_by IS NOT NULL;

-- =============================================================
-- 8. Audit Log
-- Append-only record of admin actions
-- =============================================================
CREATE TABLE wm_admin.audit_log (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id    UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  action      TEXT        NOT NULL,
  table_name  TEXT        NOT NULL,
  record_id   TEXT,
  old_data    JSONB,
  new_data    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Composite index: actor + time (query-composite-indexes, common query pattern)
CREATE INDEX idx_audit_log_actor_time ON wm_admin.audit_log (actor_id, created_at DESC)
  WHERE actor_id IS NOT NULL;

-- Index: table_name + time for per-table audit views
CREATE INDEX idx_audit_log_table_time ON wm_admin.audit_log (table_name, created_at DESC);

-- =============================================================
-- 9. is_admin() helper — used by all RLS policies
--
-- SECURITY DEFINER: runs as function owner, not caller
-- set search_path = '': prevents search_path injection attacks
-- (SELECT auth.uid()): cached once per statement, not per row
--   (security-rls-performance: wrapping in SELECT caches the call)
-- =============================================================
CREATE OR REPLACE FUNCTION wm_admin.is_admin()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM wm_admin.admin_users
    WHERE user_id = (SELECT auth.uid())
  );
$$;

-- =============================================================
-- 10. RLS Policies
--
-- FORCE ROW LEVEL SECURITY: table owner also subject to RLS
--   (security-rls-basics)
-- (SELECT wm_admin.is_admin()): function result cached per statement
--   not re-evaluated for every row (security-rls-performance)
-- =============================================================
ALTER TABLE wm_admin.feature_flags      ENABLE ROW LEVEL SECURITY;
ALTER TABLE wm_admin.news_sources       ENABLE ROW LEVEL SECURITY;
ALTER TABLE wm_admin.llm_providers      ENABLE ROW LEVEL SECURITY;
ALTER TABLE wm_admin.llm_prompts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE wm_admin.llm_prompt_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE wm_admin.app_keys           ENABLE ROW LEVEL SECURITY;
ALTER TABLE wm_admin.admin_users        ENABLE ROW LEVEL SECURITY;
ALTER TABLE wm_admin.audit_log          ENABLE ROW LEVEL SECURITY;

ALTER TABLE wm_admin.feature_flags      FORCE ROW LEVEL SECURITY;
ALTER TABLE wm_admin.news_sources       FORCE ROW LEVEL SECURITY;
ALTER TABLE wm_admin.llm_providers      FORCE ROW LEVEL SECURITY;
ALTER TABLE wm_admin.llm_prompts        FORCE ROW LEVEL SECURITY;
ALTER TABLE wm_admin.llm_prompt_history FORCE ROW LEVEL SECURITY;
ALTER TABLE wm_admin.app_keys           FORCE ROW LEVEL SECURITY;
ALTER TABLE wm_admin.admin_users        FORCE ROW LEVEL SECURITY;
ALTER TABLE wm_admin.audit_log          FORCE ROW LEVEL SECURITY;

-- Admin tables: full access for admins (service role bypasses RLS automatically)
CREATE POLICY "admins_all_feature_flags"
  ON wm_admin.feature_flags FOR ALL
  USING ((SELECT wm_admin.is_admin()));

CREATE POLICY "admins_all_news_sources"
  ON wm_admin.news_sources FOR ALL
  USING ((SELECT wm_admin.is_admin()));

CREATE POLICY "admins_all_llm_providers"
  ON wm_admin.llm_providers FOR ALL
  USING ((SELECT wm_admin.is_admin()));

CREATE POLICY "admins_all_llm_prompts"
  ON wm_admin.llm_prompts FOR ALL
  USING ((SELECT wm_admin.is_admin()));

CREATE POLICY "admins_all_llm_prompt_history"
  ON wm_admin.llm_prompt_history FOR ALL
  USING ((SELECT wm_admin.is_admin()));

CREATE POLICY "admins_all_app_keys"
  ON wm_admin.app_keys FOR ALL
  USING ((SELECT wm_admin.is_admin()));

CREATE POLICY "admins_read_admin_users"
  ON wm_admin.admin_users FOR SELECT
  USING ((SELECT wm_admin.is_admin()));

CREATE POLICY "superadmins_write_admin_users"
  ON wm_admin.admin_users FOR ALL
  USING (EXISTS (
    SELECT 1 FROM wm_admin.admin_users
    WHERE user_id = (SELECT auth.uid()) AND role = 'superadmin'
  ));

CREATE POLICY "admins_all_audit_log"
  ON wm_admin.audit_log FOR ALL
  USING ((SELECT wm_admin.is_admin()));

-- =============================================================
-- 11. Vault RPCs (callable by service role only)
--
-- SECURITY DEFINER + set search_path = '': prevents hijacking
-- REVOKE from PUBLIC/anon/authenticated: only service role can call
-- =============================================================
CREATE OR REPLACE FUNCTION wm_admin.get_vault_secret(secret_name TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
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

CREATE OR REPLACE FUNCTION wm_admin.upsert_vault_secret(
  p_name        TEXT,
  p_secret      TEXT,
  p_description TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id UUID;
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
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT name, description, updated_at
  FROM vault.secrets
  ORDER BY name;
$$;

CREATE OR REPLACE FUNCTION wm_admin.delete_vault_secret(p_name TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
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

-- Explicitly revoke from all non-service roles (security-privileges)
REVOKE ALL ON FUNCTION wm_admin.get_vault_secret(TEXT)                FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION wm_admin.upsert_vault_secret(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION wm_admin.list_vault_secret_names()             FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION wm_admin.delete_vault_secret(TEXT)             FROM PUBLIC, anon, authenticated;

-- =============================================================
-- 12. verify_app_key RPC
-- Called by api/_api-key.js to replace WORLDMONITOR_VALID_KEYS.
-- Returns true if SHA-256 hex matches an active, non-revoked key.
-- Uses the partial index idx_app_keys_active for O(1) lookup.
-- =============================================================
CREATE OR REPLACE FUNCTION wm_admin.verify_app_key(p_key_hash TEXT)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM wm_admin.app_keys
    WHERE key_hash = p_key_hash
      AND enabled = true
      AND revoked_at IS NULL
  );
$$;

REVOKE ALL ON FUNCTION wm_admin.verify_app_key(TEXT) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- 13. updated_at triggers
-- =============================================================
CREATE OR REPLACE FUNCTION wm_admin.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_feature_flags_upd
  BEFORE UPDATE ON wm_admin.feature_flags
  FOR EACH ROW EXECUTE FUNCTION wm_admin.set_updated_at();

CREATE TRIGGER trg_news_sources_upd
  BEFORE UPDATE ON wm_admin.news_sources
  FOR EACH ROW EXECUTE FUNCTION wm_admin.set_updated_at();

CREATE TRIGGER trg_llm_providers_upd
  BEFORE UPDATE ON wm_admin.llm_providers
  FOR EACH ROW EXECUTE FUNCTION wm_admin.set_updated_at();

CREATE TRIGGER trg_llm_prompts_upd
  BEFORE UPDATE ON wm_admin.llm_prompts
  FOR EACH ROW EXECUTE FUNCTION wm_admin.set_updated_at();
