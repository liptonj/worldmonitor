-- Fix: Circular RLS policy on wm_admin.admin_users
--
-- Root cause: The 'admins_read_admin_users' policy used wm_admin.is_admin() as
-- its USING clause. is_admin() queries admin_users (bypassing RLS via SECURITY
-- DEFINER), but the outer query by the user-scoped client is still blocked by
-- RLS until the policy allows it — creating a bootstrapping deadlock where a
-- user can never read their own row to prove they're an admin.
--
-- Fix: Split into two policies:
--   1. admin_users_self_read  — any authenticated user can read their OWN row
--      (needed for requireAdmin() to verify the caller's role)
--   2. admin_users_admins_read_all — admins can read ALL rows
--      (needed for admin management UI)

DROP POLICY IF EXISTS admins_read_admin_users ON wm_admin.admin_users;

-- Allow any authenticated user to see their own admin_users row
CREATE POLICY admin_users_self_read ON wm_admin.admin_users
  FOR SELECT
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- Allow admins to see all admin_users rows (for admin management UI)
CREATE POLICY admin_users_admins_read_all ON wm_admin.admin_users
  FOR SELECT
  TO authenticated
  USING (wm_admin.is_admin());
