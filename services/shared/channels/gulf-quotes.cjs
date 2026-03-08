'use strict';

// Extracted from scripts/ais-relay.cjs - Gulf region market quotes (Yahoo Finance)
// Symbols: Tadawul, DFM, UAE, Qatar, Kuwait, Oman indices + SAR/AED/QAR/KWD/BHD/OMR + WTI/Brent

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

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const TIMEOUT_MS = 15_000;
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

async function fetchYahooQuote(symbol, http) {
  await yahooGate();
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`;
  try {
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

    if (!Array.isArray(quotes)) {
      return {
        timestamp,
        source: 'gulf-quotes',
        data: { quotes: [], rateLimited },
        status: 'error',
        errors: ['Invalid quotes structure'],
      };
    }

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
