-- =============================================================
-- Add per-source scheduling overrides to news_sources
--
-- Purpose: Allow per-source poll interval and cron overrides for
--          the admin scheduling system.
-- Affected: wm_admin.news_sources
-- Columns: poll_interval_minutes (INTEGER), custom_cron (TEXT)
-- Both nullable: NULL = inherit from tier default
-- =============================================================

ALTER TABLE wm_admin.news_sources
  ADD COLUMN IF NOT EXISTS poll_interval_minutes INTEGER,
  ADD COLUMN IF NOT EXISTS custom_cron TEXT;

COMMENT ON COLUMN wm_admin.news_sources.poll_interval_minutes
  IS 'Per-source poll interval override in minutes. NULL = inherit from tier default (T1=5, T2=15, T3=30, T4=60).';
COMMENT ON COLUMN wm_admin.news_sources.custom_cron
  IS 'Per-source cron expression override. Takes precedence over poll_interval_minutes if set.';
