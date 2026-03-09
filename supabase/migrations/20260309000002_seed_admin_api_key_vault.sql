-- Migration: Seed ADMIN_API_KEY into Supabase vault
-- Purpose: Admin portal /api/admin/admin-api-key fetches this for Cache Viewer
--          to authenticate with gateway /admin/cache/* endpoints.
--
-- IMPORTANT: This value must match services/.env.production ADMIN_API_KEY.
-- We use the same key as RELAY_SHARED_SECRET for consistency.
--
-- See docs/plans/2026-03-09-service-source-scheduling.md Task 7.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'ADMIN_API_KEY') THEN
    PERFORM vault.create_secret(
      '79bdb2dd86980f673c60ffc4aa299d32732c5e6fb07e7bba',
      'ADMIN_API_KEY',
      'API key for gateway /admin/cache/* endpoints. Matches RELAY_SHARED_SECRET for consistency.'
    );
  END IF;
END $$;
