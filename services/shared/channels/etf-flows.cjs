'use strict';

// Extracted from scripts/ais-relay.cjs - ETF fund flows (Bitcoin spot ETFs)
// API: Yahoo Finance

const ETF_LIST = [
  { ticker: 'IBIT', issuer: 'BlackRock' },
  { ticker: 'FBTC', issuer: 'Fidelity' },
  { ticker: 'ARKB', issuer: 'ARK/21Shares' },
  { ticker: 'BITB', issuer: 'Bitwise' },
  { ticker: 'GBTC', issuer: 'Grayscale' },
  { ticker: 'HODL', issuer: 'VanEck' },
  { ticker: 'BRRR', issuer: 'Valkyrie' },
  { ticker: 'EZBC', issuer: 'Franklin' },
  { ticker: 'BTCO', issuer: 'Invesco' },
  { ticker: 'BTCW', issuer: 'WisdomTree' },
];

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const TIMEOUT_MS = 10_000;
const YAHOO_MIN_GAP_MS = 350;

let yahooLastRequest = 0;
let yahooQueue = Promise.resolve();
function yahooGate() {
  yahooQueue = yahooQueue.then(async () => {
    const elapsed = Date.now() - yahooLastRequest;
    if (elapsed < YAHOO_MIN_GAP_MS) {
      await new Promise((r) => setTimeout(r, YAHOO_MIN_GAP_MS - elapsed));
    }
    yahooLastRequest = Date.now();
  });
  return yahooQueue;
}

function parseEtfChartData(chart, ticker, issuer) {
  try {
    const result = chart?.chart?.result?.[0];
    if (!result) return null;
    const quote = result.indicators?.quote?.[0];
    const closes = (quote?.close || []).filter((v) => v != null);
    const volumes = (quote?.volume || []).filter((v) => v != null);
    if (closes.length < 2) return null;
    const latestPrice = closes[closes.length - 1];
    const prevPrice = closes[closes.length - 2];
    const priceChange = prevPrice ? ((latestPrice - prevPrice) / prevPrice) * 100 : 0;
    const latestVolume = volumes.length > 0 ? volumes[volumes.length - 1] : 0;
    const avgVolume = volumes.length > 1 ? volumes.slice(0, -1).reduce((a, b) => a + b, 0) / (volumes.length - 1) : latestVolume;
    const volumeRatio = avgVolume > 0 ? latestVolume / avgVolume : 1;
    const direction = priceChange > 0.1 ? 'inflow' : priceChange < -0.1 ? 'outflow' : 'neutral';
    const estFlowMagnitude = latestVolume * latestPrice * (priceChange > 0 ? 1 : -1) * 0.1;
    return {
      ticker,
      issuer,
      price: +latestPrice.toFixed(2),
      priceChange: +priceChange.toFixed(2),
      volume: latestVolume,
      avgVolume: Math.round(avgVolume),
      volumeRatio: +volumeRatio.toFixed(2),
      direction,
      estFlow: Math.round(estFlowMagnitude),
    };
  } catch {
    return null;
  }
}

module.exports = async function fetchEtfFlows({ config, redis, log, http }) {
  log.debug('fetchEtfFlows executing');
  const timestamp = new Date().toISOString();

  try {
    const etfs = [];
    let misses = 0;

    for (const etf of ETF_LIST) {
      await yahooGate();
      const chart = await http.fetchJson(
        `https://query1.finance.yahoo.com/v8/finance/chart/${etf.ticker}?range=5d&interval=1d`,
        {
          headers: { 'User-Agent': USER_AGENT },
          timeout: TIMEOUT_MS,
        }
      ).catch(() => null);

      if (chart) {
        const parsed = parseEtfChartData(chart, etf.ticker, etf.issuer);
        if (parsed) etfs.push(parsed);
        else misses++;
      } else {
        misses++;
      }
      if (misses >= 3 && etfs.length === 0) break;
    }

    if (!Array.isArray(etfs)) {
      return {
        timestamp,
        source: 'etf-flows',
        data: [],
        status: 'error',
        errors: ['Invalid ETF response: expected array'],
      };
    }

    const totalVolume = etfs.reduce((s, e) => s + e.volume, 0);
    const totalEstFlow = etfs.reduce((s, e) => s + e.estFlow, 0);
    etfs.sort((a, b) => b.volume - a.volume);

    return {
      timestamp,
      source: 'etf-flows',
      data: etfs,
      status: 'success',
      summary: {
        etfCount: etfs.length,
        totalVolume,
        totalEstFlow,
        netDirection: totalEstFlow > 0 ? 'NET INFLOW' : totalEstFlow < 0 ? 'NET OUTFLOW' : 'NEUTRAL',
        inflowCount: etfs.filter((e) => e.direction === 'inflow').length,
        outflowCount: etfs.filter((e) => e.direction === 'outflow').length,
      },
      rateLimited: misses >= 3 && etfs.length === 0,
    };
  } catch (err) {
    log.error('fetchEtfFlows error', { error: err?.message ?? err });
    return {
      timestamp,
      source: 'etf-flows',
      data: [],
      status: 'error',
      errors: [err?.message ?? String(err)],
    };
  }
};
