'use strict';

// Extracted from scripts/ais-relay.cjs - Uppsala Conflict Data Program GED events
// API: ucdpapi.pcr.uu.se/api/gedevents/{version}

const UCDP_PAGE_SIZE = 1000;
const UCDP_MAX_PAGES = 12;
const UCDP_TRAILING_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;
const UCDP_FETCH_TIMEOUT = 30000;
const UCDP_VIOLENCE_TYPE_MAP = {
  1: 'state-based',
  2: 'non-state',
  3: 'one-sided',
};

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

function ucdpParseDateMs(value) {
  if (!value) return NaN;
  return Date.parse(String(value));
}

function ucdpGetMaxDateMs(events) {
  let maxMs = NaN;
  for (const event of events) {
    const ms = ucdpParseDateMs(event?.date_start);
    if (!Number.isFinite(ms)) continue;
    if (!Number.isFinite(maxMs) || ms > maxMs) maxMs = ms;
  }
  return maxMs;
}

function ucdpBuildVersionCandidates() {
  const year = new Date().getFullYear() - 2000;
  return Array.from(new Set([`${year}.1`, `${year - 1}.1`, '25.1', '24.1']));
}

async function ucdpFetchPage(version, page, http, headers) {
  const url = `https://ucdpapi.pcr.uu.se/api/gedevents/${version}?pagesize=${UCDP_PAGE_SIZE}&page=${page}`;
  const data = await http.fetchJson(url, {
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT, ...headers },
    timeout: UCDP_FETCH_TIMEOUT,
  });
  return data;
}

async function ucdpDiscoverVersion(http, headers) {
  const candidates = ucdpBuildVersionCandidates();
  for (const version of candidates) {
    try {
      const page0 = await ucdpFetchPage(version, 0, http, headers);
      if (Array.isArray(page0?.Result)) return { version, page0 };
    } catch {
      /* next candidate */
    }
  }
  throw new Error('No valid UCDP GED version found');
}

module.exports = async function fetchUcdpEvents({ config, redis, log, http }) {
  log.debug('fetchUcdpEvents executing');
  const timestamp = new Date().toISOString();

  const token = (config?.UCDP_ACCESS_TOKEN || process.env.UCDP_ACCESS_TOKEN || process.env.UC_DP_KEY || '').trim();
  const headers = token ? { 'x-ucdp-access-token': token } : {};

  try {
    const { version, page0 } = await ucdpDiscoverVersion(http, headers);
    const totalPages = Math.max(1, Number(page0?.TotalPages) || 1);
    const newestPage = totalPages - 1;

    let allEvents = [];
    let latestDatasetMs = NaN;

    for (let offset = 0; offset < UCDP_MAX_PAGES && (newestPage - offset) >= 0; offset++) {
      const page = newestPage - offset;
      const rawData = page === 0 ? page0 : await ucdpFetchPage(version, page, http, headers);
      const events = Array.isArray(rawData?.Result) ? rawData.Result : [];
      allEvents = allEvents.concat(events);

      const pageMaxMs = ucdpGetMaxDateMs(events);
      if (!Number.isFinite(latestDatasetMs) && Number.isFinite(pageMaxMs)) {
        latestDatasetMs = pageMaxMs;
      }
      if (Number.isFinite(latestDatasetMs) && Number.isFinite(pageMaxMs)) {
        if (pageMaxMs < latestDatasetMs - UCDP_TRAILING_WINDOW_MS) break;
      }
    }

    const sanitized = allEvents
      .filter((e) => {
        if (!Number.isFinite(latestDatasetMs)) return true;
        const ms = ucdpParseDateMs(e?.date_start);
        return Number.isFinite(ms) && ms >= (latestDatasetMs - UCDP_TRAILING_WINDOW_MS);
      })
      .map((e) => ({
        id: String(e.id || ''),
        date_start: e.date_start || '',
        date_end: e.date_end || '',
        latitude: Number(e.latitude) || 0,
        longitude: Number(e.longitude) || 0,
        country: e.country || '',
        side_a: (e.side_a || '').substring(0, 200),
        side_b: (e.side_b || '').substring(0, 200),
        deaths_best: Number(e.best) || 0,
        deaths_low: Number(e.low) || 0,
        deaths_high: Number(e.high) || 0,
        type_of_violence: UCDP_VIOLENCE_TYPE_MAP[e.type_of_violence] || 'state-based',
        source_original: (e.source_original || '').substring(0, 300),
      }))
      .sort((a, b) => {
        const bMs = ucdpParseDateMs(b.date_start);
        const aMs = ucdpParseDateMs(a.date_start);
        return (Number.isFinite(bMs) ? bMs : 0) - (Number.isFinite(aMs) ? aMs : 0);
      });

    if (!Array.isArray(sanitized)) {
      return {
        timestamp,
        source: 'ucdp-events',
        data: { events: [], version, fetchedAt: new Date().toISOString() },
        status: 'error',
        errors: ['UCDP API returned invalid events array'],
      };
    }

    return {
      timestamp,
      source: 'ucdp-events',
      data: {
        events: sanitized,
        version,
        fetchedAt: new Date().toISOString(),
        count: sanitized.length,
      },
      status: 'success',
    };
  } catch (err) {
    log.error('fetchUcdpEvents error', { error: err?.message ?? err });
    return {
      timestamp,
      source: 'ucdp-events',
      data: { events: [], version: '', fetchedAt: new Date().toISOString() },
      status: 'error',
      errors: [err?.message ?? String(err)],
    };
  }
};
