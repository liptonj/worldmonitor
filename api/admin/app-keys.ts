// api/admin/app-keys.ts
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

  if (req.method === 'GET') {
    const { data, error } = await client.rpc('admin_get_app_keys');
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    return new Response(JSON.stringify({ keys: data }), { status: 200, headers });
  }

  if (req.method === 'POST') {
    const body = (await req.json()) as { rawKey: string; description?: string };
    if (!body.rawKey)
      return new Response(JSON.stringify({ error: 'rawKey required' }), { status: 400, headers });
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.rawKey));
    const keyHash = Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const { error } = await client.rpc('admin_insert_app_key', {
      p_key_hash: keyHash,
      p_description: body.description ?? null,
    });
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    return new Response(JSON.stringify({ ok: true }), { status: 201, headers });
  }

  if (req.method === 'DELETE') {
    if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers });
    const { error } = await client.rpc('admin_revoke_app_key', { p_id: id });
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
}
