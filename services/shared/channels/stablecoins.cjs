'use strict';

// Extracted from scripts/ais-relay.cjs - Stablecoin market cap and peg tracking
// API: CoinGecko

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const TIMEOUT_MS = 10_000;

module.exports = async function fetchStablecoins({ config, redis, log, http }) {
  log.debug('fetchStablecoins executing');
  const timestamp = new Date().toISOString();

  try {
    const coins = 'tether,usd-coin,dai,first-digital-usd,ethena-usde';
    const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${coins}&order=market_cap_desc&sparkline=false&price_change_percentage=7d`;

    const data = await http.fetchJson(url, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      timeout: TIMEOUT_MS,
    });

    if (!Array.isArray(data)) {
      return {
        timestamp,
        source: 'stablecoins',
        data: [],
        status: 'error',
        errors: ['Invalid CoinGecko response: expected array'],
      };
    }

    const stablecoins = data.map((coin) => {
      const price = coin.current_price || 0;
      const deviation = Math.abs(price - 1.0);
      let pegStatus;
      if (deviation <= 0.005) pegStatus = 'ON PEG';
      else if (deviation <= 0.01) pegStatus = 'SLIGHT DEPEG';
      else pegStatus = 'DEPEGGED';
      return {
        id: coin.id,
        symbol: (coin.symbol || '').toUpperCase(),
        name: coin.name,
        price,
        deviation: +(deviation * 100).toFixed(3),
        pegStatus,
        marketCap: coin.market_cap || 0,
        volume24h: coin.total_volume || 0,
        change24h: coin.price_change_percentage_24h || 0,
        change7d: coin.price_change_percentage_7d_in_currency || 0,
        image: coin.image || '',
      };
    });

    const totalMarketCap = stablecoins.reduce((s, c) => s + c.marketCap, 0);
    const totalVolume24h = stablecoins.reduce((s, c) => s + c.volume24h, 0);
    const depeggedCount = stablecoins.filter((c) => c.pegStatus === 'DEPEGGED').length;

    return {
      timestamp,
      source: 'stablecoins',
      data: stablecoins,
      status: 'success',
      summary: {
        totalMarketCap,
        totalVolume24h,
        coinCount: stablecoins.length,
        depeggedCount,
        healthStatus: depeggedCount === 0 ? 'HEALTHY' : depeggedCount === 1 ? 'CAUTION' : 'WARNING',
      },
    };
  } catch (err) {
    const isRateLimited = err?.message?.includes('429') || err?.message?.includes('rate limit');
    log.error('fetchStablecoins error', { error: err?.message ?? err });
    return {
      timestamp,
      source: 'stablecoins',
      data: [],
      status: 'error',
      errors: [err?.message ?? String(err)],
      rateLimited: isRateLimited,
    };
  }
};
