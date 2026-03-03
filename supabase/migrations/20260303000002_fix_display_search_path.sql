-- supabase/migrations/20260303000002_fix_display_search_path.sql
-- Fix function_search_path_mutable warnings: display + public schemas
-- Adds SET search_path = '' to all 24 affected functions.
-- All unqualified table references inside function bodies are fully qualified.

-- 1. display.update_updated_at (trigger: sets NEW.updated_at)
CREATE OR REPLACE FUNCTION display.update_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

-- 2. display.update_release_artifacts_updated_at (trigger: sets NEW.updated_at)
CREATE OR REPLACE FUNCTION display.update_release_artifacts_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;
