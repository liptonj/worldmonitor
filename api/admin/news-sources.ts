// api/admin/news-sources.ts
import { requireAdmin, errorResponse, corsHeaders } from './_auth';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  const headers = corsHeaders();
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });

  let admin;
  try { admin = await requireAdmin(req); } catch (err) { return errorResponse(err); }

  const { client } = admin;
  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  const variant = url.searchParams.get('variant');

  if (req.method === 'GET') {
    const { data, error } = await client.rpc('admin_get_news_sources', {
      p_variant: variant ?? null,
    });
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    return new Response(JSON.stringify({ sources: data }), { status: 200, headers });
  }

  if (req.method === 'POST') {
    const body = await req.json() as {
      name: string; url: unknown; tier?: number; category?: string;
      source_type?: string; lang?: string; proxy_mode?: string;
      variants?: string[]; enabled?: boolean; default_enabled?: boolean;
      propaganda_risk?: string; state_affiliated?: string; propaganda_note?: string;
    };
    if (!body.name) return new Response(JSON.stringify({ error: 'name required' }), { status: 400, headers });
    const { data, error } = await client.rpc('admin_insert_news_source', {
      p_name: body.name,
      p_url: body.url ?? {},
      p_tier: body.tier ?? 2,
      p_category: body.category ?? null,
      p_source_type: body.source_type ?? 'rss',
      p_lang: body.lang ?? 'en',
      p_proxy_mode: body.proxy_mode ?? 'proxy',
      p_variants: body.variants ?? ['full'],
      p_enabled: body.enabled ?? true,
      p_default_enabled: body.default_enabled ?? true,
      p_propaganda_risk: body.propaganda_risk ?? 'low',
      p_state_affiliated: body.state_affiliated ?? 'no',
      p_propaganda_note: body.propaganda_note ?? null,
    });
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    return new Response(JSON.stringify({ ok: true, id: data }), { status: 201, headers });
  }

  if (req.method === 'PUT') {
    if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers });
    const body = await req.json();
    const { error } = await client.rpc('admin_update_news_source', { p_id: id, p_data: body });
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  }

  if (req.method === 'DELETE') {
    if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers });
    const { error } = await client.rpc('admin_delete_news_source', { p_id: id });
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
}
