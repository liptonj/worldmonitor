-- =============================================================
-- Migration: per-function LLM provider config + supporting RPCs
--
-- Purpose:
--   Allow admins to assign specific LLM providers to each AI function
--   with priority-based fallback chains. Each function (e.g. 'intel_digest',
--   'panel_summary') can have its own ordered list of providers to try.
--
--   Also adds get_all_enabled_providers() and get_llm_function_config()
--   RPCs for the relay server.
-- =============================================================

-- =============================================================
-- 1. llm_function_config table
-- =============================================================

create table if not exists wm_admin.llm_function_config (
  function_key     text        primary key,
  provider_chain   text[]      not null default '{ollama}',
  max_retries      integer     not null default 1 check (max_retries between 0 and 5),
  timeout_ms       integer     not null default 120000 check (timeout_ms between 5000 and 600000),
  description      text,
  updated_at       timestamptz not null default now(),
  updated_by       uuid        references auth.users(id) on delete set null
);

create index if not exists idx_llm_function_config_updated_by
  on wm_admin.llm_function_config (updated_by)
  where updated_by is not null;

alter table wm_admin.llm_function_config enable row level security;
alter table wm_admin.llm_function_config force row level security;

create policy "admins_all_llm_function_config"
  on wm_admin.llm_function_config for all
  using ((select wm_admin.is_admin()));

create trigger trg_llm_function_config_upd
  before update on wm_admin.llm_function_config
  for each row execute function wm_admin.set_updated_at();

-- Seed defaults
insert into wm_admin.llm_function_config (function_key, provider_chain, timeout_ms, description) values
  ('intel_digest',         '{ollama}',           120000, 'Global intelligence digest'),
  ('panel_summary',        '{ollama}',           180000, 'Full panel summary (two-model approach — Model A)'),
  ('panel_summary_arbiter','{ollama}',           120000, 'Panel summary arbiter/synthesizer'),
  ('news_summary',         '{ollama,groq}',       30000, 'Article summarization'),
  ('classify_event',       '{ollama,groq}',       15000, 'Event classification'),
  ('country_brief',        '{ollama}',            30000, 'Country intel briefs'),
  ('posture_analysis',     '{ollama}',            60000, 'Theater posture narrative'),
  ('instability_analysis', '{ollama}',            60000, 'Country instability narrative'),
  ('risk_overview',        '{ollama}',            60000, 'Strategic risk narrative'),
  ('deduction',            '{ollama,groq}',      120000, 'User-triggered deduction')
on conflict (function_key) do nothing;

-- =============================================================
-- 2. get_all_enabled_providers() RPC
-- =============================================================

create or replace function public.get_all_enabled_providers()
returns table(
  name                text,
  api_url             text,
  default_model       text,
  api_key_secret_name text,
  max_tokens          integer,
  max_tokens_summary  integer
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
    lp.api_key_secret_name,
    lp.max_tokens,
    lp.max_tokens_summary
  from wm_admin.llm_providers lp
  where lp.enabled = true
  order by lp.priority asc;
$$;

comment on function public.get_all_enabled_providers() is
  'Returns all enabled LLM providers ordered by priority. '
  'Used by relay server to build provider registry.';

grant execute on function public.get_all_enabled_providers() to anon;
grant execute on function public.get_all_enabled_providers() to authenticated;
revoke execute on function public.get_all_enabled_providers() from public;

-- =============================================================
-- 3. get_llm_function_config() RPC
-- =============================================================

create or replace function public.get_llm_function_config()
returns table(
  function_key   text,
  provider_chain text[],
  max_retries    integer,
  timeout_ms     integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    fc.function_key,
    fc.provider_chain,
    fc.max_retries,
    fc.timeout_ms
  from wm_admin.llm_function_config fc;
$$;

comment on function public.get_llm_function_config() is
  'Returns all per-function LLM provider assignments. '
  'Used by relay server to determine which providers to use for each AI function.';

grant execute on function public.get_llm_function_config() to anon;
grant execute on function public.get_llm_function_config() to authenticated;
revoke execute on function public.get_llm_function_config() from public;

-- =============================================================
-- 4. get_secret_value() RPC for resolving API keys from vault
-- =============================================================

create or replace function public.get_secret_value(p_name text)
returns table(decrypted_secret text)
language sql
stable
security definer
set search_path = ''
as $$
  select ds.decrypted_secret
  from vault.decrypted_secrets ds
  where ds.name = p_name
  limit 1;
$$;

comment on function public.get_secret_value(text) is
  'Resolves a single vault secret by name. Used by relay for provider API keys.';

grant execute on function public.get_secret_value(text) to anon;
revoke execute on function public.get_secret_value(text) from public;
