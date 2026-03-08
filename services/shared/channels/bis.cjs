'use strict';

// Extracted from scripts/ais-relay.cjs - Bank for International Settlements policy rates

const BIS_BASE = 'https://stats.bis.org/api/v1/data';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const TIMEOUT_MS = 12_000;

const BIS_COUNTRIES = {
  US: { name: 'United States', centralBank: 'Federal Reserve' },
  GB: { name: 'United Kingdom', centralBank: 'Bank of England' },
  JP: { name: 'Japan', centralBank: 'Bank of Japan' },
  XM: { name: 'Euro Area', centralBank: 'ECB' },
  CH: { name: 'Switzerland', centralBank: 'Swiss National Bank' },
  SG: { name: 'Singapore', centralBank: 'MAS' },
  IN: { name: 'India', centralBank: 'Reserve Bank of India' },
  AU: { name: 'Australia', centralBank: 'RBA' },
  CN: { name: 'China', centralBank: "People's Bank of China" },
  CA: { name: 'Canada', centralBank: 'Bank of Canada' },
  KR: { name: 'South Korea', centralBank: 'Bank of Korea' },
  BR: { name: 'Brazil', centralBank: 'Banco Central do Brasil' },
};
const BIS_COUNTRY_KEYS = Object.keys(BIS_COUNTRIES).join('+');

function parseBisCsv(csv) {
  const lines = (csv || '').trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',').map((v) => v.trim());
    if (vals.length < headers.length) continue;
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = vals[idx];
    });
    rows.push(row);
  }
  return rows;
}

function parseBisNumber(val) {
  if (!val || val === '.' || String(val).trim() === '') return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

module.exports = async function fetchBis({ config, redis, log, http }) {
  log.debug('fetchBis executing');
  const timestamp = new Date().toISOString();

  try {
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
    const startPeriod = `${threeMonthsAgo.getFullYear()}-${String(threeMonthsAgo.getMonth() + 1).padStart(2, '0')}`;
    const url = `${BIS_BASE}/WS_CBPOL/M.${BIS_COUNTRY_KEYS}?startPeriod=${startPeriod}&detail=dataonly&format=csv`;

    const csv = await http.fetchText(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/csv' },
      timeout: TIMEOUT_MS,
    });

    const rows = parseBisCsv(csv);
    const byCountry = new Map();
    for (const row of rows) {
      const cc = row['REF_AREA'] || row['Reference area'] || '';
      const date = row['TIME_PERIOD'] || row['Time period'] || '';
      const val = parseBisNumber(row['OBS_VALUE'] || row['Observation value']);
      if (!cc || !date || val === null) continue;
      if (!byCountry.has(cc)) byCountry.set(cc, []);
      byCountry.get(cc).push({ date, value: val });
    }

    const rates = [];
    for (const [cc, obs] of byCountry) {
      const info = BIS_COUNTRIES[cc];
      if (!info) continue;
      obs.sort((a, b) => a.date.localeCompare(b.date));
      const latest = obs[obs.length - 1];
      const previous = obs.length >= 2 ? obs[obs.length - 2] : undefined;
      if (latest) {
        rates.push({
          countryCode: cc,
          countryName: info.name,
          rate: latest.value,
          previousRate: previous?.value ?? latest.value,
          date: latest.date,
          centralBank: info.centralBank,
        });
      }
    }

    const data = Array.isArray(rates) ? rates : [];
    return {
      timestamp,
      source: 'bis',
      data,
      status: 'success',
    };
  } catch (err) {
    log.error('fetchBis error', { error: err?.message ?? err });
    return {
      timestamp,
      source: 'bis',
      data: [],
      status: 'error',
      errors: [err?.message ?? String(err)],
    };
  }
};
