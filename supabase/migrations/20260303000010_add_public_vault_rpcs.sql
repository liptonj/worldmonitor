-- Migration: Add public SECURITY DEFINER RPCs for Vault (secrets) operations
-- Purpose: Allow admin API routes to use the user's JWT for Vault operations
-- instead of the service role key. Each function verifies admin role before
-- delegating to the vault schema functions.
--
-- Security model:
--   - Functions are SECURITY DEFINER (run as postgres / function owner)
--   - Admin role is verified via public.get_my_admin_role() before any Vault access
--   - Only the 'authenticated' role is granted EXECUTE — anon is explicitly revoked
--   - Secret values are NEVER returned — only names and descriptions

-- ============================================================
-- LIST VAULT SECRET NAMES (names only, never values)
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_list_vault_secrets()
  RETURNS TABLE(name TEXT, description TEXT, updated_at TIMESTAMPTZ)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_role TEXT;
BEGIN
  SELECT public.get_my_admin_role() INTO v_role;
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'Access denied: not an admin user' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    SELECT s.name, s.description, s.updated_at
    FROM vault.secrets s
    ORDER BY s.name;
END;
$$;

-- ============================================================
-- UPSERT VAULT SECRET (create or update)
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_upsert_vault_secret(
  p_name        TEXT,
  p_secret      TEXT,
  p_description TEXT DEFAULT NULL
) RETURNS VOID
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_role TEXT;
  v_id   UUID;
BEGIN
  SELECT public.get_my_admin_role() INTO v_role;
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'Access denied: not an admin user' USING ERRCODE = '42501';
  END IF;

  SELECT id INTO v_id FROM vault.secrets WHERE name = p_name LIMIT 1;
  IF v_id IS NOT NULL THEN
    PERFORM vault.update_secret(v_id, p_secret, p_name, p_description);
  ELSE
    PERFORM vault.create_secret(p_secret, p_name, p_description);
  END IF;
END;
$$;

-- ============================================================
-- DELETE VAULT SECRET
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_delete_vault_secret(
  p_name TEXT
) RETURNS VOID
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_role TEXT;
  v_id   UUID;
BEGIN
  SELECT public.get_my_admin_role() INTO v_role;
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'Access denied: not an admin user' USING ERRCODE = '42501';
  END IF;

  SELECT id INTO v_id FROM vault.secrets WHERE name = p_name LIMIT 1;
  IF v_id IS NOT NULL THEN
    DELETE FROM vault.secrets WHERE id = v_id;
  END IF;
END;
$$;

-- Grant execute to authenticated role only
GRANT EXECUTE ON FUNCTION public.admin_list_vault_secrets()                      TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_upsert_vault_secret(TEXT, TEXT, TEXT)     TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_vault_secret(TEXT)                 TO authenticated;

-- Revoke from anon and public
REVOKE EXECUTE ON FUNCTION public.admin_list_vault_secrets()                     FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_upsert_vault_secret(TEXT, TEXT, TEXT)    FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_delete_vault_secret(TEXT)                FROM anon, PUBLIC;
