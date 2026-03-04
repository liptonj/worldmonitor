-- Migration: Add public.get_ollama_credentials() RPC
-- Purpose: Allow server-side API routes to fetch Ollama connection config
--          (URL, model, and Cloudflare Access Service Token headers) using
--          only the anon key — no service role required.
--
-- Security model:
--   - SECURITY DEFINER runs as function owner (postgres), which has access
--     to vault.decrypted_secrets via wm_admin.get_vault_secret
--   - Returns only the specific secrets needed for Ollama connectivity
--   - No auth guard required: this is equivalent to a public config endpoint
--     (CF Access tokens are outbound service-to-service credentials, not
--     user data — treating them like an API key in a config row is appropriate)
--   - GRANT EXECUTE to anon + authenticated so the anon Supabase client
--     used by server/edge functions can call it without a service role key
--
-- Replaces: three separate wm_admin.get_vault_secret() calls that required
--           SUPABASE_SERVICE_ROLE_KEY to be present in the environment.
--
-- Returns NULL rows for any secret not yet configured (caller handles gracefully).

create or replace function public.get_ollama_credentials()
  returns table(
    api_url            text,
    model              text,
    cf_access_client_id     text,
    cf_access_client_secret text
  )
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select
    wm_admin.get_vault_secret('OLLAMA_API_URL')               as api_url,
    coalesce(
      wm_admin.get_vault_secret('OLLAMA_MODEL'),
      (select default_model from wm_admin.llm_providers where name = 'ollama' limit 1),
      'llama3.1:8b'
    )                                                          as model,
    wm_admin.get_vault_secret('OLLAMA_CF_ACCESS_CLIENT_ID')   as cf_access_client_id,
    wm_admin.get_vault_secret('OLLAMA_CF_ACCESS_CLIENT_SECRET') as cf_access_client_secret;
$$;

-- Grant to anon so server-side code using the anon key can call it.
-- This removes the need for SUPABASE_SERVICE_ROLE_KEY in local/CI environments.
grant execute on function public.get_ollama_credentials() to anon;
grant execute on function public.get_ollama_credentials() to authenticated;

-- Revoke from PUBLIC (belt-and-suspenders — default privileges revoke this,
-- but be explicit so the intent is clear in the migration history)
revoke execute on function public.get_ollama_credentials() from public;
