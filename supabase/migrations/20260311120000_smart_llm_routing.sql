-- =============================================================
-- Migration: Smart LLM Routing
--
-- Purpose:
--   Add rate-limit metadata and complexity-awareness to LLM
--   provider routing. Providers gain RPM/TPM limits, context
--   window size, and a complexity cap. Functions gain a
--   complexity tier so the routing layer can skip providers
--   that cannot handle the task.
--
-- Affected tables:
--   wm_admin.llm_providers       – 4 new columns
--   wm_admin.llm_function_config – 1 new column
--
-- Affected RPCs:
--   public.get_all_enabled_providers() – returns new columns
--   public.get_llm_function_config()   – returns new column
-- =============================================================

-- =============================================================
-- 1. Add columns to wm_admin.llm_providers
-- =============================================================

alter table wm_admin.llm_providers
  add column if not exists requests_per_minute integer not null default 60,
  add column if not exists tokens_per_minute   integer not null default 0,
  add column if not exists context_window      integer not null default 8192,
  add column if not exists complexity_cap      text    not null default 'heavy'
    check (complexity_cap in ('light', 'medium', 'heavy'));

comment on column wm_admin.llm_providers.requests_per_minute is
  'Max requests per minute this provider allows. Used for client-side rate limiting.';

comment on column wm_admin.llm_providers.tokens_per_minute is
  'Max tokens per minute this provider allows. 0 = unlimited.';

comment on column wm_admin.llm_providers.context_window is
  'Max input tokens the provider model supports. Used to skip providers when prompt is too large.';

comment on column wm_admin.llm_providers.complexity_cap is
  'Max complexity tier this provider should handle: light, medium, heavy. '
  'Ollama should be medium for local models; cloud providers should be heavy.';

-- Seed known provider limits
update wm_admin.llm_providers
set
  requests_per_minute = 60,
  tokens_per_minute   = 0,
  context_window      = 8192,
  complexity_cap      = 'medium',
  updated_at          = now()
where name = 'ollama';

update wm_admin.llm_providers
set
  requests_per_minute = 30,
  tokens_per_minute   = 15000,
  context_window      = 32768,
  complexity_cap      = 'heavy',
  updated_at          = now()
where name = 'groq';

update wm_admin.llm_providers
set
  requests_per_minute = 60,
  tokens_per_minute   = 0,
  context_window      = 32768,
  complexity_cap      = 'heavy',
  updated_at          = now()
where name = 'openrouter';

-- =============================================================
-- 2. Add complexity column to wm_admin.llm_function_config
-- =============================================================

alter table wm_admin.llm_function_config
  add column if not exists complexity text not null default 'medium'
    check (complexity in ('light', 'medium', 'heavy'));

comment on column wm_admin.llm_function_config.complexity is
  'Task complexity tier: light (classify, short summary), '
  'medium (channel summary, country brief), '
  'heavy (intel digest, cross-channel, posture analysis).';

-- Seed complexity values for existing functions
update wm_admin.llm_function_config set complexity = 'light'  where function_key in ('classify_event', 'news_summary');
update wm_admin.llm_function_config set complexity = 'medium' where function_key in ('telegram_channel_summary', 'country_brief');
update wm_admin.llm_function_config set complexity = 'heavy'  where function_key in ('intel_digest', 'telegram_cross_channel', 'panel_summary', 'panel_summary_arbiter', 'posture_analysis', 'instability_analysis', 'risk_overview', 'deduction');

-- =============================================================
-- 3. Update provider chains: heavy tasks should prefer cloud
-- =============================================================

-- Heavy tasks: put groq first, ollama as last-resort fallback
update wm_admin.llm_function_config
set provider_chain = '{groq,openrouter,ollama}', updated_at = now()
where complexity = 'heavy' and provider_chain = '{ollama}';

-- =============================================================
-- 4. Update get_all_enabled_providers() to return new columns
-- =============================================================

