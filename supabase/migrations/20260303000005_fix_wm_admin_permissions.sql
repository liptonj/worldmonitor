-- Fix: Grant schema USAGE and table permissions to authenticated role
-- Without this, authenticated users get a permission denied error before
-- RLS policies even run, which is why admin login fails with 403.
--
-- Root cause: wm_admin schema had no USAGE grant for authenticated, so
-- all table/function access was blocked at the schema level before RLS
-- policies were evaluated.

-- 1. Allow authenticated users to see into the wm_admin schema
GRANT USAGE ON SCHEMA wm_admin TO authenticated;

-- 2. Grant table-level permissions — RLS policies control what rows are visible
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA wm_admin TO authenticated;

-- 3. Ensure future tables also get permissions
ALTER DEFAULT PRIVILEGES IN SCHEMA wm_admin
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;

-- 4. Grant EXECUTE on is_admin() so RLS policies can call it
GRANT EXECUTE ON FUNCTION wm_admin.is_admin() TO authenticated;

-- 5. Grant verify_app_key to anon (used by the API key validation path)
GRANT EXECUTE ON FUNCTION wm_admin.verify_app_key(text) TO anon, authenticated;
