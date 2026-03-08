'use strict';

// Extracted from scripts/ais-relay.cjs - Polymarket Gamma API prediction markets

const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const TIMEOUT_MS = 8_000;

module.exports = async function fetchPredictions({ config, redis, log, http }) {
  log.debug('fetchPredictions executing');
  const timestamp = new Date().toISOString();

  try {
    const params = new URLSearchParams({
      closed: 'false',
      active: 'true',
      archived: 'false',
      end_date_min: new Date().toISOString(),
      order: 'volume',
      ascending: 'false',
      limit: '50',
    });
    const data = await http.fetchJson(`${GAMMA_BASE}/markets?${params}`, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      timeout: TIMEOUT_MS,
    });

    const raw = Array.isArray(data) ? data : [];
    const markets = raw.map((m) => {
      let yesPrice = 0.5;
      try {
        const prices = m.outcomePrices ? JSON.parse(m.outcomePrices) : [];
        if (prices.length >= 1) yesPrice = parseFloat(prices[0]) || 0.5;
      } catch {
        /* ignore */
      }
      const closesAtMs = m.endDate ? Date.parse(m.endDate) : 0;
      return {
        id: m.slug || '',
        title: m.question || '',
        yesPrice,
        volume: (m.volumeNum ?? (m.volume ? parseFloat(m.volume) : 0)) || 0,
        url: `https://polymarket.com/market/${m.slug}`,
        closesAt: Number.isFinite(closesAtMs) ? closesAtMs : 0,
        category: '',
      };
    });

    const dataArray = Array.isArray(markets) ? markets : [];
    return {
      timestamp,
      source: 'predictions',
      data: dataArray,
      status: 'success',
    };
  } catch (err) {
    log.error('fetchPredictions error', { error: err?.message ?? err });
    return {
      timestamp,
      source: 'predictions',
      data: [],
      status: 'error',
      errors: [err?.message ?? String(err)],
    };
  }
};
