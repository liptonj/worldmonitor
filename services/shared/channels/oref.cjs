'use strict';

// Fetches data from Israel OREF rocket alert system API
// OREF API is geo-blocked; requires proxy with Israel exit node (OREF_PROXY_AUTH)
// Monolith uses curl (Node TLS fingerprint blocked by Akamai); channel uses http.fetchJson
// until worker provides proxy-aware http for OREF URLs

const OREF_ALERTS_URL = 'https://www.oref.org.il/WarningMessages/alert/alerts.json';
const OREF_HISTORY_URL = 'https://www.oref.org.il/WarningMessages/alert/History/AlertsHistory.json';

async function fetchWithProxy(url, proxyAuth, http) {
  if (!proxyAuth) {
    return await http.fetchJson(url);
  }
  // TODO: Implement proxy request with authentication (user:pass@host:port)
  // For now, fall back to direct fetch — worker should provide proxy-aware http for OREF
  return await http.fetchJson(url);
}

module.exports = async function fetchOref({ config, redis, log, http }) {
  log.debug('fetchOref executing');

  const proxyAuth = config?.OREF_PROXY_AUTH || process.env.OREF_PROXY_AUTH;

  if (!proxyAuth) {
    log.warn('fetchOref: OREF_PROXY_AUTH not set, OREF likely blocked');
    return {
      timestamp: new Date().toISOString(),
      source: 'oref',
      data: null,
      status: 'error',
      error: 'OREF_PROXY_AUTH not configured',
    };
  }

  try {
    const [currentAlerts, history] = await Promise.all([
      fetchWithProxy(OREF_ALERTS_URL, proxyAuth, http),
      fetchWithProxy(OREF_HISTORY_URL, proxyAuth, http),
    ]);

    return {
      timestamp: new Date().toISOString(),
      source: 'oref',
      data: {
        current: currentAlerts,
        history: history,
      },
      status: 'success',
    };
  } catch (err) {
    log.error('fetchOref error', { error: err.message });
    return {
      timestamp: new Date().toISOString(),
      source: 'oref',
      data: null,
      status: 'error',
      error: err.message,
    };
  }
};
