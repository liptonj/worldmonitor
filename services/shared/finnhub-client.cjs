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
