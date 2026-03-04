-- Migration: Add public SECURITY DEFINER RPCs for inserting/deleting LLM providers and prompts
-- Follows the same pattern as migration 20260303000009: SECURITY DEFINER wrappers in public schema
-- that verify admin role before delegating to wm_admin tables.

-- ============================================================
-- INSERT LLM PROVIDER
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_insert_llm_provider(
  p_name               TEXT,
  p_api_url            TEXT,
  p_default_model      TEXT,
  p_api_key_secret_name TEXT,
  p_priority           INT     DEFAULT 10,
  p_enabled            BOOLEAN DEFAULT true
) RETURNS wm_admin.llm_providers
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_role TEXT;
  v_row  wm_admin.llm_providers;
BEGIN
  SELECT public.get_my_admin_role() INTO v_role;
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'Access denied: not an admin user' USING ERRCODE = '42501';
  END IF;

  INSERT INTO wm_admin.llm_providers (name, api_url, default_model, api_key_secret_name, priority, enabled)
  VALUES (p_name, p_api_url, p_default_model, p_api_key_secret_name, p_priority, p_enabled)
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

-- ============================================================
-- DELETE LLM PROVIDER
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_delete_llm_provider(p_id UUID)
  RETURNS VOID
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_role TEXT;
BEGIN
  SELECT public.get_my_admin_role() INTO v_role;
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'Access denied: not an admin user' USING ERRCODE = '42501';
  END IF;

  DELETE FROM wm_admin.llm_providers WHERE id = p_id;
END;
$$;

-- ============================================================
-- INSERT LLM PROMPT
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_insert_llm_prompt(
  p_prompt_key    TEXT,
  p_system_prompt TEXT,
  p_user_prompt   TEXT    DEFAULT NULL,
  p_variant       TEXT    DEFAULT NULL,
  p_mode          TEXT    DEFAULT NULL,
  p_description   TEXT    DEFAULT NULL
) RETURNS wm_admin.llm_prompts
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_role TEXT;
  v_row  wm_admin.llm_prompts;
BEGIN
  SELECT public.get_my_admin_role() INTO v_role;
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'Access denied: not an admin user' USING ERRCODE = '42501';
  END IF;

  INSERT INTO wm_admin.llm_prompts (prompt_key, system_prompt, user_prompt, variant, mode, description)
  VALUES (p_prompt_key, p_system_prompt, p_user_prompt, p_variant, p_mode, p_description)
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

-- ============================================================
-- DELETE LLM PROMPT
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_delete_llm_prompt(p_id UUID)
  RETURNS VOID
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_role TEXT;
BEGIN
  SELECT public.get_my_admin_role() INTO v_role;
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'Access denied: not an admin user' USING ERRCODE = '42501';
  END IF;

  DELETE FROM wm_admin.llm_prompts WHERE id = p_id;
END;
$$;

-- Grants
GRANT EXECUTE ON FUNCTION public.admin_insert_llm_provider(TEXT, TEXT, TEXT, TEXT, INT, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_llm_provider(UUID)                                 TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_insert_llm_prompt(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT)     TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_llm_prompt(UUID)                                   TO authenticated;

REVOKE EXECUTE ON FUNCTION public.admin_insert_llm_provider(TEXT, TEXT, TEXT, TEXT, INT, BOOLEAN) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_delete_llm_provider(UUID)                                 FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_insert_llm_prompt(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT)     FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_delete_llm_prompt(UUID)                                   FROM anon, PUBLIC;
