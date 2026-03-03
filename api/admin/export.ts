// api/admin/export.ts
import { requireAdmin, errorResponse, corsHeaders } from './_auth';
import { createServiceClient } from '../../server/_shared/supabase';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  const headers = corsHeaders();
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });

  let admin;
  try { admin = await requireAdmin(req); } catch (err) { return errorResponse(err); }

  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
  }

  const { client } = admin;

  const [flags, sources, providers, prompts, appKeys] = await Promise.all([
    client.schema('wm_admin').from('feature_flags').select('*'),
    client.schema('wm_admin').from('news_sources').select('*'),
    client.schema('wm_admin').from('llm_providers').select('*'),
    client.schema('wm_admin').from('llm_prompts').select('*'),
    client.schema('wm_admin').from('app_keys').select('id, description, enabled, created_at, revoked_at'),
  ]);

  // Vault secret names require service role — Vault RPCs are revoked from all users
  let vaultSecretNames: unknown[] = [];
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const serviceClient = createServiceClient();
    const { data, error } = await serviceClient.schema('wm_admin').rpc('list_vault_secret_names');
    if (!error) vaultSecretNames = data ?? [];
  }

  const exportData = {
    exported_at: new Date().toISOString(),
    feature_flags: flags.data,
    news_sources: sources.data,
    llm_providers: providers.data,
    llm_prompts: prompts.data,
    app_keys: appKeys.data,
    vault_secret_names: vaultSecretNames,
  };

  return new Response(JSON.stringify(exportData, null, 2), {
    status: 200,
    headers: {
      ...headers,
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="worldmonitor-config-${new Date().toISOString().split('T')[0]}.json"`,
    },
  });
}
