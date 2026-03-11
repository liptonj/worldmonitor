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
