-- Migration: add max_tokens and max_tokens_summary columns to wm_admin.llm_providers
-- These are plain config values — not secrets — so they belong in the DB, not Vault.
-- max_tokens:         used by intelligence tasks (deduction, country briefs) — needs ~1000+
-- max_tokens_summary: used by news summarization — should stay low (~400) to avoid timeouts

-- ============================================================
-- 1. Add columns to wm_admin.llm_providers
-- ============================================================

alter table wm_admin.llm_providers
  add column if not exists max_tokens         integer not null default 3000,
  add column if not exists max_tokens_summary integer not null default 400;

comment on column wm_admin.llm_providers.max_tokens is
  'Max output tokens for intelligence tasks (deduction, country briefs). Thinking models like qwen3 need 1000+ to fit the answer after internal reasoning.';

comment on column wm_admin.llm_providers.max_tokens_summary is
  'Max output tokens for news summarization. Keep low (~400) — a 3-sentence brief is ~150 tokens and large models (qwen3:14b) timeout at ~60 s with higher values.';

-- ============================================================
-- 2. Seed values for the ollama provider
-- ============================================================

update wm_admin.llm_providers
set
  max_tokens         = 3000,
  max_tokens_summary = 400,
  updated_at         = now()
where name = 'ollama';

-- ============================================================
-- 3. Replace get_ollama_credentials() to include token limits
-- ============================================================

drop function if exists public.get_ollama_credentials();

create function public.get_ollama_credentials()
returns table(
  api_url                 text,
  model                   text,
  cf_access_client_id     text,
  cf_access_client_secret text,
  max_tokens              integer,
  max_tokens_summary      integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    wm_admin.get_vault_secret('OLLAMA_API_URL')                 as api_url,
    coalesce(
      wm_admin.get_vault_secret('OLLAMA_MODEL'),
      (select default_model from wm_admin.llm_providers where name = 'ollama' limit 1),
      'llama3.1:8b'
    )                                                            as model,
    wm_admin.get_vault_secret('OLLAMA_CF_ACCESS_CLIENT_ID')     as cf_access_client_id,
    wm_admin.get_vault_secret('OLLAMA_CF_ACCESS_CLIENT_SECRET') as cf_access_client_secret,
    coalesce(
      (select p.max_tokens from wm_admin.llm_providers p where p.name = 'ollama' limit 1),
      3000
    )                                                            as max_tokens,
    coalesce(
      (select p.max_tokens_summary from wm_admin.llm_providers p where p.name = 'ollama' limit 1),
      400
    )                                                            as max_tokens_summary;
$$;

-- ============================================================
-- 4. Remove the OLLAMA_MAX_TOKENS_SUMMARY Vault secret —
--    it was added in error; config values live in the DB.
--    OLLAMA_MAX_TOKENS stays in Vault for now as it was
--    pre-existing; the DB column takes precedence in code.
-- ============================================================

delete from vault.secrets where name = 'OLLAMA_MAX_TOKENS_SUMMARY';
