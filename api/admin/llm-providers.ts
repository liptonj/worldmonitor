// api/admin/llm-providers.ts
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

  if (req.method === 'GET') {
    const { data, error } = await client.rpc('admin_get_llm_providers');
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    return new Response(JSON.stringify({ providers: data }), { status: 200, headers });
  }

  if (req.method === 'POST') {
    const body = (await req.json()) as {
      name: string; api_url: string; default_model: string;
      api_key_secret_name: string; priority?: number; enabled?: boolean;
    };
    if (!body.name || !body.api_url || !body.default_model || !body.api_key_secret_name)
      return new Response(JSON.stringify({ error: 'name, api_url, default_model, and api_key_secret_name required' }), { status: 400, headers });
    const { data, error } = await client.rpc('admin_insert_llm_provider', {
      p_name: body.name,
      p_api_url: body.api_url,
      p_default_model: body.default_model,
      p_api_key_secret_name: body.api_key_secret_name,
      p_priority: body.priority ?? 10,
      p_enabled: body.enabled ?? true,
    });
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    await invalidateLlmCache();
    return new Response(JSON.stringify({ provider: data }), { status: 201, headers });
  }

  if (req.method === 'PUT') {
    if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers });
    const body = await req.json();
    const { error } = await client.rpc('admin_update_llm_provider', { p_id: id, p_data: body });
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    await invalidateLlmCache();
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  }

  if (req.method === 'DELETE') {
    if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers });
    const { error } = await client.rpc('admin_delete_llm_provider', { p_id: id });
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    await invalidateLlmCache();
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
}
