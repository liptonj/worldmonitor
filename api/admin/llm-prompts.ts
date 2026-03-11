// api/admin/llm-prompts.ts
import { requireAdmin, errorResponse, corsHeaders } from './_auth';
import { invalidateLlmCache } from '../../server/_shared/llm';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  const headers = corsHeaders();
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });

  let admin;
  try { admin = await requireAdmin(req); } catch (err) { return errorResponse(err); }

  const { client } = admin;
  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  const key = url.searchParams.get('key');
  const showHistory = url.searchParams.get('history') === 'true';

  if (req.method === 'GET') {
    if (id && showHistory) {
      const { data, error } = await client.rpc('admin_get_llm_prompt_history', { p_prompt_id: id });
      if (error)
        return new Response(JSON.stringify({ error: 'Failed to load history' }), { status: 500, headers });
      return new Response(JSON.stringify(data), { status: 200, headers });
    }

    const { data, error } = await client.rpc('admin_get_llm_prompts', { p_key: key ?? null });
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    return new Response(JSON.stringify({ prompts: data }), { status: 200, headers });
  }

  if (req.method === 'POST') {
    const body = (await req.json()) as {
      prompt_key: string; system_prompt: string; user_prompt?: string;
      variant?: string; mode?: string; description?: string;
    };
    if (!body.prompt_key || !body.system_prompt)
      return new Response(JSON.stringify({ error: 'prompt_key and system_prompt required' }), { status: 400, headers });
    const { data, error } = await client.rpc('admin_insert_llm_prompt', {
      p_prompt_key: body.prompt_key,
      p_system_prompt: body.system_prompt,
      p_user_prompt: body.user_prompt ?? null,
      p_variant: body.variant ?? null,
      p_mode: body.mode ?? null,
      p_description: body.description ?? null,
    });
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    await invalidateLlmCache();
    return new Response(JSON.stringify({ prompt: data }), { status: 201, headers });
  }

  if (req.method === 'PUT') {
    if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers });
    const body = (await req.json()) as { system_prompt?: string; user_prompt?: string };
    const { error } = await client.rpc('admin_update_llm_prompt', {
      p_id: id,
      p_system_prompt: body.system_prompt ?? null,
      p_user_prompt: body.user_prompt ?? null,
    });
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    await invalidateLlmCache();
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  }

  if (req.method === 'DELETE') {
    if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers });
    const { error } = await client.rpc('admin_delete_llm_prompt', { p_id: id });
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    await invalidateLlmCache();
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
}
