'use strict';

// Extracted from scripts/ais-relay.cjs - GDELT Doc API proxy logic
// API: GDELT Project Doc API (global events database)

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const GDELT_TIMEOUT_MS = 12_000;

const DEFAULT_QUERY = 'global security conflict';

module.exports = async function fetchGdelt({ config, redis, log, http }) {
  log.debug('fetchGdelt executing');
  const timestamp = new Date().toISOString();

  const query = config?.GDELT_DEFAULT_QUERY || process.env.GDELT_DEFAULT_QUERY || DEFAULT_QUERY;
  const maxRecords = Math.min(parseInt(config?.GDELT_MAX_RECORDS || process.env.GDELT_MAX_RECORDS || '10', 10) || 10, 20);
  const timespan = config?.GDELT_TIMESPAN || process.env.GDELT_TIMESPAN || '24h';
  const sort = config?.GDELT_SORT || process.env.GDELT_SORT || 'date';

  try {
    const gdeltUrl = new URL('https://api.gdeltproject.org/api/v2/doc/doc');
    gdeltUrl.searchParams.set('query', query);
    gdeltUrl.searchParams.set('mode', 'artlist');
    gdeltUrl.searchParams.set('maxrecords', String(maxRecords));
    gdeltUrl.searchParams.set('format', 'json');
    gdeltUrl.searchParams.set('sort', sort);
    gdeltUrl.searchParams.set('timespan', timespan);

    const raw = await http.fetchJson(gdeltUrl.toString(), {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      timeout: GDELT_TIMEOUT_MS,
    });

    const articles = (raw?.articles || []).map((a) => ({
      title: a.title || '',
      url: a.url || '',
      source: a.domain || a.source?.domain || '',
      date: a.seendate || '',
      image: a.socialimage || '',
      language: a.language || '',
      tone: typeof a.tone === 'number' ? a.tone : 0,
    }));

    return {
      timestamp,
      source: 'gdelt',
      data: {
        articles,
        query,
      },
      status: 'success',
    };
  } catch (err) {
    log.error('fetchGdelt error', { error: err?.message ?? err });
    return {
      timestamp,
      source: 'gdelt',
      data: { articles: [], query },
      status: 'error',
      errors: [err?.message ?? String(err)],
    };
  }
};
