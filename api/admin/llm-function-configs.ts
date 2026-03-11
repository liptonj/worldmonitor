// api/admin/llm-function-configs.ts
/**
 * Admin API: LLM function config management
 * GET  → list all function configs
 * PUT  → update a function config by function_key
 */
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
  const functionKey = url.searchParams.get('function_key');

  if (req.method === 'GET') {
    const { data, error } = await client
      .schema('wm_admin')
      .from('llm_function_config')
      .select('function_key, provider_chain, timeout_ms, max_retries, complexity, description, updated_at')
      .order('function_key');
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    return new Response(JSON.stringify({ configs: data }), { status: 200, headers });
  }

  if (req.method === 'PUT') {
    if (!functionKey)
      return new Response(JSON.stringify({ error: 'function_key required' }), { status: 400, headers });
    const body = (await req.json()) as {
      provider_chain?: string[];
      timeout_ms?: number;
      max_retries?: number;
      complexity?: string;
    };
    const update: Record<string, unknown> = {};
    if (body.provider_chain !== undefined) update.provider_chain = body.provider_chain;
    if (body.timeout_ms !== undefined) update.timeout_ms = body.timeout_ms;
    if (body.max_retries !== undefined) update.max_retries = body.max_retries;
    if (body.complexity !== undefined) update.complexity = body.complexity;
    if (Object.keys(update).length === 0)
      return new Response(JSON.stringify({ error: 'No updatable fields provided' }), { status: 400, headers });
    const { error } = await client
      .schema('wm_admin')
      .from('llm_function_config')
      .update(update)
      .eq('function_key', functionKey);
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    await invalidateLlmCache();
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
}
