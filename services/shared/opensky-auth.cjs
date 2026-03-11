'use strict';

const { createLogger } = require('./logger.cjs');

const log = createLogger('opensky-auth');

const AUTH_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
const AUTH_TIMEOUT_MS = 10_000;
const AUTH_COOLDOWN_MS = 60_000;
const AUTH_MAX_RETRIES = 3;
const AUTH_RETRY_DELAYS = [0, 2000, 5000];
const TOKEN_REFRESH_BUFFER_MS = 60_000;

let _token = null;
let _tokenExpiry = 0;
let _tokenPromise = null;
let _cooldownUntil = 0;

function _resetForTest() {
  _token = null;
  _tokenExpiry = 0;
  _tokenPromise = null;
  _cooldownUntil = 0;
}

async function _attemptTokenFetch(clientId, clientSecret, fetchFn) {
  const body = `grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AUTH_TIMEOUT_MS);

  try {
    const res = await fetchFn(AUTH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': String(Buffer.byteLength(body)),
        'User-Agent': 'WorldMonitor/1.0',
      },
      body,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }

    const json = await res.json();
    if (json.access_token) {
      return { token: json.access_token, expiresIn: json.expires_in || 1800 };
    }
    return { error: json.error || 'no_access_token' };
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') return { error: 'TIMEOUT' };
    return { error: err.message };
  }
}

async function _fetchToken(clientId, clientSecret, fetchFn) {
  for (let attempt = 0; attempt < AUTH_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = AUTH_RETRY_DELAYS[attempt] || 5000;
      log.info('OpenSky auth retry', { attempt: attempt + 1, max: AUTH_MAX_RETRIES, delayMs: delay });
      await new Promise((r) => setTimeout(r, delay));
    } else {
      log.info('Fetching new OpenSky OAuth2 token');
    }

    const result = await _attemptTokenFetch(clientId, clientSecret, fetchFn);
    if (result.token) {
      _token = result.token;
      _tokenExpiry = Date.now() + result.expiresIn * 1000;
      log.info('OpenSky token acquired', { expiresInSeconds: result.expiresIn });
      return _token;
    }
    log.warn('OpenSky auth attempt failed', { attempt: attempt + 1, error: result.error });
  }

  _cooldownUntil = Date.now() + AUTH_COOLDOWN_MS;
  log.warn('OpenSky auth failed after retries, entering cooldown', { cooldownMs: AUTH_COOLDOWN_MS });
  return null;
}

async function getOpenSkyToken(config, fetchFn = globalThis.fetch) {
  const clientId = config?.OPENSKY_CLIENT_ID || process.env.OPENSKY_CLIENT_ID;
  const clientSecret = config?.OPENSKY_CLIENT_SECRET || process.env.OPENSKY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return null;
  }

  if (_token && Date.now() < _tokenExpiry - TOKEN_REFRESH_BUFFER_MS) {
    return _token;
  }

  if (Date.now() < _cooldownUntil) {
    log.debug('OpenSky auth in cooldown', { remainingMs: _cooldownUntil - Date.now() });
    return null;
  }

  if (_tokenPromise) {
    return _tokenPromise;
  }

  _tokenPromise = _fetchToken(clientId, clientSecret, fetchFn);
  try {
    return await _tokenPromise;
  } finally {
    _tokenPromise = null;
  }
}

module.exports = { getOpenSkyToken, _resetForTest };
