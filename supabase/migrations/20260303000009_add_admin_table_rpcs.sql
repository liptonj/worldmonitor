-- Migration: Add public SECURITY DEFINER RPCs for all wm_admin table operations
--
-- Purpose: PostgREST only exposes the 'public' schema by default.
-- Direct .schema('wm_admin') calls from admin API routes fail silently.
-- These SECURITY DEFINER functions run as the migration owner, bypassing
-- schema exposure restrictions while preserving user-level JWT authentication.

-- ============================================================
-- FEATURE FLAGS
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_get_feature_flags()
  RETURNS SETOF wm_admin.feature_flags
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT * FROM wm_admin.feature_flags ORDER BY category, key; $$;

CREATE OR REPLACE FUNCTION public.admin_upsert_feature_flag(
  p_key text, p_value jsonb, p_description text DEFAULT NULL
) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$
  INSERT INTO wm_admin.feature_flags (key, value, description)
  VALUES (p_key, p_value, p_description)
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value,
        description = COALESCE(EXCLUDED.description, wm_admin.feature_flags.description),
        updated_at = now();
$$;

-- ============================================================
-- NEWS SOURCES
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_get_news_sources(p_variant text DEFAULT NULL)
  RETURNS SETOF wm_admin.news_sources
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT * FROM wm_admin.news_sources
  WHERE (p_variant IS NULL OR p_variant = ANY(variants))
  ORDER BY tier, name;
$$;

CREATE OR REPLACE FUNCTION public.admin_insert_news_source(
  p_name text,
  p_url jsonb,
  p_tier int DEFAULT 2,
  p_category text DEFAULT NULL,
  p_source_type text DEFAULT 'rss',
  p_lang text DEFAULT 'en',
  p_proxy_mode text DEFAULT 'proxy',
  p_variants text[] DEFAULT ARRAY['full'],
  p_enabled boolean DEFAULT true,
  p_default_enabled boolean DEFAULT true,
  p_propaganda_risk text DEFAULT 'low',
  p_state_affiliated text DEFAULT 'no',
  p_propaganda_note text DEFAULT NULL
) RETURNS uuid
  LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$
  INSERT INTO wm_admin.news_sources
    (name, url, tier, category, source_type, lang, proxy_mode, variants,
     enabled, default_enabled, propaganda_risk, state_affiliated, propaganda_note)
  VALUES
    (p_name, p_url, p_tier, p_category, p_source_type, p_lang, p_proxy_mode, p_variants,
     p_enabled, p_default_enabled, p_propaganda_risk, p_state_affiliated, p_propaganda_note)
  RETURNING id;
$$;

CREATE OR REPLACE FUNCTION public.admin_update_news_source(p_id uuid, p_data jsonb)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  UPDATE wm_admin.news_sources SET
    name             = COALESCE(p_data->>'name', name),
    url              = COALESCE(p_data->'url', url),
    category         = COALESCE(p_data->>'category', category),
    tier             = COALESCE((p_data->>'tier')::int, tier),
    enabled          = COALESCE((p_data->>'enabled')::boolean, enabled),
    variants         = COALESCE(ARRAY(SELECT jsonb_array_elements_text(p_data->'variants')), variants),
    source_type      = COALESCE(p_data->>'source_type', source_type),
    lang             = COALESCE(p_data->>'lang', lang),
    proxy_mode       = COALESCE(p_data->>'proxy_mode', proxy_mode),
    propaganda_risk  = COALESCE(p_data->>'propaganda_risk', propaganda_risk),
    state_affiliated = COALESCE(p_data->>'state_affiliated', state_affiliated),
    propaganda_note  = COALESCE(p_data->>'propaganda_note', propaganda_note),
    default_enabled  = COALESCE((p_data->>'default_enabled')::boolean, default_enabled),
    updated_at       = now(),
    updated_by       = (SELECT auth.uid())
  WHERE id = p_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_delete_news_source(p_id uuid)
  RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$ DELETE FROM wm_admin.news_sources WHERE id = p_id; $$;

-- ============================================================
-- LLM PROVIDERS
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_get_llm_providers()
  RETURNS SETOF wm_admin.llm_providers
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT * FROM wm_admin.llm_providers ORDER BY priority; $$;

CREATE OR REPLACE FUNCTION public.admin_update_llm_provider(p_id uuid, p_data jsonb)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  UPDATE wm_admin.llm_providers SET
    name          = COALESCE(p_data->>'name', name),
    api_url       = COALESCE(p_data->>'api_url', api_url),
    default_model = COALESCE(p_data->>'default_model', default_model),
    priority      = COALESCE((p_data->>'priority')::int, priority),
    enabled       = COALESCE((p_data->>'enabled')::boolean, enabled),
    updated_at    = now()
  WHERE id = p_id;
END;
$$;

-- ============================================================
-- LLM PROMPTS
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_get_llm_prompts(p_key text DEFAULT NULL)
  RETURNS SETOF wm_admin.llm_prompts
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT * FROM wm_admin.llm_prompts
  WHERE (p_key IS NULL OR prompt_key = p_key)
  ORDER BY prompt_key, variant, mode;
$$;

CREATE OR REPLACE FUNCTION public.admin_get_llm_prompt_history(p_prompt_id uuid)
  RETURNS SETOF wm_admin.llm_prompt_history
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT * FROM wm_admin.llm_prompt_history
  WHERE prompt_id = p_prompt_id
  ORDER BY changed_at DESC LIMIT 20;
$$;

CREATE OR REPLACE FUNCTION public.admin_update_llm_prompt(
  p_id uuid, p_system_prompt text DEFAULT NULL, p_user_prompt text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  UPDATE wm_admin.llm_prompts SET
    system_prompt = COALESCE(p_system_prompt, system_prompt),
    user_prompt   = COALESCE(p_user_prompt, user_prompt),
    updated_at    = now()
  WHERE id = p_id;
END;
$$;

-- ============================================================
-- APP KEYS
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_get_app_keys()
  RETURNS TABLE(id uuid, description text, enabled boolean, created_at timestamptz, revoked_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT id, description, enabled, created_at, revoked_at FROM wm_admin.app_keys ORDER BY created_at DESC;
$$;

CREATE OR REPLACE FUNCTION public.admin_insert_app_key(p_key_hash text, p_description text DEFAULT NULL)
  RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$ INSERT INTO wm_admin.app_keys (key_hash, description) VALUES (p_key_hash, p_description); $$;

CREATE OR REPLACE FUNCTION public.admin_revoke_app_key(p_id uuid)
  RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$ UPDATE wm_admin.app_keys SET enabled = false, revoked_at = now() WHERE id = p_id; $$;

-- ============================================================
-- GRANT EXECUTE to authenticated role
-- ============================================================
GRANT EXECUTE ON FUNCTION public.admin_get_feature_flags() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_upsert_feature_flag(text, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_get_news_sources(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_insert_news_source(text,jsonb,int,text,text,text,text,text[],boolean,boolean,text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_update_news_source(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_news_source(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_get_llm_providers() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_update_llm_provider(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_get_llm_prompts(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_get_llm_prompt_history(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_update_llm_prompt(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_get_app_keys() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_insert_app_key(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_revoke_app_key(uuid) TO authenticated;
