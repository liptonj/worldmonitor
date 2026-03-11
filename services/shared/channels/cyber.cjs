'use strict';

// Extracted from scripts/ais-relay.cjs - Feodo + URLhaus cyber threat indicators
// APIs: Feodo Tracker (abuse.ch), URLhaus (abuse.ch)

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const CYBER_TIMEOUT_MS = 8_000;
const FEODO_URL = 'https://feodotracker.abuse.ch/downloads/ipblocklist.json';
const URLHAUS_RECENT_URL = (limit) => `https://urlhaus-api.abuse.ch/v1/urls/recent/limit/${limit}/`;
const CUTOFF_DAYS = 14;
const MAX_THREATS = 500;

function toProtoCyberThreat(t) {
  return {
    id: t.id,
    indicator: t.indicator,
    indicatorType: t.indicatorType === 'ip' ? 'CYBER_THREAT_INDICATOR_TYPE_IP' : t.indicatorType === 'domain' ? 'CYBER_THREAT_INDICATOR_TYPE_DOMAIN' : 'CYBER_THREAT_INDICATOR_TYPE_URL',
    country: t.country || '',
    firstSeenAt: t.firstSeen,
    lastSeenAt: t.lastSeen,
    type: t.type === 'c2_server' ? 'CYBER_THREAT_TYPE_C2_SERVER' : t.type === 'malware_host' ? 'CYBER_THREAT_TYPE_MALWARE_HOST' : t.type === 'phishing' ? 'CYBER_THREAT_TYPE_PHISHING' : 'CYBER_THREAT_TYPE_MALICIOUS_URL',
    source: t.source === 'feodo' ? 'CYBER_THREAT_SOURCE_FEODO' : t.source === 'urlhaus' ? 'CYBER_THREAT_SOURCE_URLHAUS' : 'CYBER_THREAT_SOURCE_C2INTEL',
    severity: t.severity === 'critical' ? 'CRITICALITY_LEVEL_CRITICAL' : t.severity === 'high' ? 'CRITICALITY_LEVEL_HIGH' : t.severity === 'medium' ? 'CRITICALITY_LEVEL_MEDIUM' : 'CRITICALITY_LEVEL_LOW',
  };
}

async function fetchFeodoThreats(http, limit, cutoffMs) {
  const data = await http.fetchJson(FEODO_URL, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    timeout: CYBER_TIMEOUT_MS,
  });
  const list = Array.isArray(data) ? data : [];
  return list
    .filter((t) => t && t.ip_address && t.first_seen_utc)
    .slice(0, limit)
    .map((t) => {
      const firstSeen = new Date(t.first_seen_utc).getTime();
      if (firstSeen < cutoffMs) return null;
      return {
        id: `feodo:${t.ip_address}`,
        type: 'c2_server',
        source: 'feodo',
        indicator: t.ip_address,
        indicatorType: 'ip',
        lat: null,
        lon: null,
        country: (t.country || '').toUpperCase().slice(0, 2),
        severity: 'high',
        firstSeen,
        lastSeen: new Date(t.last_seen_utc || t.first_seen_utc).getTime(),
      };
    })
    .filter((t) => t !== null);
}

async function fetchUrlhausThreats(http, limit, cutoffMs) {
  const data = await http.fetchJson(URLHAUS_RECENT_URL(limit), {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    timeout: CYBER_TIMEOUT_MS,
  });
  const urls = Array.isArray(data?.urls) ? data.urls : [];
  return urls
    .filter((u) => u && u.url && u.date_added)
    .slice(0, limit)
    .map((u) => {
      const firstSeen = new Date(u.date_added).getTime();
      if (firstSeen < cutoffMs) return null;
      return {
        id: `urlhaus:${u.id || u.url}`,
        type: 'malicious_url',
        source: 'urlhaus',
        indicator: u.url,
        indicatorType: 'url',
        lat: null,
        lon: null,
        country: '',
        severity: 'medium',
        firstSeen,
        lastSeen: firstSeen,
      };
    })
    .filter((t) => t !== null);
}

module.exports = async function fetchCyber({ config, redis, log, http }) {
  log.debug('fetchCyber executing');
  const timestamp = new Date().toISOString();
  const errors = [];

  const cutoffMs = Date.now() - CUTOFF_DAYS * 24 * 60 * 60 * 1000;

  let feodo = [];
  try {
    feodo = await fetchFeodoThreats(http, MAX_THREATS, cutoffMs);
  } catch (err) {
    log.warn('fetchCyber Feodo failed, continuing with URLhaus', { error: err?.message });
    errors.push(`feodo: ${err?.message}`);
  }

  let urlhaus = [];
  try {
    urlhaus = await fetchUrlhausThreats(http, MAX_THREATS, cutoffMs);
  } catch (err) {
    log.warn('fetchCyber URLhaus failed, continuing with Feodo', { error: err?.message });
    errors.push(`urlhaus: ${err?.message}`);
  }

  const combined = [...feodo, ...urlhaus];
  const threats = combined.slice(0, MAX_THREATS).map(toProtoCyberThreat);

  return {
    timestamp,
    source: 'cyber',
    data: { threats },
    status: errors.length === 0 ? 'success' : threats.length > 0 ? 'partial' : 'error',
    errors: errors.length > 0 ? errors : undefined,
  };
};
