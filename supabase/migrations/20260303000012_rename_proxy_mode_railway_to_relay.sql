-- Migration: Rename proxy_mode value 'railway' -> 'relay' in news_sources
-- The relay is now self-hosted at relay.5ls.us, not on Railway.

-- 1. Update existing rows
UPDATE wm_admin.news_sources SET proxy_mode = 'relay' WHERE proxy_mode = 'railway';

-- 2. Drop old constraint
ALTER TABLE wm_admin.news_sources
  DROP CONSTRAINT IF EXISTS news_sources_proxy_mode_check;

-- 3. Add new constraint with 'relay' instead of 'railway'
ALTER TABLE wm_admin.news_sources
  ADD CONSTRAINT news_sources_proxy_mode_check
    CHECK (proxy_mode IN ('rss', 'relay', 'direct'));
