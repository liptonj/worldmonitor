// server/_shared/supabase.ts
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Service-role client — bypasses RLS.
 * ONLY for admin writes and Vault access. NEVER expose to browser.
 */
export function createServiceClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  }

  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Anon client — respects RLS, subject to grant-controlled RPCs only.
 * Use for public config reads via RPC (news sources, feature flags).
 */
export function createAnonClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be set');
  }

  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
