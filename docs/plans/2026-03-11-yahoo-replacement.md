# Yahoo Finance Replacement Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace most Yahoo Finance API calls with Finnhub and CoinGecko to eliminate HTTP 429 rate-limiting.

**Architecture:** Expand Finnhub (free tier, 60 calls/min) to cover all US equities/ETFs. Use CoinGecko (already integrated) for BTC history. Keep Yahoo only for commodities and Gulf quotes behind a shared global rate limiter.

**Tech Stack:** Node.js CommonJS modules, Finnhub REST API, CoinGecko API, Yahoo Finance (reduced)

---

### Task 1: Create Shared Yahoo Rate Limiter

**Files:**
- Create: `services/shared/yahoo-gate.cjs`

**Step 1: Create the shared module**

```javascript
'use strict';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MIN_GAP_MS = 500;
const TIMEOUT_MS = 15_000;

let lastRequest = 0;
let queue = Promise.resolve();

function yahooGate() {
  queue = queue.then(async () => {
    const elapsed = Date.now() - lastRequest;
    if (elapsed < MIN_GAP_MS) {
      await new Promise((r) => setTimeout(r, MIN_GAP_MS - elapsed));
    }
    lastRequest = Date.now();
  });
  return queue;
}

async function fetchYahooQuote(symbol, http) {
  await yahooGate();
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`;
    const chart = await http.fetchJson(url, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: TIMEOUT_MS,
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

module.exports = { yahooGate, fetchYahooQuote, USER_AGENT, TIMEOUT_MS };
```

**Step 2: Commit**

```bash
git add services/shared/yahoo-gate.cjs
git commit -m "feat: add shared Yahoo rate limiter module"
```

---

### Task 2: Create Shared Finnhub Candle Helper

**Files:**
- Create: `services/shared/finnhub-client.cjs`

**Step 1: Create the helper module**

The Finnhub candle endpoint is used by both `macro-signals.cjs` (1yr stock + forex candles) and `etf-flows.cjs` (5-day stock candles). Centralise it.

```javascript
'use strict';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TIMEOUT_MS = 15_000;

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
      timeout: TIMEOUT_MS,
    });
    if (data && (data.c !== 0 || data.h !== 0 || data.l !== 0)) {
      return { symbol, price: data.c, changePercent: data.dp };
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchFinnhubStockCandle(symbol, apiKey, http, { days = 5 } = {}) {
  if (!apiKey) return null;
  try {
    const now = Math.floor(Date.now() / 1000);
    const from = now - days * 86400;
    const url = `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=D&from=${from}&to=${now}`;
    const data = await http.fetchJson(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
        'X-Finnhub-Token': apiKey,
      },
      timeout: TIMEOUT_MS,
    });
    if (data?.s !== 'ok' || !Array.isArray(data.c)) return null;
    return { closes: data.c, volumes: data.v || [], highs: data.h || [], lows: data.l || [], opens: data.o || [], timestamps: data.t || [] };
  } catch {
    return null;
  }
}

async function fetchFinnhubForexCandle(pair, apiKey, http, { days = 365 } = {}) {
  if (!apiKey) return null;
  try {
    const now = Math.floor(Date.now() / 1000);
    const from = now - days * 86400;
    const url = `https://finnhub.io/api/v1/forex/candle?symbol=OANDA:${encodeURIComponent(pair)}&resolution=D&from=${from}&to=${now}`;
    const data = await http.fetchJson(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
        'X-Finnhub-Token': apiKey,
      },
      timeout: TIMEOUT_MS,
    });
    if (data?.s !== 'ok' || !Array.isArray(data.c)) return null;
    return { closes: data.c, volumes: data.v || [], timestamps: data.t || [] };
  } catch {
    return null;
  }
}

