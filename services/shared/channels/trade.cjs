'use strict';

// Extracted from scripts/ais-relay.cjs - Trade data and indicators
// API: WTO (World Trade Organization) Timeseries

const WTO_MEMBER_CODES = {
  '840': 'United States', '156': 'China', '276': 'Germany', '392': 'Japan', '826': 'United Kingdom',
  '356': 'India', '076': 'Brazil', '643': 'Russia', '410': 'South Korea', '036': 'Australia',
  '124': 'Canada', '484': 'Mexico', '250': 'France', '380': 'Italy', '528': 'Netherlands',
};
const MAJOR_REPORTERS = ['840', '156', '276', '392', '826', '356', '076', '643', '410', '036', '124', '484', '250', '380', '528'];

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const TIMEOUT_MS = 30_000;

async function wtoFetch(path, params, apiKey, http) {
  if (!apiKey) return null;
  try {
    const url = new URL(`https://api.wto.org/timeseries/v1${path}`);
    if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const data = await http.fetchJson(url.toString(), {
      headers: { 'Ocp-Apim-Subscription-Key': apiKey, 'User-Agent': USER_AGENT },
      timeout: TIMEOUT_MS,
    });
    if (!data) return null;
    return data;
  } catch (err) {
    return null;
  }
}

function parseRows(data) {
  const dataset = Array.isArray(data) ? data : data?.Dataset ?? data?.dataset ?? [];
  if (!Array.isArray(dataset)) return [];
  return dataset.map((row) => ({
    country: WTO_MEMBER_CODES[row.ReportingEconomyCode] ?? row.ReportingEconomy ?? '',
    countryCode: String(row.ReportingEconomyCode ?? ''),
    year: parseInt(row.Year ?? row.year ?? '0', 10),
    value: parseFloat(row.Value ?? row.value ?? ''),
  })).filter((r) => !isNaN(r.year) && !isNaN(r.value));
}

module.exports = async function fetchTrade({ config, redis, log, http }) {
  log.debug('fetchTrade executing');
  const timestamp = new Date().toISOString();

  const apiKey = config?.WTO_API_KEY || process.env.WTO_API_KEY;
  if (!apiKey) {
    log.warn('fetchTrade: WTO_API_KEY not set');
    return {
      timestamp,
      source: 'trade',
      data: [],
      status: 'error',
      errors: ['WTO_API_KEY not configured'],
    };
  }

  try {
    const currentYear = new Date().getFullYear();
    const reporters = MAJOR_REPORTERS.join(',');
    const [agriData, nonAgriData] = await Promise.all([
      wtoFetch('/data', { i: 'TP_A_0160', r: reporters, ps: `${currentYear - 3}-${currentYear}`, fmt: 'json', mode: 'full', max: '500' }, apiKey, http),
      wtoFetch('/data', { i: 'TP_A_0430', r: reporters, ps: `${currentYear - 3}-${currentYear}`, fmt: 'json', mode: 'full', max: '500' }, apiKey, http),
    ]);

    if (!agriData && !nonAgriData) {
      return {
        timestamp,
        source: 'trade',
        data: [],
        status: 'success',
        upstreamUnavailable: true,
      };
    }

    const agriRows = agriData ? parseRows(agriData) : [];
    const nonAgriRows = nonAgriData ? parseRows(nonAgriData) : [];

    const latestAgri = new Map();
    for (const row of agriRows) {
      const ex = latestAgri.get(row.countryCode);
      if (!ex || row.year > ex.year) latestAgri.set(row.countryCode, row);
    }
    const latestNonAgri = new Map();
    for (const row of nonAgriRows) {
      const ex = latestNonAgri.get(row.countryCode);
      if (!ex || row.year > ex.year) latestNonAgri.set(row.countryCode, row);
    }

    const barriers = [];
    const allCodes = new Set([...latestAgri.keys(), ...latestNonAgri.keys()]);
    for (const code of allCodes) {
      const agri = latestAgri.get(code);
      const nonAgri = latestNonAgri.get(code);
      const agriRate = agri?.value ?? 0;
      const nonAgriRate = nonAgri?.value ?? 0;
      const gap = agriRate - nonAgriRate;
      const country = agri?.country ?? nonAgri?.country ?? code;
      const year = String(agri?.year ?? nonAgri?.year ?? '');
      barriers.push({
        id: `${code}-tariff-gap-${year}`,
        notifyingCountry: country,
        title: `Agricultural tariff: ${agriRate.toFixed(1)}% vs Non-agricultural: ${nonAgriRate.toFixed(1)} (gap: ${gap > 0 ? '+' : ''}${gap.toFixed(1)}pp)`,
        measureType: gap > 10 ? 'High agricultural protection' : gap > 5 ? 'Moderate agricultural protection' : 'Low tariff gap',
        productDescription: 'Agricultural vs Non-agricultural products',
        objective: gap > 0 ? 'Agricultural sector protection' : 'Uniform tariff structure',
        status: gap > 10 ? 'high' : gap > 5 ? 'moderate' : 'low',
        dateDistributed: year,
        sourceUrl: 'https://stats.wto.org',
      });
    }
    barriers.sort((a, b) => {
      const gapA = parseFloat(a.title.match(/gap: ([+-]?\d+\.?\d*)/)?.[1] ?? '0');
      const gapB = parseFloat(b.title.match(/gap: ([+-]?\d+\.?\d*)/)?.[1] ?? '0');
      return gapB - gapA;
    });

    const data = barriers.slice(0, 50);
    if (!Array.isArray(data)) {
      return {
        timestamp,
        source: 'trade',
        data: [],
        status: 'error',
        errors: ['Invalid trade response: expected array'],
      };
    }

    return {
      timestamp,
      source: 'trade',
      data,
      status: 'success',
      upstreamUnavailable: false,
    };
  } catch (err) {
    log.error('fetchTrade error', { error: err?.message ?? err });
    return {
      timestamp,
      source: 'trade',
      data: [],
      status: 'error',
      errors: [err?.message ?? String(err)],
    };
  }
};
