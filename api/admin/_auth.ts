// api/admin/_auth.ts
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export interface AdminUser {
  id: string;
  email: string;
  role: string;
  /** Supabase client scoped to this user's JWT — RLS enforced, is_admin() applies */
  client: SupabaseClient;
}

/**
 * Validates the Bearer JWT from the request and confirms the user is an admin.
 * Returns the user details and a JWT-scoped Supabase client — no service role needed.
 *
 * The returned client operates under RLS with the user's identity.
 * wm_admin tables have policies that call is_admin(), so only admin users
 * can read/write them — the database enforces this, not our code.
 */
export async function requireAdmin(req: Request): Promise<AdminUser> {
  const auth = req.headers.get('Authorization') ?? '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();

  if (!token) throw { status: 401, body: 'Missing Authorization header' };

  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw { status: 500, body: 'Supabase not configured' };

  // Create a client scoped to this user's JWT — all queries run as this user
  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Verify the JWT is valid and get the user
  const { data: { user }, error } = await userClient.auth.getUser();
  if (error || !user) throw { status: 401, body: 'Invalid or expired token' };

  // Check admin role using the user-scoped client — RLS + is_admin() enforces this
  const { data: adminRecord, error: adminError } = await userClient
    .schema('wm_admin')
    .from('admin_users')
    .select('role')
    .eq('user_id', user.id)
    .single();

  if (adminError || !adminRecord) throw { status: 403, body: 'Not an admin user' };

  return { id: user.id, email: user.email!, role: adminRecord.role, client: userClient };
}

export function errorResponse(err: unknown): Response {
  if (err && typeof err === 'object' && 'status' in err) {
    const e = err as { status: number; body: string };
    return new Response(JSON.stringify({ error: e.body }), {
      status: e.status,
      headers: corsHeaders(),
    });
  }
  console.error('[admin] Unexpected error:', err);
  return new Response(JSON.stringify({ error: 'Internal server error' }), {
    status: 500,
    headers: corsHeaders(),
  });
}

export function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };
}
