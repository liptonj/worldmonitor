-- Migration: Add get_public_news_sources RPC
--
-- Purpose: The relay (ais-relay.cjs) calls supabase.rpc('get_public_news_sources')
-- to fetch all enabled news sources grouped by category. This function was created
-- manually on production but was never tracked in a local migration file.
-- This migration ensures local migrations match production state.
--
-- Affected: public.get_public_news_sources (callable by anon + authenticated)

create or replace function public.get_public_news_sources(p_variant text default 'full')
  returns table(
    name text,
    url jsonb,
    tier integer,
    variants text[],
    category text,
    source_type text,
    lang text,
    proxy_mode text,
    propaganda_risk text,
    state_affiliated text,
    propaganda_note text,
    default_enabled boolean
  )
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select
    ns.name,
    ns.url,
    ns.tier,
    ns.variants,
    ns.category,
    ns.source_type,
    ns.lang,
    ns.proxy_mode,
    ns.propaganda_risk,
    ns.state_affiliated,
    ns.propaganda_note,
    ns.default_enabled
  from wm_admin.news_sources ns
  where ns.enabled = true
    and ns.variants @> array[p_variant]
  order by ns.tier asc, ns.name asc;
$$;

-- Grant execute to anon (relay uses anon key) and authenticated
grant execute on function public.get_public_news_sources(text) to anon;
grant execute on function public.get_public_news_sources(text) to authenticated;