module.exports = { fetchFinnhubQuote, fetchFinnhubStockCandle, fetchFinnhubForexCandle, TIMEOUT_MS };
```

**Step 2: Commit**

```bash
git add services/shared/finnhub-client.cjs
git commit -m "feat: add shared Finnhub client with quote and candle helpers"
```

---

### Task 3: Update markets.cjs — Route Indices Through Finnhub

**Files:**
- Modify: `services/shared/channels/markets.cjs`

**Changes:**
1. Import shared yahoo gate
2. Add `INDEX_PROXY` map to route `^GSPC`→`SPY`, `^DJI`→`DIA`, `^IXIC`→`QQQ`
3. Update `isYahooOnlySymbol()` — mapped indices are no longer Yahoo-only
4. Remove the Yahoo sector fallback fetch entirely (lines 170-171, 201-207)
5. Remove the local `yahooGate`, `yahooLastRequest`, `yahooQueue`, `YAHOO_MIN_GAP_MS` variables
6. Remove the inline `fetchYahooQuote` function — use shared one
7. Remove the inline `fetchFinnhubQuote` function — use shared one
8. Update stock assembly to reverse-map proxy symbols back to original display symbols

**Step 1: Rewrite markets.cjs**

Replace the entire file with this updated version:

```javascript
'use strict';

const { fetchYahooQuote } = require('../yahoo-gate.cjs');
const { fetchFinnhubQuote } = require('../finnhub-client.cjs');

const PHASE3C_TIMEOUT_MS = 15_000;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const CRYPTO_META = {
  bitcoin: { name: 'Bitcoin', symbol: 'BTC' },
  ethereum: { name: 'Ethereum', symbol: 'ETH' },
  solana: { name: 'Solana', symbol: 'SOL' },
  ripple: { name: 'XRP', symbol: 'XRP' },
};

const INDEX_PROXY = { '^GSPC': 'SPY', '^DJI': 'DIA', '^IXIC': 'QQQ' };
const PROXY_REVERSE = Object.fromEntries(Object.entries(INDEX_PROXY).map(([k, v]) => [v, k]));

