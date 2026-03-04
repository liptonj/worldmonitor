-- Migration: add Ollama LLM provider row and seed Ollama config secrets into Vault
-- Secrets seeded here are safe defaults; override via admin portal Secrets page.

-- ============================================================
-- 1. Add Ollama to wm_admin.llm_providers
-- api_url is the base URL (no /v1/chat/completions suffix — server appends it)
-- api_key_secret_name = 'OLLAMA_API_KEY' (optional; omit if unauthenticated)
-- ============================================================
INSERT INTO wm_admin.llm_providers (name, api_url, default_model, priority, enabled, api_key_secret_name)
VALUES (
  'ollama',
  'https://ollama.5ls.us/v1',
  'qwen3-wm',
  3,
  true,
  'OLLAMA_API_KEY'
)
ON CONFLICT (name) DO UPDATE SET
  api_url     = EXCLUDED.api_url,
  default_model = EXCLUDED.default_model,
  updated_at  = now();

-- ============================================================
-- 2. Seed Ollama config secrets into Vault
-- These are non-sensitive config values stored as secrets so they
-- can be updated at runtime via the admin portal without redeploying.
-- vault.create_secret(secret, name, description)
-- ============================================================

DO $$
BEGIN
  -- OLLAMA_API_URL
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'OLLAMA_API_URL') THEN
    PERFORM vault.create_secret(
      'https://ollama.5ls.us/v1/',
      'OLLAMA_API_URL',
      'Base URL for the Ollama OpenAI-compatible API (include trailing slash)'
    );
  END IF;

  -- OLLAMA_MODEL
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'OLLAMA_MODEL') THEN
    PERFORM vault.create_secret(
      'qwen3-wm',
      'OLLAMA_MODEL',
      'Ollama model name — must be pulled on the Ollama server (e.g. qwen3-wm, llama3.1:8b)'
    );
  END IF;

  -- OLLAMA_MAX_TOKENS
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'OLLAMA_MAX_TOKENS') THEN
    PERFORM vault.create_secret(
      '3000',
      'OLLAMA_MAX_TOKENS',
      'Max tokens for Ollama completions — thinking models (qwen3-wm, deepseek-r1) need 1000+ to leave room for the answer after reasoning'
    );
  END IF;

  -- OLLAMA_CF_ACCESS_CLIENT_ID (Cloudflare Access service token — set via admin portal)
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'OLLAMA_CF_ACCESS_CLIENT_ID') THEN
    PERFORM vault.create_secret(
      '',
      'OLLAMA_CF_ACCESS_CLIENT_ID',
      'Cloudflare Access Service Token Client ID for Ollama endpoint auth'
    );
  END IF;

  -- OLLAMA_CF_ACCESS_CLIENT_SECRET (Cloudflare Access service token — set via admin portal)
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'OLLAMA_CF_ACCESS_CLIENT_SECRET') THEN
    PERFORM vault.create_secret(
      '',
      'OLLAMA_CF_ACCESS_CLIENT_SECRET',
      'Cloudflare Access Service Token Client Secret for Ollama endpoint auth'
    );
  END IF;
END $$;
