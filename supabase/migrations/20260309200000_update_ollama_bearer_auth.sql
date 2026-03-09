-- Migration: Update get_ollama_credentials to use Bearer token instead of CF Access
-- Purpose: Replace Cloudflare Access Service Token authentication with Bearer token
--          for Ollama LiteLLM proxy endpoint at https://ollama.5ls.us/v1/
--
-- Changes:
--   - Replace cf_access_client_id and cf_access_client_secret columns with bearer_token
--   - Update function to fetch OLLAMA_BEARER_TOKEN from vault instead of CF Access creds
--   - Maintain backward compatibility by keeping function signature compatible
--
-- Security model remains unchanged:
--   - SECURITY DEFINER runs as postgres, accessing vault.decrypted_secrets
--   - Public RPC, no auth required (Bearer token is service-to-service credential)
--   - GRANT EXECUTE to anon + authenticated

-- Drop the old function
drop function if exists public.get_ollama_credentials();

-- Create updated function with bearer_token instead of CF Access credentials
create or replace function public.get_ollama_credentials()
  returns table(
    api_url      text,
    model        text,
    bearer_token text
  )
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select
    wm_admin.get_vault_secret('OLLAMA_API_URL')    as api_url,
    coalesce(
      wm_admin.get_vault_secret('OLLAMA_MODEL'),
      (select default_model from wm_admin.llm_providers where name = 'ollama' limit 1),
      'qwen/qwen3.5-9b'
    )                                              as model,
    wm_admin.get_vault_secret('OLLAMA_BEARER_TOKEN') as bearer_token;
$$;

-- Grant to anon so server-side code using the anon key can call it
grant execute on function public.get_ollama_credentials() to anon;
grant execute on function public.get_ollama_credentials() to authenticated;

-- Revoke from PUBLIC
revoke execute on function public.get_ollama_credentials() from public;

comment on function public.get_ollama_credentials() is 
  'Returns Ollama LiteLLM proxy credentials (URL, model, Bearer token). '
  'SECURITY DEFINER allows anon-key access without exposing vault secrets directly.';
