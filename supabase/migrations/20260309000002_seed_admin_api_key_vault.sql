-- Migration: Seed ADMIN_API_KEY into Supabase vault
-- Purpose: Admin portal /api/admin/admin-api-key fetches this for Cache Viewer
--          to authenticate with gateway /admin/cache/* endpoints.
--
-- IMPORTANT: This value must match services/.env.production ADMIN_API_KEY.
-- For production: generate with `openssl rand -hex 32`, then update BOTH:
--   1. services/.env.production
--   2. Vault (admin portal Secrets page or: SELECT vault.create_secret('YOUR_KEY', 'ADMIN_API_KEY'))
--
-- See docs/plans/2026-03-09-service-source-scheduling.md Task 7.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'ADMIN_API_KEY') THEN
    PERFORM vault.create_secret(
      'changeme-generate-a-strong-random-key',
      'ADMIN_API_KEY',
      'API key for gateway /admin/cache/* endpoints. Must match services/.env.production ADMIN_API_KEY.'
    );
  END IF;
END $$;
