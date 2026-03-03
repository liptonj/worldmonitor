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
