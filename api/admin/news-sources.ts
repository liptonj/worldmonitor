// api/admin/news-sources.ts
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
  const variant = url.searchParams.get('variant');

  if (req.method === 'GET') {
    let query = supabase
      .schema('wm_admin')
      .from('news_sources')
      .select('*')
      .order('tier')
      .order('name');
    if (variant) query = query.contains('variants', [variant]);
    const { data, error } = await query;
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    return new Response(JSON.stringify({ sources: data }), { status: 200, headers });
  }

  if (req.method === 'POST') {
    const body = await req.json();
    const { error } = await supabase.schema('wm_admin').from('news_sources').insert(body);
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    return new Response(JSON.stringify({ ok: true }), { status: 201, headers });
  }

  if (req.method === 'PUT') {
    if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers });
    const body = await req.json();
    const { error } = await supabase.schema('wm_admin').from('news_sources').update(body).eq('id', id);
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  }

  if (req.method === 'DELETE') {
    if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers });
    const { error } = await supabase.schema('wm_admin').from('news_sources').delete().eq('id', id);
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
}
