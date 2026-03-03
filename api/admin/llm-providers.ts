// api/admin/llm-providers.ts
import { requireAdmin, errorResponse, corsHeaders } from './_auth';
import { createServiceClient } from '../../server/_shared/supabase';
import { invalidateLlmCache } from '../../server/_shared/llm';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  const headers = corsHeaders();
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });

  try { await requireAdmin(req); } catch (err) { return errorResponse(err); }

  const supabase = createServiceClient();
  const url = new URL(req.url);
  const id = url.searchParams.get('id');

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .schema('wm_admin')
      .from('llm_providers')
      .select('*')
      .order('priority');
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    return new Response(JSON.stringify({ providers: data }), { status: 200, headers });
  }

  if (req.method === 'PUT') {
    if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers });
    const body = await req.json();
    const { error } = await supabase.schema('wm_admin').from('llm_providers').update(body).eq('id', id);
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    await invalidateLlmCache();
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
}
