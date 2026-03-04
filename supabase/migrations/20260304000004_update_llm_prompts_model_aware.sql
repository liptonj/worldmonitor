-- =============================================================
-- Migration: Update LLM prompts for Qwen3 model-specific overrides
--
-- Purpose:
--   Keep generic prompts model-agnostic. Add qwen3-wm specific rows
--   with /nothink (fast tasks) or /think (analytical tasks) instead
--   of modifying the shared prompts.
--
-- Prerequisite: Runs AFTER 20260304000003_add_model_name_to_llm_prompts.sql
--               (model_name column must exist)
--
-- Affected table: wm_admin.llm_prompts
-- =============================================================

-- =============================================================
-- Step 1: Remove /nothink from generic news_summary prompts
--         (undo any prior migration that appended it)
-- =============================================================

update wm_admin.llm_prompts
set system_prompt = trim(trailing ' /nothink' from system_prompt)
where prompt_key = 'news_summary'
  and model_name is null
  and system_prompt like '% /nothink';

-- =============================================================
-- Step 2: Clean up intel_brief generic prompt
--         (remove /think; keep {recentHeadlines} placeholder)
-- =============================================================

update wm_admin.llm_prompts
set
  system_prompt = 'You are a senior intelligence analyst providing comprehensive country situation briefs. Current date: {date}. Provide geopolitical context appropriate for the current date.

Write a concise intelligence brief for the requested country covering:
1. Current Situation - what is happening right now
2. Military & Security Posture
3. Key Risk Factors
4. Regional Context
5. Outlook & Watch Items

Rules:
- Be specific and analytical
- 4-5 paragraphs, 250-350 words
- No speculation beyond what data supports
- Use plain language, not jargon
- If a context snapshot is provided, explicitly reflect each non-zero signal category in the brief
- If recent headlines are provided, incorporate relevant ones into your analysis',
  user_prompt = 'Country: {countryName} ({countryCode})

{contextSnapshot}

{recentHeadlines}',
  description = 'Country intelligence brief. Placeholders: {date}, {countryName}, {countryCode}, {contextSnapshot}, {recentHeadlines}'
where prompt_key = 'intel_brief'
  and model_name is null;

-- =============================================================
-- Step 3: Clean up deduction generic prompt (remove /think)
--         Insert generic deduction if not present (e.g. fresh install)
-- =============================================================

update wm_admin.llm_prompts
set system_prompt = 'You are a senior geopolitical intelligence analyst and forecaster. Current date: {date}.
Your task is to DEDUCT the situation in a near timeline (e.g. 24 hours to a few months) based on the user''s query.
- Use any provided geographic or intelligence context.
- If recent headlines are provided, factor them into your analysis.
- Be highly analytical, pragmatic, and objective.
- Identify the most likely outcomes, timelines, and second-order impacts.
- Do NOT use typical AI preambles (e.g., "Here is the deduction", "Let me see").
- Format your response in clean markdown with concise bullet points where appropriate.'
where prompt_key = 'deduction'
  and model_name is null;

-- Ensure generic deduction exists (idempotent for fresh installs)
insert into wm_admin.llm_prompts (prompt_key, variant, mode, model_name, system_prompt, user_prompt, description)
select
  'deduction', null, null, null,
  'You are a senior geopolitical intelligence analyst and forecaster. Current date: {date}.
Your task is to DEDUCT the situation in a near timeline (e.g. 24 hours to a few months) based on the user''s query.
- Use any provided geographic or intelligence context.
- If recent headlines are provided, factor them into your analysis.
- Be highly analytical, pragmatic, and objective.
- Identify the most likely outcomes, timelines, and second-order impacts.
- Do NOT use typical AI preambles (e.g., "Here is the deduction", "Let me see").
- Format your response in clean markdown with concise bullet points where appropriate.',
  '{query}

{geoContext}

{recentHeadlines}',
  'Geopolitical deduction system prompt. Placeholders: {date}, {query}, {geoContext}, {recentHeadlines}'
where not exists (
  select 1 from wm_admin.llm_prompts
  where prompt_key = 'deduction' and variant is null and mode is null and model_name is null
);

-- =============================================================
-- Step 4: Add classify_event generic fallback (if not present)
-- =============================================================

insert into wm_admin.llm_prompts (prompt_key, variant, mode, model_name, system_prompt, user_prompt, description)
select
  'classify_event', null, null, null,
  'You classify news headlines into threat level and category. Return ONLY valid JSON, no other text.

Levels: critical, high, medium, low, info
Categories: conflict, protest, disaster, diplomatic, economic, terrorism, cyber, health, environmental, military, crime, infrastructure, tech, general

Focus: geopolitical events, conflicts, disasters, diplomacy. Classify by real-world severity and impact.

Return: {"level":"...","category":"..."}',
  '{title}',
  'Event classification prompt. Placeholders: {title}'
where not exists (
  select 1 from wm_admin.llm_prompts
  where prompt_key = 'classify_event' and variant is null and mode is null and model_name is null
);

-- =============================================================
-- Step 5: Add news_summary translate generic fallback (if not present)
-- =============================================================

