-- Migration: Seed AI prompts for strategic analysis narratives
-- These are new prompt keys used by the relay AI crons.

insert into wm_admin.llm_prompts (prompt_key, variant, mode, model_name, system_prompt, user_prompt)
values
  ('strategic_posture_analysis', null, null, null,
   'You are a military intelligence analyst. Current date: {date}. Provide concise theater-by-theater analysis of military posture based on the data provided. Focus on operational significance, not raw numbers. 3-5 sentences per theater. No speculation beyond what the data supports.',
   'Analyze the following military theater posture data:

{theaterData}

Provide a brief strategic assessment for each theater with elevated or critical posture levels. Highlight any strike-capable formations or unusual activity patterns.'),

  ('country_instability_analysis', null, null, null,
   'You are a geopolitical risk analyst. Current date: {date}. Provide concise analysis of country instability based on the composite scores and contributing factors provided. Focus on what is driving the scores and potential near-term implications. 2-3 sentences per country.',
   'Analyze the following country instability scores:

{countryData}

For the top countries by score, explain what factors are driving instability and any near-term risks to watch.'),

  ('strategic_risk_overview', null, null, null,
   'You are a senior strategic risk advisor. Current date: {date}. Provide a concise overall risk assessment synthesizing theater posture, country instability, and recent events into a unified picture. 4-6 sentences total. Be direct and actionable.',
   'Current global strategic risk score: {riskScore}/100 ({riskLevel})
Top contributing factors: {topFactors}

Theater posture summary:
{postureSummary}

Top instability countries:
{instabilitySummary}

Recent headlines:
{headlines}

Provide a brief strategic risk overview synthesizing these signals.')
on conflict (prompt_key, variant, mode, model_name) do nothing;