function isCommoditySymbol(s) {
  return s.startsWith('^') || s.includes('=');
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

    const apiKey = config?.FINNHUB_API_KEY || process.env.FINNHUB_API_KEY;
    if (!apiKey) log.warn('fetchMarkets: FINNHUB_API_KEY not set — using Yahoo fallback only');

    const stockSymbols = (symbolConfig.stock || []).map((s) => s.symbol);
    const commoditySymbols = (symbolConfig.commodity || []).map((s) => s.symbol);
    const sectorSymbols = (symbolConfig.sector || []).map((s) => s.symbol);
    const cryptoIds = (symbolConfig.crypto || []).map((s) => s.symbol);

    const stockMeta = new Map((symbolConfig.stock || []).map((e) => [e.symbol, e]));
    const commodityMeta = new Map((symbolConfig.commodity || []).map((e) => [e.symbol, e]));
    const sectorMeta = new Map((symbolConfig.sector || []).map((e) => [e.symbol, e]));

    const finnhubStockSymbols = apiKey
      ? stockSymbols.map((s) => INDEX_PROXY[s] || s).filter((s) => !isCommoditySymbol(s))
      : [];
    const allFinnhubSymbols = [...finnhubStockSymbols, ...(apiKey ? sectorSymbols : [])];

    const yahooOnlyStocks = apiKey ? [] : stockSymbols.filter((s) => !INDEX_PROXY[s]);
    const yahooCommodityList = commoditySymbols;

    const [finnhubResults, yahooCommodityResults, yahooStockResults, cryptoResults] =
      await Promise.allSettled([
        allFinnhubSymbols.length > 0
          ? Promise.all(
              allFinnhubSymbols.map((s) =>
                fetchFinnhubQuote(s, apiKey || '', http).then((r) =>
                  r ? { ...r, symbol: s } : null
                )
              )
            )
          : Promise.resolve([]),
        yahooCommodityList.length > 0
          ? Promise.all(
              yahooCommodityList.map((s) =>
                fetchYahooQuote(s, http).then((q) => (q ? { symbol: s, ...q } : null))
              )
            )
          : Promise.resolve([]),
        yahooOnlyStocks.length > 0
          ? Promise.all(
              yahooOnlyStocks.map((s) =>
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
    let cryptoData = cryptoResults.status === 'fulfilled' ? cryptoResults.value : [];
    if (cryptoResults.status === 'rejected' && cryptoResults.reason?.message?.includes('429')) {
      cryptoData = [];
    }

    const yahooMap = new Map();
    for (const x of [...yahooCommodity, ...yahooStock]) {
      if (x && x.symbol) {
        yahooMap.set(x.symbol, { price: x.price, change: x.change, sparkline: x.sparkline || [] });
      }
    }

    const stocks = [];
    const finnhubHits = new Set();
    for (const r of finnhubData) {
      if (!r || sectorSymbols.includes(r.symbol)) continue;
      finnhubHits.add(r.symbol);
      const origSymbol = PROXY_REVERSE[r.symbol] || r.symbol;
      const meta = stockMeta.get(origSymbol) || stockMeta.get(r.symbol);
      stocks.push({
        symbol: origSymbol,
        name: meta?.name ?? origSymbol,
        display: meta?.display ?? origSymbol,
        price: r.price,
        change: r.changePercent,
        sparkline: [],
      });
    }
    for (const s of yahooOnlyStocks) {
      const proxy = INDEX_PROXY[s];
      if (proxy && finnhubHits.has(proxy)) continue;
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

    const sectors = [];
    for (const r of finnhubData) {
      if (r && sectorSymbols.includes(r.symbol)) {
        const meta = sectorMeta.get(r.symbol);
        sectors.push({ symbol: r.symbol, name: meta?.name ?? r.symbol, change: r.changePercent });
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
      const sparkline = prices && prices.length > 24 ? prices.slice(-48) : prices || [];
      crypto.push({
        name: configEntry?.name ?? meta?.name ?? id,
        symbol: configEntry?.display ?? meta?.symbol ?? id.toUpperCase(),
        price: coin.current_price ?? 0,
        change: coin.price_change_percentage_24h ?? 0,
        sparkline,
      });
    }

    const coveredByFinnhub = stockSymbols.every(
      (s) => finnhubHits.has(INDEX_PROXY[s] || s) || stocks.some((q) => q.symbol === s)
    );
    const skipped = !apiKey && !coveredByFinnhub;
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
```

**Step 2: Commit**

```bash
git add services/shared/channels/markets.cjs
git commit -m "refactor: route stock indices through Finnhub ETF proxies, drop Yahoo sector fallback"
```

---

### Task 4: Update macro-signals.cjs — Eliminate Yahoo Entirely

**Files:**
- Modify: `services/shared/channels/macro-signals.cjs`

**Changes:**
1. Replace all 4 Yahoo chart calls with Finnhub candles (QQQ, XLP) + Finnhub forex candle (JPY) + CoinGecko (BTC)
2. Remove all Yahoo gate code and Yahoo references
3. Adapt `extractClosePrices` and `extractAlignedPriceVolume` to Finnhub/CoinGecko response formats
4. JPY symbol mapping: Finnhub uses `OANDA:USD_JPY` (inverse of Yahoo's `JPY=X`). Invert each close price via `1/price` so existing ROC logic works unchanged.

**Step 1: Rewrite macro-signals.cjs**

```javascript
'use strict';

const { fetchFinnhubStockCandle, fetchFinnhubForexCandle } = require('../finnhub-client.cjs');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const TIMEOUT_MS = 10_000;

function rateOfChange(prices, days) {
  if (!prices || prices.length < days + 1) return null;
  const recent = prices[prices.length - 1];
  const past = prices[prices.length - 1 - days];
  if (!past || past === 0) return null;
  return ((recent - past) / past) * 100;
}

function smaCalc(prices, period) {
  if (!prices || prices.length < period) return null;
  return prices.slice(-period).reduce((a, b) => a + b, 0) / period;
}

module.exports = async function fetchMacroSignals({ config, redis, log, http }) {
  log.debug('fetchMacroSignals executing');
  const timestamp = new Date().toISOString();

  try {
    const apiKey = config?.FINNHUB_API_KEY || process.env.FINNHUB_API_KEY;

    const [jpyResult, btcResult, qqqResult, xlpResult, fearGreed, mempoolHash] =
      await Promise.allSettled([
        apiKey
          ? fetchFinnhubForexCandle('USD_JPY', apiKey, http, { days: 365 })
          : Promise.resolve(null),
        http
          .fetchJson(
            'https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=365&interval=daily',
            { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }, timeout: TIMEOUT_MS }
          )
          .catch(() => null),
        apiKey
          ? fetchFinnhubStockCandle('QQQ', apiKey, http, { days: 365 })
          : Promise.resolve(null),
        apiKey
          ? fetchFinnhubStockCandle('XLP', apiKey, http, { days: 365 })
          : Promise.resolve(null),
        http
          .fetchJson('https://api.alternative.me/fng/?limit=30&format=json', {
            headers: { 'User-Agent': USER_AGENT },
            timeout: TIMEOUT_MS,
          })
          .catch(() => null),
        http
          .fetchJson('https://mempool.space/api/v1/mining/hashrate/1m', {
            headers: { 'User-Agent': USER_AGENT },
            timeout: TIMEOUT_MS,
          })
          .catch(() => null),
      ]);

    const jpyCandle = jpyResult.status === 'fulfilled' ? jpyResult.value : null;
    const jpyPrices = jpyCandle ? jpyCandle.closes.map((p) => 1 / p) : [];

    const btcMarketChart = btcResult.status === 'fulfilled' ? btcResult.value : null;
    let btcPrices = [];
    let btcAligned = [];
    if (btcMarketChart?.prices) {
      btcPrices = btcMarketChart.prices.map((p) => p[1]);
      const vols = btcMarketChart.total_volumes || [];
      const volMap = new Map(vols.map((v) => [Math.floor(v[0] / 86400000), v[1]]));
      btcAligned = btcMarketChart.prices
        .map((p) => {
          const dayKey = Math.floor(p[0] / 86400000);
          const volume = volMap.get(dayKey);
          return volume != null ? { price: p[1], volume } : null;
        })
        .filter(Boolean);
    }

    const qqqCandle = qqqResult.status === 'fulfilled' ? qqqResult.value : null;
    const qqqPrices = qqqCandle ? qqqCandle.closes : [];

    const xlpCandle = xlpResult.status === 'fulfilled' ? xlpResult.value : null;
    const xlpPrices = xlpCandle ? xlpCandle.closes : [];

    const jpyRoc30 = rateOfChange(jpyPrices, 30);
    const liquidityStatus =
      jpyRoc30 !== null ? (jpyRoc30 < -2 ? 'SQUEEZE' : 'NORMAL') : 'UNKNOWN';

    const btcReturn5 = rateOfChange(btcPrices, 5);
    const qqqReturn5 = rateOfChange(qqqPrices, 5);
    let flowStatus = 'UNKNOWN';
    if (btcReturn5 !== null && qqqReturn5 !== null) {
      flowStatus = Math.abs(btcReturn5 - qqqReturn5) > 5 ? 'PASSIVE GAP' : 'ALIGNED';
    }

    const qqqRoc20 = rateOfChange(qqqPrices, 20);
    const xlpRoc20 = rateOfChange(xlpPrices, 20);
    let regimeStatus = 'UNKNOWN';
    if (qqqRoc20 !== null && xlpRoc20 !== null)
      regimeStatus = qqqRoc20 > xlpRoc20 ? 'RISK-ON' : 'DEFENSIVE';

    const btcSma50 = smaCalc(btcPrices, 50);
    const btcSma200 = smaCalc(btcPrices, 200);
    const btcCurrent = btcPrices.length > 0 ? btcPrices[btcPrices.length - 1] : null;

    let btcVwap = null;
    if (btcAligned.length >= 30) {
      const last30 = btcAligned.slice(-30);
      let sumPV = 0;
      let sumV = 0;
      for (const { price, volume } of last30) {
        sumPV += price * volume;
        sumV += volume;
      }
      if (sumV > 0) btcVwap = +(sumPV / sumV).toFixed(0);
    }

    let trendStatus = 'UNKNOWN';
    let mayerMultiple = null;
    if (btcCurrent && btcSma50) {
      const aboveSma = btcCurrent > btcSma50 * 1.02;
      const belowSma = btcCurrent < btcSma50 * 0.98;
      const aboveVwap = btcVwap ? btcCurrent > btcVwap : null;
      if (aboveSma && aboveVwap !== false) trendStatus = 'BULLISH';
      else if (belowSma && aboveVwap !== true) trendStatus = 'BEARISH';
      else trendStatus = 'NEUTRAL';
    }
    if (btcCurrent && btcSma200) mayerMultiple = +(btcCurrent / btcSma200).toFixed(2);

    let hashStatus = 'UNKNOWN';
    let hashChange = null;
    if (mempoolHash.status === 'fulfilled' && mempoolHash.value) {
      const hr = mempoolHash.value.hashrates || mempoolHash.value;
      if (Array.isArray(hr) && hr.length >= 2) {
        const recent = hr[hr.length - 1]?.avgHashrate ?? hr[hr.length - 1];
        const older = hr[0]?.avgHashrate ?? hr[0];
        if (recent && older && older > 0) {
          hashChange = +(((recent - older) / older) * 100).toFixed(1);
          hashStatus = hashChange > 3 ? 'GROWING' : hashChange < -3 ? 'DECLINING' : 'STABLE';
        }
      }
    }

    let momentumStatus =
      mayerMultiple !== null
        ? mayerMultiple > 1.0
          ? 'STRONG'
          : mayerMultiple > 0.8
            ? 'MODERATE'
            : 'WEAK'
        : 'UNKNOWN';

    let fgValue;
    let fgLabel = 'UNKNOWN';
    let fgHistory = [];
    if (fearGreed.status === 'fulfilled' && fearGreed.value?.data) {
      const d = fearGreed.value.data[0];
      fgValue = parseInt(d?.value, 10);
      if (!Number.isFinite(fgValue)) fgValue = undefined;
      fgLabel = d?.value_classification || 'UNKNOWN';
      fgHistory = (fearGreed.value.data || [])
        .slice(0, 30)
        .map((x) => ({
          value: parseInt(x.value, 10),
          date: new Date(parseInt(x.timestamp, 10) * 1000).toISOString().slice(0, 10),
        }))
        .reverse();
    }

    const signalList = [
      { status: liquidityStatus, bullish: liquidityStatus === 'NORMAL' },
      { status: flowStatus, bullish: flowStatus === 'ALIGNED' },
      { status: regimeStatus, bullish: regimeStatus === 'RISK-ON' },
      { status: trendStatus, bullish: trendStatus === 'BULLISH' },
      { status: hashStatus, bullish: hashStatus === 'GROWING' },
      { status: momentumStatus, bullish: momentumStatus === 'STRONG' },
      { status: fgLabel, bullish: fgValue !== undefined && fgValue > 50 },
    ];
    let bullishCount = 0;
    let totalCount = 0;
    for (const s of signalList) {
      if (s.status !== 'UNKNOWN') {
        totalCount++;
        if (s.bullish) bullishCount++;
      }
    }
    const verdict =
      totalCount === 0 ? 'UNKNOWN' : bullishCount / totalCount >= 0.57 ? 'BUY' : 'CASH';

    const data = [
      {
        id: 'liquidity',
        status: liquidityStatus,
        value: jpyRoc30 !== null ? +jpyRoc30.toFixed(2) : undefined,
      },
      {
        id: 'flowStructure',
        status: flowStatus,
        btcReturn5: btcReturn5 !== null ? +btcReturn5.toFixed(2) : undefined,
        qqqReturn5: qqqReturn5 !== null ? +qqqReturn5.toFixed(2) : undefined,
      },
      {
        id: 'macroRegime',
        status: regimeStatus,
        qqqRoc20: qqqRoc20 !== null ? +qqqRoc20.toFixed(2) : undefined,
        xlpRoc20: xlpRoc20 !== null ? +xlpRoc20.toFixed(2) : undefined,
      },
      {
        id: 'technicalTrend',
        status: trendStatus,
        btcPrice: btcCurrent ?? undefined,
        sma50: btcSma50 ? +btcSma50.toFixed(0) : undefined,
        sma200: btcSma200 ? +btcSma200.toFixed(0) : undefined,
        vwap30d: btcVwap ?? undefined,
        mayerMultiple: mayerMultiple ?? undefined,
      },
      { id: 'hashRate', status: hashStatus, change30d: hashChange ?? undefined },
      { id: 'priceMomentum', status: momentumStatus },
      { id: 'fearGreed', status: fgLabel, value: fgValue, history: fgHistory },
    ];

    return {
      timestamp,
      source: 'macro-signals',
      data,
      status: 'success',
      verdict,
      bullishCount,
      totalCount,
      signals: {
        liquidity: {
          status: liquidityStatus,
          value: jpyRoc30 !== null ? +jpyRoc30.toFixed(2) : undefined,
          sparkline: jpyPrices.slice(-30),
        },
        flowStructure: {
          status: flowStatus,
          btcReturn5: btcReturn5 !== null ? +btcReturn5.toFixed(2) : undefined,
          qqqReturn5: qqqReturn5 !== null ? +qqqReturn5.toFixed(2) : undefined,
        },
        macroRegime: {
          status: regimeStatus,
          qqqRoc20: qqqRoc20 !== null ? +qqqRoc20.toFixed(2) : undefined,
          xlpRoc20: xlpRoc20 !== null ? +xlpRoc20.toFixed(2) : undefined,
        },
        technicalTrend: {
          status: trendStatus,
          btcPrice: btcCurrent ?? undefined,
          sma50: btcSma50 ? +btcSma50.toFixed(0) : undefined,
          sma200: btcSma200 ? +btcSma200.toFixed(0) : undefined,
          vwap30d: btcVwap ?? undefined,
          mayerMultiple: mayerMultiple ?? undefined,
          sparkline: btcPrices.slice(-30),
        },
        hashRate: { status: hashStatus, change30d: hashChange ?? undefined },
        priceMomentum: { status: momentumStatus },
        fearGreed: { status: fgLabel, value: fgValue, history: fgHistory },
      },
      meta: { qqqSparkline: qqqPrices.slice(-30) },
      unavailable: false,
    };
  } catch (err) {
    log.error('fetchMacroSignals error', { error: err?.message ?? err });
    return {
      timestamp,
      source: 'macro-signals',
      data: [],
      status: 'error',
      errors: [err?.message ?? String(err)],
    };
  }
};
```

**Step 2: Commit**

```bash
git add services/shared/channels/macro-signals.cjs
git commit -m "refactor: replace Yahoo with Finnhub candles and CoinGecko in macro-signals"
```

---

### Task 5: Update etf-flows.cjs — Replace Yahoo with Finnhub Candles

**Files:**
- Modify: `services/shared/channels/etf-flows.cjs`

**Changes:**
1. Replace Yahoo chart calls with `fetchFinnhubStockCandle` (5-day daily)
2. Adapt `parseEtfChartData` to work with Finnhub candle response format
3. Remove all Yahoo gate code

**Step 1: Rewrite etf-flows.cjs**

```javascript
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
```

**Step 2: Commit**

```bash
git add services/shared/channels/etf-flows.cjs
git commit -m "refactor: replace Yahoo with Finnhub stock candles in etf-flows"
```

---

### Task 6: Update gulf-quotes.cjs — Use Shared Yahoo Gate

**Files:**
- Modify: `services/shared/channels/gulf-quotes.cjs`

**Changes:**
1. Replace the local `yahooGate`, `yahooLastRequest`, `yahooQueue`, `YAHOO_MIN_GAP_MS`, `fetchYahooQuote` with imports from `yahoo-gate.cjs`
2. Remove the local `USER_AGENT`, `TIMEOUT_MS` constants (now provided by shared module)

**Step 1: Rewrite gulf-quotes.cjs**

```javascript
'use strict';

const { fetchYahooQuote } = require('../yahoo-gate.cjs');

const GULF_SYMBOLS = [
  { symbol: '^TASI.SR', name: 'Tadawul All Share', country: 'Saudi Arabia', flag: '🇸🇦', type: 'index' },
  { symbol: 'DFMGI.AE', name: 'Dubai Financial Market', country: 'UAE', flag: '🇦🇪', type: 'index' },
  { symbol: 'UAE', name: 'Abu Dhabi (iShares)', country: 'UAE', flag: '🇦🇪', type: 'index' },
  { symbol: 'QAT', name: 'Qatar (iShares)', country: 'Qatar', flag: '🇶🇦', type: 'index' },
  { symbol: 'GULF', name: 'Gulf Dividend (WisdomTree)', country: 'Kuwait', flag: '🇰🇼', type: 'index' },
  { symbol: '^MSM', name: 'Muscat MSM 30', country: 'Oman', flag: '🇴🇲', type: 'index' },
  { symbol: 'SARUSD=X', name: 'Saudi Riyal', country: 'Saudi Arabia', flag: '🇸🇦', type: 'currency' },
  { symbol: 'AEDUSD=X', name: 'UAE Dirham', country: 'UAE', flag: '🇦🇪', type: 'currency' },
  { symbol: 'QARUSD=X', name: 'Qatari Riyal', country: 'Qatar', flag: '🇶🇦', type: 'currency' },
  { symbol: 'KWDUSD=X', name: 'Kuwaiti Dinar', country: 'Kuwait', flag: '🇰🇼', type: 'currency' },
  { symbol: 'BHDUSD=X', name: 'Bahraini Dinar', country: 'Bahrain', flag: '🇧🇭', type: 'currency' },
  { symbol: 'OMRUSD=X', name: 'Omani Rial', country: 'Oman', flag: '🇴🇲', type: 'currency' },
  { symbol: 'CL=F', name: 'WTI Crude', country: '', flag: '🛢️', type: 'oil' },
  { symbol: 'BZ=F', name: 'Brent Crude', country: '', flag: '🛢️', type: 'oil' },
];

module.exports = async function fetchGulfQuotes({ config, redis, log, http }) {
  log.debug('fetchGulfQuotes executing');
  const timestamp = new Date().toISOString();

  try {
    const results = new Map();
    let failures = 0;
    for (const s of GULF_SYMBOLS) {
      const q = await fetchYahooQuote(s.symbol, http);
      if (q) results.set(s.symbol, q);
      else failures++;
    }
    const quotes = [];
    for (const s of GULF_SYMBOLS) {
      const yahoo = results.get(s.symbol);
      if (yahoo) {
        quotes.push({
          symbol: s.symbol,
          name: s.name,
          country: s.country,
          flag: s.flag,
          type: s.type,
          price: yahoo.price,
          change: yahoo.change,
          sparkline: yahoo.sparkline,
        });
      }
    }
    const rateLimited = failures > GULF_SYMBOLS.length / 2;

    return {
      timestamp,
      source: 'gulf-quotes',
      data: { quotes, rateLimited },
      status: 'success',
    };
  } catch (err) {
    log.error('fetchGulfQuotes error', { error: err?.message ?? err });
    return {
      timestamp,
      source: 'gulf-quotes',
      data: { quotes: [], rateLimited: false },
      status: 'error',
      errors: [err?.message ?? String(err)],
    };
  }
};
```

**Step 2: Commit**

```bash
git add services/shared/channels/gulf-quotes.cjs
git commit -m "refactor: use shared Yahoo gate in gulf-quotes"
```

---

### Task 7: Verify Build and Final Commit

**Step 1: Check that all modules resolve correctly**

Run: `node -e "require('./services/shared/yahoo-gate.cjs'); require('./services/shared/finnhub-client.cjs'); require('./services/shared/channels/markets.cjs'); require('./services/shared/channels/macro-signals.cjs'); require('./services/shared/channels/etf-flows.cjs'); require('./services/shared/channels/gulf-quotes.cjs'); console.log('All modules loaded OK')"`

Expected: `All modules loaded OK`

**Step 2: Run linting if configured**

Run: `npx eslint services/shared/yahoo-gate.cjs services/shared/finnhub-client.cjs services/shared/channels/markets.cjs services/shared/channels/macro-signals.cjs services/shared/channels/etf-flows.cjs services/shared/channels/gulf-quotes.cjs 2>&1 || true`

Fix any errors found.

**Step 3: Run full TypeScript check**

Run: `npx tsc --noEmit 2>&1 | head -20`

These are `.cjs` files so TS won't check them, but verify no other files broke.

**Step 4: Squash into final commit if desired, or leave granular**

```bash
git add -A
git status
```
