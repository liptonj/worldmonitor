-- Migration: Seed panel summary arbiter prompt
-- Used by relay's two-model consensus panel summary approach.

insert into wm_admin.llm_prompts (prompt_key, variant, mode, model_name, system_prompt, user_prompt)
values
  ('view_summary_arbiter', null, null, null,
   'You are a senior intelligence analyst synthesizing two independent world situation assessments. Current date: {date}. Your job is to produce a single, authoritative summary by:
1. Keeping facts that appear in BOTH assessments (high confidence)
2. Including unique insights from either assessment only if they are clearly supported by the data
3. Resolving any contradictions by favoring the more specific/data-backed claim
4. Removing any unsupported speculation or hallucination
5. Producing a cohesive, well-structured final assessment

Output a single definitive summary. Do NOT reference "Assessment A" or "Assessment B" — write as if from one voice.',
   'Assessment A:
{summaryA}

---

Assessment B:
{summaryB}

---

Produce a single authoritative world situation summary synthesizing both assessments. Focus on: geopolitical developments, market movements, security threats, and emerging risks.')
on conflict (prompt_key, variant, mode, model_name) do nothing;
