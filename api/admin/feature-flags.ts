// api/admin/feature-flags.ts
import { requireAdmin, errorResponse, corsHeaders } from './_auth';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  const headers = corsHeaders();
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });

  let admin;
  try { admin = await requireAdmin(req); } catch (err) { return errorResponse(err); }

  const { client } = admin;

  if (req.method === 'GET') {
    const { data, error } = await client
      .schema('wm_admin')
      .from('feature_flags')
      .select('*')
      .order('category')
      .order('key');
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    return new Response(JSON.stringify({ flags: data }), { status: 200, headers });
  }

  if (req.method === 'PUT') {
    const body = (await req.json()) as { key: string; value: unknown; description?: string };
    if (!body.key) return new Response(JSON.stringify({ error: 'key required' }), { status: 400, headers });
    const { error } = await client
      .schema('wm_admin')
      .from('feature_flags')
      .upsert({ key: body.key, value: body.value, description: body.description }, { onConflict: 'key' });
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
}
