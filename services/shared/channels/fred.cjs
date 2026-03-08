'use strict';

// Extracted from scripts/ais-relay.cjs - Federal Reserve Economic Data
// API: FRED (Federal Reserve Economic Data)

const FRED_API_BASE = 'https://api.stlouisfed.org/fred';
const FRED_DASHBOARD_SERIES = [
  { id: 'WALCL', limit: 120 },
  { id: 'FEDFUNDS', limit: 120 },
  { id: 'T10Y2Y', limit: 120 },
  { id: 'UNRATE', limit: 120 },
  { id: 'CPIAUCSL', limit: 120 },
  { id: 'DGS10', limit: 120 },
  { id: 'VIXCLS', limit: 120 },
];

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const TIMEOUT_MS = 10_000;

async function fetchFredSeries(seriesId, limit, apiKey, http) {
  const obsParams = new URLSearchParams({
    series_id: seriesId,
    api_key: apiKey,
    file_type: 'json',
    sort_order: 'desc',
    limit: String(limit),
  });
  const metaParams = new URLSearchParams({
    series_id: seriesId,
    api_key: apiKey,
    file_type: 'json',
  });
  const [obsData, metaData] = await Promise.all([
    http.fetchJson(`${FRED_API_BASE}/series/observations?${obsParams}`, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      timeout: TIMEOUT_MS,
    }),
    http.fetchJson(`${FRED_API_BASE}/series?${metaParams}`, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      timeout: TIMEOUT_MS,
    }),
  ]);
  if (!obsData || typeof obsData !== 'object') return null;
  const observations = (obsData.observations || [])
    .map((obs) => {
      const value = parseFloat(obs.value);
      if (isNaN(value) || obs.value === '.') return null;
      return { date: obs.date, value };
    })
    .filter((o) => o !== null)
    .reverse();
  let title = seriesId;
  let units = '';
  let frequency = '';
  if (metaData?.seriess?.[0]) {
    const meta = metaData.seriess[0];
    title = meta.title || seriesId;
    units = meta.units || '';
    frequency = meta.frequency || '';
  }
  return { seriesId, title, units, frequency, observations };
}

module.exports = async function fetchFred({ config, redis, log, http }) {
  log.debug('fetchFred executing');
  const timestamp = new Date().toISOString();

  const apiKey = config?.FRED_API_KEY || process.env.FRED_API_KEY;
  if (!apiKey) {
    log.warn('fetchFred: FRED_API_KEY not set');
    return {
      timestamp,
      source: 'fred',
      data: [],
      status: 'error',
      errors: ['FRED_API_KEY not configured'],
    };
  }

  try {
    const results = await Promise.allSettled(
      FRED_DASHBOARD_SERIES.map(({ id, limit }) => fetchFredSeries(id, limit, apiKey, http))
    );
    const series = results
      .map((r) => (r.status === 'fulfilled' ? r.value : null))
      .filter((s) => s !== null);

    if (!Array.isArray(series)) {
      return {
        timestamp,
        source: 'fred',
        data: [],
        status: 'error',
        errors: ['Invalid FRED response: expected array'],
      };
    }

    return {
      timestamp,
      source: 'fred',
      data: series,
      status: series.length > 0 ? 'success' : 'success',
    };
  } catch (err) {
    log.error('fetchFred error', { error: err?.message ?? err });
    return {
      timestamp,
      source: 'fred',
      data: [],
      status: 'error',
      errors: [err?.message ?? String(err)],
    };
  }
};
