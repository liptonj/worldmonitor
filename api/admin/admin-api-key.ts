// api/admin/admin-api-key.ts
// Returns ADMIN_API_KEY from Supabase vault for gateway admin cache API.
// Used by the Cache Viewer tab in the admin portal.
import { requireAdmin, errorResponse, corsHeaders } from './_auth';
import { getSecret } from '../../server/_shared/secrets';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  const headers = corsHeaders();
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
  }

  try {
    await requireAdmin(req);
  } catch (err) {
    return errorResponse(err);
  }

  const key = await getSecret('ADMIN_API_KEY');
  if (!key) {
    return new Response(
      JSON.stringify({ error: 'ADMIN_API_KEY not configured in vault' }),
      { status: 503, headers },
    );
  }

  return new Response(JSON.stringify({ key }), { status: 200, headers });
}
