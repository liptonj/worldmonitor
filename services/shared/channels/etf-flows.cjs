'use strict';

const { fetchFinnhubStockCandle } = require('../finnhub-client.cjs');

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

function parseEtfCandleData(candle, ticker, issuer) {
  try {
    const closes = candle.closes.filter((v) => v != null);
    const volumes = candle.volumes.filter((v) => v != null);
    if (closes.length < 2) return null;
    const latestPrice = closes[closes.length - 1];
    const prevPrice = closes[closes.length - 2];
    const priceChange = prevPrice ? ((latestPrice - prevPrice) / prevPrice) * 100 : 0;
    const latestVolume = volumes.length > 0 ? volumes[volumes.length - 1] : 0;
    const avgVolume =
      volumes.length > 1
        ? volumes.slice(0, -1).reduce((a, b) => a + b, 0) / (volumes.length - 1)
        : latestVolume;
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
    const apiKey = config?.FINNHUB_API_KEY || process.env.FINNHUB_API_KEY;
    if (!apiKey) {
      log.warn('fetchEtfFlows: FINNHUB_API_KEY not set — cannot fetch ETF data');
      return {
        timestamp,
        source: 'etf-flows',
        data: [],
        status: 'success',
        summary: {
          etfCount: 0,
          totalVolume: 0,
          totalEstFlow: 0,
          netDirection: 'NEUTRAL',
          inflowCount: 0,
          outflowCount: 0,
        },
        rateLimited: false,
      };
    }

    const candleResults = await Promise.all(
      ETF_LIST.map((etf) =>
        fetchFinnhubStockCandle(etf.ticker, apiKey, http, { days: 7 }).then((candle) => ({
          etf,
          candle,
        }))
      )
    );

    const etfs = [];
    let misses = 0;
    for (const { etf, candle } of candleResults) {
      if (candle) {
        const parsed = parseEtfCandleData(candle, etf.ticker, etf.issuer);
        if (parsed) etfs.push(parsed);
        else misses++;
      } else {
        misses++;
      }
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
        netDirection:
          totalEstFlow > 0 ? 'NET INFLOW' : totalEstFlow < 0 ? 'NET OUTFLOW' : 'NEUTRAL',
        inflowCount: etfs.filter((e) => e.direction === 'inflow').length,
        outflowCount: etfs.filter((e) => e.direction === 'outflow').length,
      },
      rateLimited: false,
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
