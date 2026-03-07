'use strict';

const { createLogger } = require('./logger.cjs');

const log = createLogger('http');
const USER_AGENT = 'WorldMonitor-Relay/1.0';
const DEFAULT_TIMEOUT_MS = 30000;

// URLs may contain sensitive query parameters — callers should use non-sensitive URLs or strip credentials before passing.

async function fetchJson(url, options = {}) {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);

  log.debug('fetchJson', { url });
  try {
    const res = await fetch(url, {
      ...options,
      signal: options.signal || controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Encoding': 'gzip',
        ...options.headers,
      },
    });
    clearTimeout(id);
    if (res.status < 200 || res.status >= 300) {
      const text = await res.text();
      log.warn('fetchJson non-2xx', { url, status: res.status });
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return await res.json();
  } catch (err) {
    clearTimeout(id);
    if (err.name === 'AbortError') {
      log.warn('fetchJson timeout', { url });
      throw new Error(`Request timeout after ${timeout}ms`);
    }
    log.warn('fetchJson error', { url, error: err.message });
    throw err;
  }
}

async function fetchText(url, options = {}) {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);

  log.debug('fetchText', { url });
  try {
    const res = await fetch(url, {
      ...options,
      signal: options.signal || controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Encoding': 'gzip',
        ...options.headers,
      },
    });
    clearTimeout(id);
    if (res.status < 200 || res.status >= 300) {
      const text = await res.text();
      log.warn('fetchText non-2xx', { url, status: res.status });
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return await res.text();
  } catch (err) {
    clearTimeout(id);
    if (err.name === 'AbortError') {
      log.warn('fetchText timeout', { url });
      throw new Error(`Request timeout after ${timeout}ms`);
    }
    log.warn('fetchText error', { url, error: err.message });
    throw err;
  }
}

async function fetchWithRetry(url, options = {}, retries = 3, backoffMs = 500) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);

    try {
      log.debug('fetchWithRetry', { url, attempt });
      const res = await fetch(url, {
        ...options,
        signal: options.signal || controller.signal,
        headers: {
          'User-Agent': USER_AGENT,
          'Accept-Encoding': 'gzip',
          ...options.headers,
        },
      });
      clearTimeout(id);

      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        if (attempt < retries) {
          await Promise.resolve(res.text()).catch(() => {}); // drain body to avoid connection leaks
          const delay = backoffMs * Math.pow(2, attempt) * (0.5 + Math.random() * 0.5);
          log.debug('fetchWithRetry retrying', { url, status: res.status, delayMs: Math.round(delay) });
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
      }

      if (res.status < 200 || res.status >= 300) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }

      return res;
    } catch (err) {
      clearTimeout(id);
      lastErr = err;
      if (attempt < retries && (err.message?.includes('429') || err.message?.includes('5') || err.name === 'AbortError')) {
        const delay = backoffMs * Math.pow(2, attempt) * (0.5 + Math.random() * 0.5);
        log.debug('fetchWithRetry retrying after error', { url, error: err.message, delayMs: Math.round(delay) });
        await new Promise((r) => setTimeout(r, delay));
      } else {
        break;
      }
    }
  }
  log.warn('fetchWithRetry failed', { url, error: lastErr?.message });
  throw lastErr;
}

module.exports = { fetchJson, fetchText, fetchWithRetry };
