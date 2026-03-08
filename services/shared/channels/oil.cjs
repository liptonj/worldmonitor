'use strict';

// Extracted from scripts/ais-relay.cjs - Oil prices and energy markets
// API: EIA (U.S. Energy Information Administration)

const EIA_SERIES = [
  { commodity: 'wti', name: 'WTI Crude Oil', unit: '$/barrel', apiPath: '/v2/petroleum/pri/spt/data/', seriesFacet: 'RWTC' },
  { commodity: 'brent', name: 'Brent Crude Oil', unit: '$/barrel', apiPath: '/v2/petroleum/pri/spt/data/', seriesFacet: 'RBRTE' },
];

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const TIMEOUT_MS = 10_000;

async function fetchEiaSeries(config, apiKey, http) {
  const params = new URLSearchParams({
    api_key: apiKey,
    'data[]': 'value',
    frequency: 'weekly',
    'facets[series][]': config.seriesFacet,
    'sort[0][column]': 'period',
    'sort[0][direction]': 'desc',
    length: '2',
  });
  const data = await http.fetchJson(`https://api.eia.gov${config.apiPath}?${params}`, {
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    timeout: TIMEOUT_MS,
  });
  if (!data || typeof data !== 'object') return null;
  const rows = data.response?.data;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const current = rows[0];
  const previous = rows[1];
  const price = current.value ?? 0;
  const prevPrice = previous?.value ?? price;
  const change = prevPrice !== 0 ? ((price - prevPrice) / prevPrice) * 100 : 0;
  const priceAt = current.period ? new Date(current.period).getTime() : Date.now();
  return {
    commodity: config.commodity,
    name: config.name,
    price,
    unit: config.unit,
    change: Math.round(change * 10) / 10,
    priceAt: Number.isFinite(priceAt) ? priceAt : Date.now(),
  };
}

module.exports = async function fetchOil({ config, redis, log, http }) {
  log.debug('fetchOil executing');
  const timestamp = new Date().toISOString();

  const apiKey = config?.EIA_API_KEY || process.env.EIA_API_KEY;
  if (!apiKey) {
    log.warn('fetchOil: EIA_API_KEY not set');
    return {
      timestamp,
      source: 'oil',
      data: [],
      status: 'error',
      errors: ['EIA_API_KEY not configured'],
    };
  }

  try {
    const results = await Promise.all(EIA_SERIES.map((s) => fetchEiaSeries(s, apiKey, http)));
    const prices = results.filter((p) => p !== null);

    if (!Array.isArray(prices)) {
      return {
        timestamp,
        source: 'oil',
        data: [],
        status: 'error',
        errors: ['Invalid EIA response: expected array'],
      };
    }

    return {
      timestamp,
      source: 'oil',
      data: prices,
      status: prices.length > 0 ? 'success' : 'success',
    };
  } catch (err) {
    log.error('fetchOil error', { error: err?.message ?? err });
    return {
      timestamp,
      source: 'oil',
      data: [],
      status: 'error',
      errors: [err?.message ?? String(err)],
    };
  }
};
