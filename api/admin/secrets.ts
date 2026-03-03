// api/admin/secrets.ts
import { requireAdmin, errorResponse, corsHeaders } from './_auth';
import { createServiceClient } from '../../server/_shared/supabase';
import { invalidateSecretCache } from '../../server/_shared/secrets';
import { invalidateLlmCache } from '../../server/_shared/llm';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  const headers = corsHeaders();
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });

  try { await requireAdmin(req); } catch (err) { return errorResponse(err); }

  const supabase = createServiceClient();
  const url = new URL(req.url);
  const secretName = url.searchParams.get('name');

  // GET — list names (never values)
  if (req.method === 'GET') {
    const { data, error } = await supabase.schema('wm_admin').rpc('list_vault_secret_names', {});
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    return new Response(JSON.stringify({ secrets: data }), { status: 200, headers });
  }

  // POST — create or update
  if (req.method === 'POST') {
    const body = (await req.json()) as { name: string; value: string; description?: string };
    if (!body.name || !body.value)
      return new Response(JSON.stringify({ error: 'name and value required' }), { status: 400, headers });

    const { error } = await supabase.schema('wm_admin').rpc(
      'upsert_vault_secret',
      { p_name: body.name, p_secret: body.value, p_description: body.description ?? null },
    );
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });

    await invalidateSecretCache(body.name);
    if (body.name.includes('GROQ') || body.name.includes('OPENROUTER') || body.name.includes('LLM') || body.name.includes('OLLAMA')) {
      await invalidateLlmCache();
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  }

  // DELETE
  if (req.method === 'DELETE') {
    if (!secretName)
      return new Response(JSON.stringify({ error: 'name param required' }), { status: 400, headers });

    const { error } = await supabase.schema('wm_admin').rpc(
      'delete_vault_secret',
      { p_name: secretName },
    );
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    await invalidateSecretCache(secretName);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
}
