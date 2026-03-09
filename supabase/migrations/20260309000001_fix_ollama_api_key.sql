-- Migration: Fix Ollama API key configuration
-- 
-- The Ollama endpoint at https://ollama.5ls.us is protected by Cloudflare Access,
-- not a traditional API key. This migration:
--   1. Sets api_key_secret_name to NULL for the ollama provider (no API key needed)
--   2. Creates an OLLAMA_API_KEY vault secret with a dummy value as a fallback
--      (in case the code still tries to fetch it before we can update the code)

-- ============================================================
-- 1. Update llm_providers to not require an API key for Ollama
-- ============================================================
UPDATE wm_admin.llm_providers
SET 
  api_key_secret_name = NULL,
  updated_at = now()
WHERE name = 'ollama';

-- ============================================================
-- 2. Create OLLAMA_API_KEY vault secret as a dummy/no-op value
-- This prevents the "Could not resolve API key" error while
-- maintaining backward compatibility if code checks for the key
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'OLLAMA_API_KEY') THEN
    PERFORM vault.create_secret(
      'not-required',
      'OLLAMA_API_KEY',
      'Ollama does not require an API key (protected by Cloudflare Access). This is a no-op placeholder.'
    );
  END IF;
END $$;
