-- Add public.get_my_admin_role() RPC
--
-- PostgREST (Supabase JS client) can only query schemas listed in
-- pgrst.db_schemas. By default only 'public' is exposed.
-- Using .schema('wm_admin') from the JS client silently returns no rows
-- because wm_admin is not in the exposed schemas list.
--
-- Fix: create a SECURITY DEFINER RPC in the public schema that reads
-- wm_admin.admin_users internally (bypassing the schema exposure requirement)
-- and returns the caller's admin role.
--
-- requireAdmin() now calls rpc('get_my_admin_role') instead of
-- .schema('wm_admin').from('admin_users').

CREATE OR REPLACE FUNCTION public.get_my_admin_role()
  RETURNS text
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = ''
AS $$
  SELECT role::text
  FROM wm_admin.admin_users
  WHERE user_id = (SELECT auth.uid())
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_my_admin_role() TO authenticated;
