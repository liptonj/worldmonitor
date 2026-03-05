-- Migration: create public.get_active_llm_provider() RPC
--
-- Purpose:
--   The server-side LLM resolution code (server/_shared/llm.ts) calls
--   supabase.rpc('get_active_llm_provider') via the anon client to fetch the
--   highest-priority enabled provider.  This function was never created,
--   causing every call to silently fail and return no provider — which breaks
--   Summarize View, Deduct Situation, Country Intel Briefs, and Global Digest.
--
-- Affected: wm_admin.llm_providers (read-only)
-- Callable by: anon, authenticated
-- =============================================================

-- =============================================================
-- 1. Create the RPC function
-- =============================================================

create or replace function public.get_active_llm_provider()
returns table(
  name                text,
  api_url             text,
  default_model       text,
  api_key_secret_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    lp.name,
    lp.api_url,
    lp.default_model,
    lp.api_key_secret_name
  from wm_admin.llm_providers lp
  where lp.enabled = true
  order by lp.priority asc
  limit 1;
$$;

comment on function public.get_active_llm_provider() is
  'Returns the highest-priority enabled LLM provider row. '
  'Called by server-side edge functions via the anon Supabase client.';

-- =============================================================
-- 2. Grant access — anon needs this for server-side edge calls
-- =============================================================

grant execute on function public.get_active_llm_provider() to anon;
grant execute on function public.get_active_llm_provider() to authenticated;
revoke execute on function public.get_active_llm_provider() from public;

-- =============================================================
-- 3. Seed OLLAMA_API_KEY vault secret
--
-- The getActiveLlmProvider() code resolves api_key_secret_name via
-- getSecret(), which checks Vault then env.  Ollama uses CF Access
-- headers (not API keys) for auth, but the code path requires a
-- non-empty API key to proceed.  Seed a placeholder so the Ollama
-- provider doesn't get skipped.
-- =============================================================

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'OLLAMA_API_KEY') then
    perform vault.create_secret(
      'ollama',
      'OLLAMA_API_KEY',
      'Placeholder API key for Ollama — actual auth uses CF Access headers'
    );
  end if;
end $$;
