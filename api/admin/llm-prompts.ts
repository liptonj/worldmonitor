// api/admin/llm-prompts.ts
import { requireAdmin, errorResponse, corsHeaders } from './_auth';
import { createServiceClient } from '../../server/_shared/supabase';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  const headers = corsHeaders();
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });

  try { await requireAdmin(req); } catch (err) { return errorResponse(err); }

  const supabase = createServiceClient();
  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  const key = url.searchParams.get('key');
  const showHistory = url.searchParams.get('history') === 'true';

  if (req.method === 'GET') {
    // Support ?id=UUID&history=true to return history for a specific prompt
    if (id && showHistory) {
      const { data, error } = await supabase
        .schema('wm_admin')
        .from('llm_prompt_history')
        .select('id, prompt_id, system_prompt, changed_by, changed_at')
        .eq('prompt_id', id)
        .order('changed_at', { ascending: false })
        .limit(20);

      if (error)
        return new Response(JSON.stringify({ error: 'Failed to load history' }), { status: 500, headers });
      return new Response(JSON.stringify(data), { status: 200, headers });
    }

    let query = supabase
      .schema('wm_admin')
      .from('llm_prompts')
      .select('*')
      .order('prompt_key')
      .order('variant')
      .order('mode');
    if (key) query = query.eq('prompt_key', key);
    const { data, error } = await query;
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    return new Response(JSON.stringify({ prompts: data }), { status: 200, headers });
  }

  if (req.method === 'PUT') {
    if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers });
    const body = (await req.json()) as { system_prompt?: string; user_prompt?: string };
    const { error } = await supabase
      .schema('wm_admin')
      .from('llm_prompts')
      .update({ system_prompt: body.system_prompt, user_prompt: body.user_prompt })
      .eq('id', id);
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
}
