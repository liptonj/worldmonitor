'use strict';

// Extracted from scripts/ais-relay.cjs - service health status monitoring
// APIs: Statuspage.io format (Cloudflare, Vercel, GitHub, npm, OpenAI, Supabase), AWS Health

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const STATUS_TIMEOUT_MS = 10_000;

const SERVICE_STATUS_PAGES = [
  { id: 'aws', name: 'AWS', url: 'https://health.aws.amazon.com/health/status' },
  { id: 'cloudflare', name: 'Cloudflare', url: 'https://www.cloudflarestatus.com/api/v2/status.json' },
  { id: 'vercel', name: 'Vercel', url: 'https://www.vercel-status.com/api/v2/status.json' },
  { id: 'github', name: 'GitHub', url: 'https://www.githubstatus.com/api/v2/status.json' },
  { id: 'npm', name: 'npm', url: 'https://status.npmjs.org/api/v2/status.json' },
  { id: 'openai', name: 'OpenAI', url: 'https://status.openai.com/api/v2/status.json' },
  { id: 'supabase', name: 'Supabase', url: 'https://status.supabase.com/api/v2/status.json' },
];

function normalizeStatus(indicator) {
  const v = (indicator || '').toLowerCase();
  if (v === 'none' || v === 'operational' || v.includes('all systems')) return 'SERVICE_OPERATIONAL_STATUS_OPERATIONAL';
  if (v === 'minor' || v.includes('degraded')) return 'SERVICE_OPERATIONAL_STATUS_DEGRADED';
  if (v === 'partial_outage') return 'SERVICE_OPERATIONAL_STATUS_PARTIAL_OUTAGE';
  if (v === 'major' || v === 'critical' || v.includes('outage')) return 'SERVICE_OPERATIONAL_STATUS_MAJOR_OUTAGE';
  if (v.includes('maintenance')) return 'SERVICE_OPERATIONAL_STATUS_MAINTENANCE';
  return 'SERVICE_OPERATIONAL_STATUS_UNSPECIFIED';
}

async function fetchOneStatus(http, svc) {
  const now = Date.now();
  try {
    const start = Date.now();
    const data = await http.fetchJson(svc.url, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      timeout: STATUS_TIMEOUT_MS,
    });
    const latencyMs = Date.now() - start;
    const statusObj = data && typeof data === 'object' ? data.status : null;
    const indicator = statusObj?.indicator ?? statusObj?.status ?? '';
    const desc = statusObj?.description ?? '';
    return {
      id: svc.id,
      name: svc.name,
      url: svc.url,
      status: normalizeStatus(indicator),
      description: desc,
      checkedAt: now,
      latencyMs,
    };
  } catch (err) {
    return {
      id: svc.id,
      name: svc.name,
      url: svc.url,
      status: 'SERVICE_OPERATIONAL_STATUS_UNSPECIFIED',
      description: 'Request failed',
      checkedAt: now,
      latencyMs: 0,
    };
  }
}

module.exports = async function fetchServiceStatus({ config, redis, log, http }) {
  log.debug('fetchServiceStatus executing');
  const timestamp = new Date().toISOString();

  try {
    const results = await Promise.all(
      SERVICE_STATUS_PAGES.map((svc) => fetchOneStatus(http, svc))
    );

    const statuses = Array.isArray(results) ? results : [];

    return {
      timestamp,
      source: 'service-status',
      data: { statuses },
      status: 'success',
    };
  } catch (err) {
    log.error('fetchServiceStatus error', { error: err?.message ?? err });
    return {
      timestamp,
      source: 'service-status',
      data: { statuses: [] },
      status: 'error',
      errors: [err?.message ?? String(err)],
    };
  }
};