insert into wm_admin.llm_prompts (prompt_key, variant, mode, model_name, system_prompt, user_prompt, description)
select
  'news_summary', null, 'translate', null,
  'You are a professional news translator. Translate the following news headlines/summaries into {targetLang}.
Rules:
- Maintain the original tone and journalistic style.
- Do NOT add any conversational filler (e.g., "Here is the translation").
- Output ONLY the translated text.
- If the text is already in {targetLang}, return it as is.',
  'Translate to {targetLang}:
{headlineText}',
  'Translation prompt. Placeholders: {targetLang}, {headlineText}'
where not exists (
  select 1 from wm_admin.llm_prompts
  where prompt_key = 'news_summary' and variant is null and mode = 'translate' and model_name is null
);

-- =============================================================
-- Step 6: Insert qwen3-wm overrides for news_summary
--         (append /nothink for fast summarization)
-- =============================================================

-- tech/brief
insert into wm_admin.llm_prompts (prompt_key, variant, mode, model_name, system_prompt, user_prompt, description)
select 'news_summary', 'tech', 'brief', 'qwen3-wm',
       lp.system_prompt || ' /nothink',
       lp.user_prompt,
       'Qwen3-wm override: tech brief with /nothink'
from wm_admin.llm_prompts lp
where lp.prompt_key = 'news_summary' and lp.variant = 'tech' and lp.mode = 'brief' and lp.model_name is null
  and not exists (
    select 1 from wm_admin.llm_prompts x
    where x.prompt_key = 'news_summary' and x.variant = 'tech' and x.mode = 'brief' and x.model_name = 'qwen3-wm'
  );

-- NULL/brief
insert into wm_admin.llm_prompts (prompt_key, variant, mode, model_name, system_prompt, user_prompt, description)
select 'news_summary', null, 'brief', 'qwen3-wm',
       lp.system_prompt || ' /nothink',
       lp.user_prompt,
       'Qwen3-wm override: brief with /nothink'
from wm_admin.llm_prompts lp
where lp.prompt_key = 'news_summary' and lp.variant is null and lp.mode = 'brief' and lp.model_name is null
  and not exists (
    select 1 from wm_admin.llm_prompts x
    where x.prompt_key = 'news_summary' and x.variant is null and x.mode = 'brief' and x.model_name = 'qwen3-wm'
  );

-- tech/analysis
insert into wm_admin.llm_prompts (prompt_key, variant, mode, model_name, system_prompt, user_prompt, description)
select 'news_summary', 'tech', 'analysis', 'qwen3-wm',
       lp.system_prompt || ' /nothink',
       lp.user_prompt,
       'Qwen3-wm override: tech analysis with /nothink'
from wm_admin.llm_prompts lp
where lp.prompt_key = 'news_summary' and lp.variant = 'tech' and lp.mode = 'analysis' and lp.model_name is null
  and not exists (
    select 1 from wm_admin.llm_prompts x
    where x.prompt_key = 'news_summary' and x.variant = 'tech' and x.mode = 'analysis' and x.model_name = 'qwen3-wm'
  );

-- NULL/analysis
insert into wm_admin.llm_prompts (prompt_key, variant, mode, model_name, system_prompt, user_prompt, description)
select 'news_summary', null, 'analysis', 'qwen3-wm',
       lp.system_prompt || ' /nothink',
       lp.user_prompt,
       'Qwen3-wm override: analysis with /nothink'
from wm_admin.llm_prompts lp
where lp.prompt_key = 'news_summary' and lp.variant is null and lp.mode = 'analysis' and lp.model_name is null
  and not exists (
    select 1 from wm_admin.llm_prompts x
    where x.prompt_key = 'news_summary' and x.variant is null and x.mode = 'analysis' and x.model_name = 'qwen3-wm'
  );

-- translate
insert into wm_admin.llm_prompts (prompt_key, variant, mode, model_name, system_prompt, user_prompt, description)
select 'news_summary', lp.variant, 'translate', 'qwen3-wm',
       lp.system_prompt || ' /nothink',
       lp.user_prompt,
       'Qwen3-wm override: translate with /nothink'
from wm_admin.llm_prompts lp
where lp.prompt_key = 'news_summary' and lp.mode = 'translate' and lp.model_name is null
  and not exists (
    select 1 from wm_admin.llm_prompts x
    where x.prompt_key = 'news_summary' and x.variant is null and x.mode = 'translate' and x.model_name = 'qwen3-wm'
  );

-- =============================================================
-- Step 7: Insert qwen3-wm overrides for intel_brief, deduction,
--         and classify_event
-- =============================================================

-- intel_brief (with /think for deep analysis)
insert into wm_admin.llm_prompts (prompt_key, variant, mode, model_name, system_prompt, user_prompt, description)
select 'intel_brief', null, null, 'qwen3-wm',
       lp.system_prompt || ' /think',
       lp.user_prompt,
       'Qwen3-wm override: intel brief with /think'
from wm_admin.llm_prompts lp
where lp.prompt_key = 'intel_brief' and lp.model_name is null
  and not exists (
    select 1 from wm_admin.llm_prompts x
    where x.prompt_key = 'intel_brief' and x.model_name = 'qwen3-wm'
  );

