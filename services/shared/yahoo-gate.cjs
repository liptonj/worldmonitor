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
