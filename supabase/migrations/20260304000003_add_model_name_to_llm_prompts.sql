-- =============================================================
-- Migration: Add model_name to llm_prompts and model-aware RPCs
--
-- Purpose:
--   1. Add model_name column to wm_admin.llm_prompts for model-specific
--      prompt overrides (e.g. Qwen3 vs GPT-4o-mini)
--   2. Replace old unique constraint with partial unique indexes that
--      correctly handle NULLs in model_name (generic vs model-specific rows)
--   3. Create get_llm_prompt RPC with 8-level model-aware cascade lookup
--   4. Update admin_insert_llm_prompt to accept p_model_name
--
-- Affected: wm_admin.llm_prompts, public.get_llm_prompt, public.admin_insert_llm_prompt
-- =============================================================

-- =============================================================
-- Part 1: Schema changes to wm_admin.llm_prompts
-- =============================================================

-- Add model_name column
alter table wm_admin.llm_prompts
  add column model_name text;

-- Drop old unique constraint (it does not handle NULLs in model_name correctly)
alter table wm_admin.llm_prompts
  drop constraint llm_prompts_prompt_key_variant_mode_key;

-- Uniqueness for rows WITH a model (coalesce handles NULLs)
create unique index idx_llm_prompts_model_unique
  on wm_admin.llm_prompts (
    prompt_key,
    coalesce(variant, ''),
    coalesce(mode, ''),
    model_name
  )
  where model_name is not null;

-- Uniqueness for rows WITHOUT a model (generic fallbacks)
create unique index idx_llm_prompts_generic_unique
  on wm_admin.llm_prompts (
    prompt_key,
    coalesce(variant, ''),
    coalesce(mode, '')
  )
  where model_name is null;

-- Update composite lookup index to include model_name
drop index if exists wm_admin.idx_llm_prompts_lookup;
create index idx_llm_prompts_lookup
  on wm_admin.llm_prompts (prompt_key, variant, mode, model_name);

-- =============================================================
-- Part 2: get_llm_prompt RPC (8-level model-aware cascade)
-- =============================================================

create or replace function public.get_llm_prompt(
  p_key     text,
  p_variant text default null,
  p_mode    text default null,
  p_model   text default null
)
returns table(system_prompt text, user_prompt text)
language sql stable security definer set search_path = ''
as $$
  select lp.system_prompt, lp.user_prompt
  from wm_admin.llm_prompts lp
  where lp.prompt_key = p_key
    and (lp.variant is not distinct from p_variant
         or lp.variant is null)
    and (lp.mode is not distinct from p_mode
         or lp.mode is null)
    and (lp.model_name is not distinct from p_model
         or lp.model_name is null)
  order by
    -- model specificity (model match > NULL)
    case when lp.model_name = p_model then 0
         when lp.model_name is null   then 1
         else 2 end,
    -- variant specificity
    case when lp.variant = p_variant then 0
         when lp.variant is null     then 1
         else 2 end,
    -- mode specificity
    case when lp.mode = p_mode then 0
         when lp.mode is null  then 1
         else 2 end
  limit 1;
$$;

grant execute on function public.get_llm_prompt(text, text, text, text) to anon;
grant execute on function public.get_llm_prompt(text, text, text, text) to authenticated;
revoke execute on function public.get_llm_prompt(text, text, text, text) from public;

-- =============================================================
-- Part 3: admin_insert_llm_prompt — add p_model_name parameter
-- =============================================================

create or replace function public.admin_insert_llm_prompt(
  p_prompt_key    text,
  p_system_prompt text,
  p_user_prompt   text    default null,
  p_variant       text    default null,
  p_mode          text    default null,
  p_description   text    default null,
  p_model_name    text    default null
)
returns wm_admin.llm_prompts
language plpgsql security definer set search_path = ''
as $$
declare
  v_role text;
  v_row  wm_admin.llm_prompts;
begin
  select public.get_my_admin_role() into v_role;
  if v_role is null then
    raise exception 'Access denied: not an admin user' using errcode = '42501';
  end if;

  insert into wm_admin.llm_prompts
    (prompt_key, system_prompt, user_prompt, variant, mode, description, model_name)
  values
    (p_prompt_key, p_system_prompt, p_user_prompt, p_variant, p_mode, p_description, p_model_name)
  returning * into v_row;

  return v_row;
end;
$$;

-- Re-grant for new signature (7 params)
grant execute on function public.admin_insert_llm_prompt(text, text, text, text, text, text, text) to authenticated;
revoke execute on function public.admin_insert_llm_prompt(text, text, text, text, text, text, text) from anon, public;
