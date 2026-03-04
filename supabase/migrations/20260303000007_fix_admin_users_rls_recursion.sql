-- Fix: Remove all recursive RLS policies on wm_admin.admin_users
--
-- Root cause: Multiple policies called functions (is_admin, is_superadmin via subquery)
-- that in turn queried admin_users, causing "infinite recursion detected in policy"
-- at the Postgres level. This means ANY query to admin_users as an authenticated user
-- would fail — including the requireAdmin() check that authenticates the admin portal.
--
-- Solution: Strict non-recursive policies only:
--   1. admin_users_self_read  — users can read their own row (user_id = auth.uid())
--      Simple equality check, no subquery, no recursion possible.
--   2. admin_users_superadmin_write — uses SECURITY DEFINER is_superadmin() function
--      which bypasses RLS internally (runs as function owner), breaking the recursion.

-- Drop all existing policies on admin_users
DROP POLICY IF EXISTS admins_read_admin_users        ON wm_admin.admin_users;
DROP POLICY IF EXISTS admin_users_self_read          ON wm_admin.admin_users;
DROP POLICY IF EXISTS admin_users_admins_read_all    ON wm_admin.admin_users;
DROP POLICY IF EXISTS superadmins_write_admin_users  ON wm_admin.admin_users;
DROP POLICY IF EXISTS admin_users_superadmin_write   ON wm_admin.admin_users;

-- Policy 1: Any authenticated user can read their OWN row
-- Non-recursive: simple equality, no subquery to admin_users
CREATE POLICY admin_users_self_read ON wm_admin.admin_users
  FOR SELECT
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- SECURITY DEFINER helper for superadmin write policy (breaks recursion)
CREATE OR REPLACE FUNCTION wm_admin.is_superadmin()
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM wm_admin.admin_users
    WHERE user_id = (SELECT auth.uid())
      AND role = 'superadmin'
  );
$$;

GRANT EXECUTE ON FUNCTION wm_admin.is_superadmin() TO authenticated;

-- Policy 2: Superadmins can manage all admin_users rows
-- Uses SECURITY DEFINER function which bypasses RLS internally (no recursion)
CREATE POLICY admin_users_superadmin_write ON wm_admin.admin_users
  FOR ALL
  TO authenticated
  USING (wm_admin.is_superadmin())
  WITH CHECK (wm_admin.is_superadmin());
