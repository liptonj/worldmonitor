-- =============================================================
-- Migration: Update DB-managed LLM prompts for Qwen3:14B
--
-- NOTE: This migration has been superseded by:
--   20260304000003_add_model_name_to_llm_prompts.sql (schema + RPCs)
--   20260304000004_update_llm_prompts_model_aware.sql (model-aware seeds)
--
-- The original content of this file appended /nothink and /think
-- directly to generic prompt rows. The new approach keeps generic
-- prompts model-agnostic and uses model_name-specific rows instead.
--
-- The new seeds in 000004 include a Step 1 that strips any /nothink
-- or /think that this migration may have previously appended, so
-- it is safe to run both this file (no-op below) and 000004.
-- =============================================================

-- intentional no-op: all changes moved to 000003 and 000004
select 1;
