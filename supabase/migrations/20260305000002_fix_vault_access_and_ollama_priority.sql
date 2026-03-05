-- Migration: fix vault secret access from server-side code + set ollama as primary
--
-- Problem:
--   secrets.ts called wm_admin.get_vault_secret() via .schema('wm_admin').rpc(...)
--   but (a) PostgREST doesn't expose wm_admin schema and (b) service_role lacks
--   EXECUTE on that function. This caused silent fallback to env vars, which
--   broke LLM provider resolution on Vercel when API keys were only in Vault.
--
-- Fix:
--   Create public.get_vault_secret_value() — a SECURITY DEFINER wrapper in the
--   public schema that service_role can call via PostgREST. secrets.ts updated
--   to use this instead.
--
-- Also sets ollama as primary provider (priority 1) with groq as fallback.

-- 1. Public SECURITY DEFINER wrapper for vault access
create or replace function public.get_vault_secret_value(secret_name text)
returns text
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_secret text;
begin
  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where name = secret_name
  limit 1;
  return v_secret;
end;
$$;

grant execute on function public.get_vault_secret_value(text) to service_role;
revoke execute on function public.get_vault_secret_value(text) from public, anon, authenticated;

-- 2. Set ollama as primary (priority 1), groq as fallback (priority 2)
update wm_admin.llm_providers set priority = 1, updated_at = now() where name = 'ollama';
update wm_admin.llm_providers set priority = 2, updated_at = now() where name = 'groq';
update wm_admin.llm_providers set priority = 3, updated_at = now() where name = 'openrouter';
