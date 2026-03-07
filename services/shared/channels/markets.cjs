'use strict';

// Extracted from scripts/ais-relay.cjs - market data fetching logic
// APIs: Supabase get_market_symbols, Finnhub, Yahoo Finance, CoinGecko

const PHASE3C_TIMEOUT_MS = 15_000;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const CRYPTO_META = {
  bitcoin: { name: 'Bitcoin', symbol: 'BTC' },
  ethereum: { name: 'Ethereum', symbol: 'ETH' },
  solana: { name: 'Solana', symbol: 'SOL' },
  ripple: { name: 'XRP', symbol: 'XRP' },
};

function isYahooOnlySymbol(s) {
  return s.startsWith('^') || s.includes('=');
}

// Yahoo rate-limit gate (min 350ms between requests)
let yahooLastRequest = 0;
const YAHOO_MIN_GAP_MS = 350;
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

async function fetchMarketSymbols(config, http) {
  if (!config?.SUPABASE_URL || !config?.SUPABASE_ANON_KEY) return null;
  try {
    const url = `${config.SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/rpc/get_market_symbols`;
    const data = await http.fetchJson(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: config.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${config.SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({}),
    });
    if (!data) return null;
    return data;
  } catch (err) {
    return null;
  }
}

async function fetchFinnhubQuote(symbol, apiKey, http) {
  if (!apiKey) return null;
  try {
    const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}`;
    const data = await http.fetchJson(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
        'X-Finnhub-Token': apiKey,
      },
      timeout: PHASE3C_TIMEOUT_MS,
    });
    if (data && (data.c !== 0 || data.h !== 0 || data.l !== 0)) {
      return { symbol, price: data.c, changePercent: data.dp };
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchYahooQuote(symbol, http) {
  await yahooGate();
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`;
    const chart = await http.fetchJson(url, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: PHASE3C_TIMEOUT_MS,
    });
    const result = chart?.chart?.result?.[0];
    const quote = result?.indicators?.quote?.[0];
    const closes = (quote?.close || []).filter((v) => v != null);
    const price = closes.length > 0 ? closes[closes.length - 1] : result?.meta?.regularMarketPrice;
    const prev = closes.length >= 2 ? closes[closes.length - 2] : result?.chartPreviousClose;
    const change = prev && price ? ((price - prev) / prev) * 100 : 0;
    return price != null ? { price, change, sparkline: closes.slice(-48) } : null;
  } catch {
    return null;
  }
}

