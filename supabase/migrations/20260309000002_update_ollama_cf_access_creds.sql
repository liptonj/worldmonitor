-- Update Cloudflare Access credentials for Ollama endpoint
-- Run this via Supabase SQL Editor after replacing the placeholder values with actual credentials

-- IMPORTANT: Replace these placeholder values with actual Cloudflare Access Service Token credentials
-- Get these from: Cloudflare Dashboard → Access → Service Auth → Service Tokens

DO $$
BEGIN
  -- Update OLLAMA_CF_ACCESS_CLIENT_ID
  UPDATE vault.secrets
  SET secret = 'YOUR_CF_ACCESS_CLIENT_ID_HERE'
  WHERE name = 'OLLAMA_CF_ACCESS_CLIENT_ID';

  -- Update OLLAMA_CF_ACCESS_CLIENT_SECRET
  UPDATE vault.secrets
  SET secret = 'YOUR_CF_ACCESS_CLIENT_SECRET_HERE'
  WHERE name = 'OLLAMA_CF_ACCESS_CLIENT_SECRET';

  RAISE NOTICE 'Cloudflare Access credentials updated. If you see empty strings in the output, make sure to replace the placeholders!';
END $$;

-- Verify the secrets were updated (this will show encrypted values, not the actual secrets)
SELECT name, description, created_at, updated_at
FROM vault.secrets
WHERE name IN ('OLLAMA_CF_ACCESS_CLIENT_ID', 'OLLAMA_CF_ACCESS_CLIENT_SECRET');
