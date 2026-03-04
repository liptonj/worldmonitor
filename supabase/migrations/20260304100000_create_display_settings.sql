-- Migration: Create display_settings table for system-wide display defaults
--
-- Purpose: Store admin-configurable defaults for time format (24h/12h),
-- timezone mode (utc/local), and temperature unit (celsius/fahrenheit).
-- Single-row table in wm_admin schema.
--
-- Affected: wm_admin.display_settings (new table)
-- New RPCs: public.get_display_settings(), public.admin_update_display_settings()

-- ============================================================
-- 1. Create display_settings table (single-row)
-- ============================================================
create table wm_admin.display_settings (
  id            int primary key default 1 check (id = 1),
  time_format   text not null default '24h' check (time_format in ('24h', '12h')),
  timezone_mode text not null default 'utc' check (timezone_mode in ('utc', 'local')),
  temp_unit     text not null default 'celsius' check (temp_unit in ('celsius', 'fahrenheit')),
  updated_at    timestamptz not null default now()
);

comment on table wm_admin.display_settings is 'System-wide display defaults (time format, timezone, temp unit). Single row.';

-- ============================================================
-- 2. Seed the single row
-- ============================================================
insert into wm_admin.display_settings (id)
values (1)
on conflict (id) do nothing;

-- ============================================================
-- 3. Auto-update trigger for updated_at
-- ============================================================
create trigger trg_display_settings_upd
  before update on wm_admin.display_settings
  for each row execute function wm_admin.set_updated_at();

-- ============================================================
-- 4. RLS
-- ============================================================
alter table wm_admin.display_settings enable row level security;
alter table wm_admin.display_settings force row level security;

-- Admin tables: full access for admins (SECURITY DEFINER RPCs bypass RLS)
create policy "admins_all_display_settings"
  on wm_admin.display_settings for all
  using ((select wm_admin.is_admin()));

-- ============================================================
-- 5. Public RPC: get_display_settings (no auth required)
-- Returns JSON with time_format, timezone_mode, temp_unit.
-- Non-sensitive defaults; callable by anon and authenticated.
-- ============================================================
create or replace function public.get_display_settings()
returns json
language sql
stable
security definer
set search_path = ''
as $$
  select json_build_object(
    'time_format', time_format,
    'timezone_mode', timezone_mode,
    'temp_unit', temp_unit
  )
  from wm_admin.display_settings
  where id = 1;
$$;

grant execute on function public.get_display_settings() to anon, authenticated;

-- ============================================================
-- 6. Public RPC: admin_update_display_settings (admin only)
-- Updates only non-null params. Auth guard via get_my_admin_role().
-- ============================================================
create or replace function public.admin_update_display_settings(
  p_time_format   text default null,
  p_timezone_mode text default null,
  p_temp_unit     text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Auth guard: only admins can update
  if (select public.get_my_admin_role()) is null then
    raise exception 'Access denied: admin role required' using errcode = '42501';
  end if;

  update wm_admin.display_settings set
    time_format   = coalesce(p_time_format, time_format),
    timezone_mode = coalesce(p_timezone_mode, timezone_mode),
    temp_unit     = coalesce(p_temp_unit, temp_unit)
  where id = 1;
end;
$$;

grant execute on function public.admin_update_display_settings(text, text, text) to authenticated;
revoke execute on function public.admin_update_display_settings(text, text, text) from anon, public;
