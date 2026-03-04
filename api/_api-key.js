const DESKTOP_ORIGIN_PATTERNS = [
  /^https?:\/\/tauri\.localhost(:\d+)?$/,
  /^https?:\/\/[a-z0-9-]+\.tauri\.localhost(:\d+)?$/i,
  /^tauri:\/\/localhost$/,
  /^asset:\/\/localhost$/,
];

const BROWSER_ORIGIN_PATTERNS = [
  /^https:\/\/(.*\.)?worldmonitor\.app$/,
  /^https:\/\/(.*\.)?5ls\.us$/,
  /^https:\/\/worldmonitor-[a-z0-9-]+\.vercel\.app$/,
  ...(process.env.NODE_ENV === 'production' ? [] : [
    /^https?:\/\/localhost(:\d+)?$/,
    /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
  ]),
];

function isDesktopOrigin(origin) {
  return Boolean(origin) && DESKTOP_ORIGIN_PATTERNS.some(p => p.test(origin));
}

function isTrustedBrowserOrigin(origin) {
  return Boolean(origin) && BROWSER_ORIGIN_PATTERNS.some(p => p.test(origin));
}

function extractOriginFromReferer(referer) {
  if (!referer) return '';
  try {
    return new URL(referer).origin;
  } catch {
    return '';
  }
}

const KEY_CACHE = new Map();
const KEY_CACHE_TTL_MS = 60_000;

async function sha256hex(input) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function isValidKey(rawKey) {
  // 1. Fast env var check (WORLDMONITOR_VALID_KEYS remains as fallback/override)
  const validKeys = (process.env.WORLDMONITOR_VALID_KEYS || '').split(',').filter(Boolean);
  if (validKeys.includes(rawKey)) return true;

  // 2. Supabase app_keys table check
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return false;

  const keyHash = await sha256hex(rawKey);

  const cached = KEY_CACHE.get(keyHash);
  if (cached && Date.now() - cached.ts < KEY_CACHE_TTL_MS) {
    return cached.valid;
  }

  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/verify_app_key`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Accept-Profile': 'wm_admin',
      },
      body: JSON.stringify({ p_key_hash: keyHash }),
    });
    if (!res.ok) return false;
    const result = await res.json();
    const valid = result === true;
    KEY_CACHE.set(keyHash, { valid, ts: Date.now() });

    if (KEY_CACHE.size > 100) {
      const oldest = KEY_CACHE.keys().next().value;
      KEY_CACHE.delete(oldest);
    }

    return valid;
  } catch {
    return false;
  }
}

export async function validateApiKey(req) {
  const key = req.headers.get('X-WorldMonitor-Key');
  // Same-origin browser requests don't send Origin (per CORS spec).
  // Fall back to Referer to identify trusted same-origin callers.
  const origin = req.headers.get('Origin') || extractOriginFromReferer(req.headers.get('Referer')) || '';

  // Desktop app — always require API key
  if (isDesktopOrigin(origin)) {
    if (!key) return { valid: false, required: true, error: 'API key required for desktop access' };
    if (!(await isValidKey(key))) return { valid: false, required: true, error: 'Invalid API key' };
    return { valid: true, required: true };
  }

  // Trusted browser origin (worldmonitor.app, Vercel previews, localhost dev) — no key needed
  if (isTrustedBrowserOrigin(origin)) {
    if (key) {
      if (!(await isValidKey(key))) return { valid: false, required: true, error: 'Invalid API key' };
    }
    return { valid: true, required: false };
  }

  // Explicit key provided from unknown origin — validate it
  if (key) {
    if (!(await isValidKey(key))) return { valid: false, required: true, error: 'Invalid API key' };
    return { valid: true, required: true };
  }

  // No origin, no key — require API key (blocks unauthenticated curl/scripts)
  return { valid: false, required: true, error: 'API key required' };
}
