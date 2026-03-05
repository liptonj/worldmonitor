// server/_shared/secrets.ts
/**
 * Secret resolution with layered fallback:
 * 1. Upstash Redis cache (15-minute TTL — avoids Supabase roundtrip per request)
 * 2. Supabase Vault (wm_admin.get_vault_secret RPC)
 * 3. process.env fallback (existing env var deployments keep working)
 *
 * Secrets that MUST stay in process.env (never in Vault):
 *   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN — used by this module itself
 *   RELAY_SHARED_SECRET, RELAY_AUTH_HEADER — also read by relay server (relay.5ls.us)
 *   SUPABASE_*, CONVEX_URL, VERCEL_*, NODE_ENV
 */

import { getRedisClient } from './redis';
import { createServiceClient } from './supabase';

const CACHE_TTL_SECONDS = 900; // 15 minutes

// These must never be fetched from Vault — they bootstrap the infrastructure
const ENV_ONLY = new Set([
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'RELAY_SHARED_SECRET',
  'RELAY_AUTH_HEADER',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'CONVEX_URL',
  'NODE_ENV',
  'VERCEL_ENV',
  'VERCEL_GIT_COMMIT_SHA',
]);

function vaultCacheKey(name: string): string {
  return `wm:vault:v1:${name}`;
}

export async function getSecret(secretName: string): Promise<string | undefined> {
  // Infrastructure secrets always come from env
  if (ENV_ONLY.has(secretName)) {
    return process.env[secretName] ?? undefined;
  }

  // If Supabase is not configured (service role absent), fall through to env.
  // In production, SUPABASE_SERVICE_ROLE_KEY must be set as an env var in Vercel.
  // In local dev, individual secrets can be set in .env as a fallback.
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return process.env[secretName] ?? undefined;
  }

  // 1. Redis cache (via @upstash/redis SDK → self-hosted SRH container)
  const redis = getRedisClient();
  if (redis) {
    try {
      const cached = await redis.get<string>(vaultCacheKey(secretName));
      if (cached !== null && cached !== undefined) return cached;
    } catch {
      // Redis miss — continue
    }
  }

  // 2. Supabase Vault via public.get_vault_secret_value() (SECURITY DEFINER wrapper)
  try {
    const supabase = createServiceClient();
    const { data, error } = await supabase
      .rpc('get_vault_secret_value', { secret_name: secretName });
    if (!error && data) {
      if (redis) {
        try { await redis.setex(vaultCacheKey(secretName), CACHE_TTL_SECONDS, data); } catch { /* non-fatal */ }
      }
      return data as string;
    }
  } catch {
    // Vault unavailable — fall through
  }

  // 3. Env fallback
  return process.env[secretName] ?? undefined;
}

/** Call after updating a secret via admin portal to clear the cache. */
export async function invalidateSecretCache(secretName: string): Promise<void> {
  const redis = getRedisClient();
  if (redis) {
    try { await redis.del(vaultCacheKey(secretName)); } catch { /* non-fatal */ }
  }
}