-- deduction (with /think)
insert into wm_admin.llm_prompts (prompt_key, variant, mode, model_name, system_prompt, user_prompt, description)
select 'deduction', null, null, 'qwen3-wm',
       lp.system_prompt || ' /think',
       lp.user_prompt,
       'Qwen3-wm override: deduction with /think'
from wm_admin.llm_prompts lp
where lp.prompt_key = 'deduction' and lp.model_name is null
  and not exists (
    select 1 from wm_admin.llm_prompts x
    where x.prompt_key = 'deduction' and x.model_name = 'qwen3-wm'
  );

-- classify_event (with /nothink)
insert into wm_admin.llm_prompts (prompt_key, variant, mode, model_name, system_prompt, user_prompt, description)
select 'classify_event', null, null, 'qwen3-wm',
       lp.system_prompt || ' /nothink',
       lp.user_prompt,
       'Qwen3-wm override: classify_event with /nothink'
from wm_admin.llm_prompts lp
where lp.prompt_key = 'classify_event' and lp.model_name is null
  and not exists (
    select 1 from wm_admin.llm_prompts x
    where x.prompt_key = 'classify_event' and x.model_name = 'qwen3-wm'
  );

-- =============================================================
-- Step 8: Add intel_digest rows (generic + qwen3-wm override)
-- =============================================================

-- generic fallback
insert into wm_admin.llm_prompts (prompt_key, variant, mode, model_name, system_prompt, user_prompt, description)
select
  'intel_digest', null, null, null,
  'You are a senior intelligence analyst producing a unified global situational assessment. Current date: {date}.

Synthesize the provided intelligence into a structured digest with exactly these 4 sections:

## Top Developments
Identify the 3-5 most significant items. Synthesize and contextualize — do not just repeat headlines.

## Active Threat Assessment
Based on event classification distribution, assess the current threat landscape. Note dominant threat categories and their severity.

## Emerging Patterns
Identify cross-cutting themes, escalation patterns, or convergences across different regions or domains.

## Watch Items (24-48h)
List 3-5 specific items to monitor in the next 24-48 hours based on current trajectories.

Rules:
- Be analytical and specific, not generic
- Draw connections across sources
- Use plain language
- No filler or AI preamble',
  'Date: {date}

Recent Headlines:
{recentHeadlines}

Event Classification Distribution:
{classificationSummary}

Country Signals:
{countrySignals}',
  'Global intelligence digest. Placeholders: {date}, {recentHeadlines}, {classificationSummary}, {countrySignals}'
where not exists (
  select 1 from wm_admin.llm_prompts
  where prompt_key = 'intel_digest' and variant is null and mode is null and model_name is null
);

-- qwen3-wm override (with /think)
insert into wm_admin.llm_prompts (prompt_key, variant, mode, model_name, system_prompt, user_prompt, description)
select 'intel_digest', null, null, 'qwen3-wm',
       lp.system_prompt || ' /think',
       lp.user_prompt,
       'Qwen3-wm override: intel digest with /think for deep analysis'
from wm_admin.llm_prompts lp
where lp.prompt_key = 'intel_digest' and lp.model_name is null
  and not exists (
    select 1 from wm_admin.llm_prompts x
    where x.prompt_key = 'intel_digest' and x.model_name = 'qwen3-wm'
  );

-- =============================================================
-- Step 9: Add view_summary rows (generic + qwen3-wm override)
-- =============================================================

-- generic fallback
insert into wm_admin.llm_prompts (prompt_key, variant, mode, model_name, system_prompt, user_prompt, description)
select
  'view_summary', null, null, null,
  'You are a geopolitical intelligence analyst reviewing a live dashboard. Synthesize the provided panel data into a concise executive briefing. Focus on cross-cutting themes, emergent patterns, and actionable insights. Use markdown formatting with clear sections.',
  'Date: {date}

Dashboard Panel Data:
{panelData}

Provide a structured synthesis covering:
## Key Developments
[Top 3-5 events across all panels]

## Cross-Panel Patterns
[Themes that appear across multiple panels]

## Risk Assessment
[Current threat/risk level with brief rationale]

## Watch Items
[2-3 things to monitor in the next 24-48 hours]',
  'Synthesizes all visible dashboard panels into an executive briefing'
where not exists (
  select 1 from wm_admin.llm_prompts
  where prompt_key = 'view_summary' and variant is null and mode is null and model_name is null
);

-- qwen3-wm override (user_prompt with /think appended)
insert into wm_admin.llm_prompts (prompt_key, variant, mode, model_name, system_prompt, user_prompt, description)
select 'view_summary', null, null, 'qwen3-wm',
       lp.system_prompt,
       lp.user_prompt || ' /think',
       'Qwen3-wm override: view summary with /think for analytical synthesis'
from wm_admin.llm_prompts lp
where lp.prompt_key = 'view_summary' and lp.model_name is null
  and not exists (
    select 1 from wm_admin.llm_prompts x
    where x.prompt_key = 'view_summary' and x.model_name = 'qwen3-wm'
  );
