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
    client.rpc('admin_get_feature_flags'),
    client.rpc('admin_get_news_sources'),
    client.rpc('admin_get_llm_providers'),
    client.rpc('admin_get_llm_prompts'),
    client.rpc('admin_get_app_keys'),
  ]);

  // Vault secret names require service role — Vault RPCs are restricted to service_role
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
      'Content-Disposition': `attachment; filename="worldmonitor-config-${new Date().toISOString().slice(0, 10)}.json"`,
    },
  });
}
