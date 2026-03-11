'use strict';

const { createLogger } = require('./logger.cjs');
const { getClient: getRedisClient } = require('./redis.cjs');

const log = createLogger('secrets');

const CACHE_TTL_MS = 15 * 60_000; // 15 minutes
const REDIS_CACHE_TTL_SECONDS = 900;

const KNOWN_SECRETS = [
  'FINNHUB_API_KEY',
  'ACLED_ACCESS_TOKEN',
  'OREF_PROXY_AUTH',
  'UCDP_ACCESS_TOKEN',
  'WTO_API_KEY',
  'EIA_API_KEY',
  'FRED_API_KEY',
  'NASA_FIRMS_API_KEY',
  'AVIATIONSTACK_API_KEY',
  'RELAY_SHARED_SECRET',
  'OPENSKY_CLIENT_ID',
  'OPENSKY_CLIENT_SECRET',
  'URLHAUS_AUTH_KEY',
];

const ENV_ONLY = new Set([
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_KEY',
  'REDIS_URL',
  'NODE_ENV',
]);

let _cache = new Map();
let _cacheTs = 0;
let _supabaseClient = null;

function _createSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !serviceKey) return null;

  try {
    const { createClient } = require('@supabase/supabase-js');
    return createClient(url, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  } catch (err) {
    log.warn('Failed to create Supabase client for Vault', { error: err.message });
    return null;
  }
}

function _getSupabaseClient() {
  if (!_supabaseClient) _supabaseClient = _createSupabaseClient();
  return _supabaseClient;
}

async function _fetchFromVault(secretName) {
  const supabase = _getSupabaseClient();
  if (!supabase) return undefined;

  try {
    const { data, error } = await supabase
      .rpc('get_vault_secret_value', { secret_name: secretName });
    if (!error && data != null) return String(data);
  } catch (err) {
    log.debug('Vault fetch failed', { secret: secretName, error: err.message });
  }
  return undefined;
}

async function _fetchFromRedisCache(secretName) {
  try {
    const client = getRedisClient();
    const cached = await client.get(`wm:vault:v1:${secretName}`);
    if (cached !== null && cached !== undefined) return cached;
  } catch (err) {
    log.debug('Redis cache fetch failed', { secret: secretName, error: err.message });
  }
  return undefined;
}

async function _storeInRedisCache(secretName, value) {
  if (!value) return;
  try {
    const client = getRedisClient();
    await client.setex(`wm:vault:v1:${secretName}`, REDIS_CACHE_TTL_SECONDS, value);
  } catch (err) {
    log.debug('Redis cache store failed', { secret: secretName, error: err.message });
  }
}

async function getSecret(secretName) {
  if (ENV_ONLY.has(secretName)) {
    const value = process.env[secretName] ?? undefined;
    return { value, source: value ? 'env' : undefined };
  }

  if (_cache.has(secretName) && (Date.now() - _cacheTs) < CACHE_TTL_MS) {
    const value = _cache.get(secretName);
    return { value, source: value ? 'cache' : undefined };
  }

  const fromRedis = await _fetchFromRedisCache(secretName);
  if (fromRedis) {
    _cache.set(secretName, fromRedis);
    return { value: fromRedis, source: 'redis' };
  }

  const fromVault = await _fetchFromVault(secretName);
  if (fromVault) {
    _cache.set(secretName, fromVault);
    await _storeInRedisCache(secretName, fromVault);
    return { value: fromVault, source: 'vault' };
  }

  const fromEnv = process.env[secretName];
  if (fromEnv) {
    _cache.set(secretName, fromEnv);
    return { value: fromEnv, source: 'env' };
  }

  return { value: undefined, source: undefined };
}

async function initSecrets() {
  log.info('Initializing secrets from Vault', { count: KNOWN_SECRETS.length });
  let vaultCount = 0;
  let envCount = 0;

  const results = await Promise.allSettled(
    KNOWN_SECRETS.map(async (name) => {
      const { value, source } = await getSecret(name);
      if (value) {
        if (source === 'redis' || source === 'vault' || source === 'cache') vaultCount++;
        else if (source === 'env') envCount++;
      }
      return { name, found: !!value };
    })
  );

  const missing = results
    .filter(r => r.status === 'fulfilled' && !r.value.found)
    .map(r => r.value.name);

  _cacheTs = Date.now();
  log.info('Secrets initialized', { vault: vaultCount, env: envCount, missing: missing.length, missingKeys: missing });
  return { loaded: vaultCount + envCount, missing };
}

function getSecretSync(secretName) {
  if (_cache.has(secretName)) return _cache.get(secretName);
  return process.env[secretName] ?? undefined;
}

function getAllCachedSecrets() {
  const result = {};
  for (const name of KNOWN_SECRETS) {
    const value = _cache.get(name) ?? process.env[name];
    if (value) result[name] = value;
  }
  return result;
}

async function invalidateSecretCache(secretName) {
  _cache.delete(secretName);
  try {
    const client = getRedisClient();
    await client.del(`wm:vault:v1:${secretName}`);
  } catch (err) {
    log.debug('Redis cache invalidation failed', { secret: secretName, error: err.message });
  }
}

module.exports = { getSecret, initSecrets, getSecretSync, getAllCachedSecrets, invalidateSecretCache, KNOWN_SECRETS };