async function fetchCoinGeckoMarkets(ids, http) {
  if (!ids || ids.length === 0) return [];
  try {
    const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids.join(',')}&sparkline=true&price_change_percentage=24h`;
    const data = await http.fetchJson(url, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      timeout: PHASE3C_TIMEOUT_MS,
    });
    if (Array.isArray(data)) return data;
    return [];
  } catch (err) {
    if (err?.message?.includes('429')) throw new Error('CoinGecko rate limited');
    return [];
  }
}

function flattenToDataArray(stocks, commodities, sectors, crypto) {
  const data = [];
  for (const s of stocks || []) {
    data.push({ category: 'stock', symbol: s.symbol, name: s.name, price: s.price, change: s.change });
  }
  for (const c of commodities || []) {
    data.push({ category: 'commodity', symbol: c.symbol, name: c.name, price: c.price, change: c.change });
  }
  for (const s of sectors || []) {
    data.push({ category: 'sector', symbol: s.symbol, name: s.name, change: s.change });
  }
  for (const c of crypto || []) {
    data.push({ category: 'crypto', symbol: c.symbol, name: c.name, price: c.price, change: c.change });
  }
  return data;
}

module.exports = async function fetchMarkets({ config, redis, log, http }) {
  log.debug('fetchMarkets executing');
  const timestamp = new Date().toISOString();

  try {
    const symbolConfig = await fetchMarketSymbols(config, http);
    if (!symbolConfig) {
      log.warn('fetchMarkets: symbol config unavailable');
      return {
        timestamp,
        source: 'markets',
        status: 'success',
        data: [],
        stocks: [],
        commodities: [],
        sectors: [],
        crypto: [],
        finnhubSkipped: true,
        skipReason: 'Symbol config unavailable',
        rateLimited: false,
      };
    }

    const apiKey = process.env.FINNHUB_API_KEY;
    if (!apiKey) log.warn('fetchMarkets: FINNHUB_API_KEY not set — using Yahoo fallback only');

    const stockSymbols = (symbolConfig.stock || []).map((s) => s.symbol);
    const commoditySymbols = (symbolConfig.commodity || []).map((s) => s.symbol);
    const sectorSymbols = (symbolConfig.sector || []).map((s) => s.symbol);
    const cryptoIds = (symbolConfig.crypto || []).map((s) => s.symbol);

    const stockMeta = new Map((symbolConfig.stock || []).map((e) => [e.symbol, e]));
    const commodityMeta = new Map((symbolConfig.commodity || []).map((e) => [e.symbol, e]));
    const sectorMeta = new Map((symbolConfig.sector || []).map((e) => [e.symbol, e]));

    const finnhubSymbols = stockSymbols.filter((s) => !isYahooOnlySymbol(s));
    const allFinnhubSymbols = apiKey ? [...finnhubSymbols, ...sectorSymbols] : [];
    const yahooStockSymbols = [
      ...stockSymbols.filter(isYahooOnlySymbol),
      ...(!apiKey ? finnhubSymbols : []),
    ];
    const yahooSectorFallback = !apiKey ? sectorSymbols : [];

    const [
      finnhubResults,
      yahooCommodityResults,
      yahooStockResults,
      yahooSectorResults,
      cryptoResults,
    ] = await Promise.allSettled([
      allFinnhubSymbols.length > 0
        ? Promise.all(
            allFinnhubSymbols.map((s) =>
              fetchFinnhubQuote(s, apiKey || '', http).then((r) => (r ? { ...r, symbol: s } : null))
            )
          )
        : Promise.resolve([]),
      commoditySymbols.length > 0
        ? Promise.all(
            commoditySymbols.map((s) =>
              fetchYahooQuote(s, http).then((q) => (q ? { symbol: s, ...q } : null))
            )
          )
        : Promise.resolve([]),
      yahooStockSymbols.length > 0
        ? Promise.all(
            yahooStockSymbols.map((s) =>
              fetchYahooQuote(s, http).then((q) => (q ? { symbol: s, ...q } : null))
            )
          )
        : Promise.resolve([]),
      yahooSectorFallback.length > 0
        ? Promise.all(
            yahooSectorFallback.map((s) =>
              fetchYahooQuote(s, http).then((q) => (q ? { symbol: s, ...q } : null))
            )
          )
        : Promise.resolve([]),
      cryptoIds.length > 0 ? fetchCoinGeckoMarkets(cryptoIds, http) : Promise.resolve([]),
    ]);

    const finnhubData = finnhubResults.status === 'fulfilled' ? finnhubResults.value : [];
    const yahooCommodity =
      yahooCommodityResults.status === 'fulfilled'
        ? (yahooCommodityResults.value || []).filter(Boolean)
        : [];
    const yahooStock =
      yahooStockResults.status === 'fulfilled'
        ? (yahooStockResults.value || []).filter(Boolean)
        : [];
    const yahooSector =
      yahooSectorResults.status === 'fulfilled'
        ? (yahooSectorResults.value || []).filter(Boolean)
        : [];
    let cryptoData = cryptoResults.status === 'fulfilled' ? cryptoResults.value : [];
    if (cryptoResults.status === 'rejected' && cryptoResults.reason?.message?.includes('429')) {
      cryptoData = [];
    }

    const yahooMap = new Map();
    for (const x of [...yahooCommodity, ...yahooStock, ...yahooSector]) {
      if (x && x.symbol) {
        yahooMap.set(x.symbol, {
          price: x.price,
          change: x.change,
          sparkline: x.sparkline || [],
        });
      }
    }

    const stocks = [];
    const finnhubHits = new Set();
    for (const r of finnhubData) {
      if (r) {
        finnhubHits.add(r.symbol);
        const meta = stockMeta.get(r.symbol);
        stocks.push({
          symbol: r.symbol,
          name: meta?.name ?? r.symbol,
          display: meta?.display ?? r.symbol,
          price: r.price,
          change: r.changePercent,
          sparkline: [],
        });
      }
    }
    const missedFinnhub = apiKey ? finnhubSymbols.filter((s) => !finnhubHits.has(s)) : finnhubSymbols;
    for (const s of [...stockSymbols.filter(isYahooOnlySymbol), ...missedFinnhub]) {
      if (finnhubHits.has(s)) continue;
      const y = yahooMap.get(s);
      if (y) {
        const meta = stockMeta.get(s);
        stocks.push({
          symbol: s,
          name: meta?.name ?? s,
          display: meta?.display ?? s,
          price: y.price,
          change: y.change,
          sparkline: y.sparkline,
        });
      }
    }
    const stockOrder = new Map(stockSymbols.map((s, i) => [s, i]));
    stocks.sort((a, b) => (stockOrder.get(a.symbol) ?? 999) - (stockOrder.get(b.symbol) ?? 999));

    const commodities = commoditySymbols
      .map((s) => {
        const y = yahooMap.get(s);
        if (!y) return null;
        const meta = commodityMeta.get(s);
        return {
          symbol: s,
          name: meta?.name ?? s,
          display: meta?.display ?? s,
          price: y.price,
          change: y.change,
          sparkline: y.sparkline,
        };
      })
      .filter(Boolean);

    const sectorFinnhubHits = new Set();
    const sectors = [];
    for (const r of finnhubData) {
      if (r && sectorSymbols.includes(r.symbol)) {
        sectorFinnhubHits.add(r.symbol);
        const meta = sectorMeta.get(r.symbol);
        sectors.push({
          symbol: r.symbol,
          name: meta?.name ?? r.symbol,
          change: r.changePercent,
        });
      }
    }
    for (const s of sectorSymbols) {
      if (sectorFinnhubHits.has(s)) continue;
      const y = yahooMap.get(s);
      if (y) {
        const meta = sectorMeta.get(s);
        sectors.push({ symbol: s, name: meta?.name ?? s, change: y.change });
      }
    }

    const crypto = [];
    const cryptoById = new Map((cryptoData || []).map((c) => [c.id, c]));
    for (const id of cryptoIds) {
      const coin = cryptoById.get(id);
      if (!coin) continue;
      const configEntry = (symbolConfig.crypto || []).find((c) => c.symbol === id);
      const meta = CRYPTO_META[id];
      const prices = coin.sparkline_in_7d?.price;
      const sparkline = prices && prices.length > 24 ? prices.slice(-48) : (prices || []);
      crypto.push({
        name: configEntry?.name ?? meta?.name ?? id,
        symbol: configEntry?.display ?? meta?.symbol ?? id.toUpperCase(),
        price: coin.current_price ?? 0,
        change: coin.price_change_percentage_24h ?? 0,
        sparkline,
      });
    }

    const hasData =
      stocks.length > 0 ||
      commodities.length > 0 ||
      sectors.length > 0 ||
      crypto.length > 0;

    const coveredByYahoo = finnhubSymbols.every((s) => stocks.some((q) => q.symbol === s));
    const skipped = !apiKey && !coveredByYahoo;

    const data = flattenToDataArray(stocks, commodities, sectors, crypto);

    return {
      timestamp,
      source: 'markets',
      status: 'success',
      data,
      stocks,
      commodities,
      sectors,
      crypto,
      finnhubSkipped: skipped,
      skipReason: skipped ? 'FINNHUB_API_KEY not configured' : '',
      rateLimited: false,
    };
  } catch (err) {
    log.error('fetchMarkets error', { error: err?.message ?? err });
    return {
      timestamp,
      source: 'markets',
      status: 'error',
      data: [],
      stocks: [],
      commodities: [],
      sectors: [],
      crypto: [],
      errors: [err?.message ?? String(err)],
    };
  }
};