create or replace function public.get_all_enabled_providers()
returns table(
  name                  text,
  api_url               text,
  default_model         text,
  api_key_secret_name   text,
  max_tokens            integer,
  max_tokens_summary    integer,
  requests_per_minute   integer,
  tokens_per_minute     integer,
  context_window        integer,
  complexity_cap        text
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
    lp.max_tokens_summary,
    lp.requests_per_minute,
    lp.tokens_per_minute,
    lp.context_window,
    lp.complexity_cap
  from wm_admin.llm_providers lp
  where lp.enabled = true
  order by lp.priority asc;
$$;

comment on function public.get_all_enabled_providers() is
  'Returns all enabled LLM providers with rate limits and capabilities, ordered by priority.';

grant execute on function public.get_all_enabled_providers() to anon;
grant execute on function public.get_all_enabled_providers() to authenticated;
revoke execute on function public.get_all_enabled_providers() from public;

-- =============================================================
-- 5. Update get_llm_function_config() to return complexity
-- =============================================================

create or replace function public.get_llm_function_config()
returns table(
  function_key   text,
  provider_chain text[],
  max_retries    integer,
  timeout_ms     integer,
  complexity     text
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
    fc.timeout_ms,
    fc.complexity
  from wm_admin.llm_function_config fc;
$$;

comment on function public.get_llm_function_config() is
  'Returns all per-function LLM provider assignments with complexity tiers.';

grant execute on function public.get_llm_function_config() to anon;
grant execute on function public.get_llm_function_config() to authenticated;
revoke execute on function public.get_llm_function_config() from public;

-- =============================================================
-- 6. Update admin_update_llm_provider() to handle new columns
-- =============================================================

create or replace function public.admin_update_llm_provider(p_id uuid, p_data jsonb)
  returns void language plpgsql security definer set search_path = ''
as $$
begin
  update wm_admin.llm_providers set
    name                = coalesce(p_data->>'name', name),
    api_url             = coalesce(p_data->>'api_url', api_url),
    default_model       = coalesce(p_data->>'default_model', default_model),
    priority            = coalesce((p_data->>'priority')::int, priority),
    enabled             = coalesce((p_data->>'enabled')::boolean, enabled),
    requests_per_minute = coalesce((p_data->>'requests_per_minute')::int, requests_per_minute),
    tokens_per_minute   = coalesce((p_data->>'tokens_per_minute')::int, tokens_per_minute),
    context_window      = coalesce((p_data->>'context_window')::int, context_window),
    complexity_cap      = coalesce(p_data->>'complexity_cap', complexity_cap),
    updated_at          = now()
  where id = p_id;
end;
$$;

-- =============================================================
-- 7. Replace admin_insert_llm_provider() with new columns
--    Drop the old 6-param overload and create a 10-param version.
-- =============================================================

drop function if exists public.admin_insert_llm_provider(text, text, text, text, int, boolean);

create or replace function public.admin_insert_llm_provider(
  p_name                text,
  p_api_url             text,
  p_default_model       text,
  p_api_key_secret_name text,
  p_priority            int     default 10,
  p_enabled             boolean default true,
  p_requests_per_minute int     default 60,
  p_tokens_per_minute   int     default 0,
  p_context_window      int     default 8192,
  p_complexity_cap      text    default 'heavy'
) returns wm_admin.llm_providers
  language plpgsql security definer set search_path = ''
as $$
declare
  v_role text;
  v_row  wm_admin.llm_providers;
begin
  select public.get_my_admin_role() into v_role;
  if v_role is null then
    raise exception 'Access denied: not an admin user' using errcode = '42501';
  end if;

  insert into wm_admin.llm_providers (
    name, api_url, default_model, api_key_secret_name, priority, enabled,
    requests_per_minute, tokens_per_minute, context_window, complexity_cap
  ) values (
    p_name, p_api_url, p_default_model, p_api_key_secret_name, p_priority, p_enabled,
    p_requests_per_minute, p_tokens_per_minute, p_context_window, p_complexity_cap
  )
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.admin_insert_llm_provider(text, text, text, text, int, boolean, int, int, int, text) to authenticated;
revoke execute on function public.admin_insert_llm_provider(text, text, text, text, int, boolean, int, int, int, text) from anon, public;
