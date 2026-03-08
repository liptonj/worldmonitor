'use strict';

// Extracted from scripts/ais-relay.cjs - Macroeconomic signals
// APIs: Yahoo Finance, Alternative.me (Fear & Greed), Mempool.space

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

function extractClosePrices(chart) {
  try {
    return chart?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter((p) => p != null) || [];
  } catch {
    return [];
  }
}

function extractAlignedPriceVolume(chart) {
  try {
    const result = chart?.chart?.result?.[0];
    const closes = result?.indicators?.quote?.[0]?.close || [];
    const volumes = result?.indicators?.quote?.[0]?.volume || [];
    const pairs = [];
    for (let i = 0; i < closes.length; i++) {
      if (closes[i] != null && volumes[i] != null) pairs.push({ price: closes[i], volume: volumes[i] });
    }
    return pairs;
  } catch {
    return [];
  }
}

module.exports = async function fetchMacroSignals({ config, redis, log, http }) {
  log.debug('fetchMacroSignals executing');
  const timestamp = new Date().toISOString();

  try {
    const yahooBase = 'https://query1.finance.yahoo.com/v8/finance/chart';

    await yahooGate();
    const jpyChart = await http.fetchJson(`${yahooBase}/JPY=X?range=1y&interval=1d`, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: TIMEOUT_MS,
    }).catch(() => null);
    await yahooGate();
    const btcChart = await http.fetchJson(`${yahooBase}/BTC-USD?range=1y&interval=1d`, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: TIMEOUT_MS,
    }).catch(() => null);
    await yahooGate();
    const qqqChart = await http.fetchJson(`${yahooBase}/QQQ?range=1y&interval=1d`, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: TIMEOUT_MS,
    }).catch(() => null);
    await yahooGate();
    const xlpChart = await http.fetchJson(`${yahooBase}/XLP?range=1y&interval=1d`, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: TIMEOUT_MS,
    }).catch(() => null);

    const [fearGreed, mempoolHash] = await Promise.allSettled([
      http.fetchJson('https://api.alternative.me/fng/?limit=30&format=json', {
        headers: { 'User-Agent': USER_AGENT },
        timeout: TIMEOUT_MS,
      }).catch(() => null),
      http.fetchJson('https://mempool.space/api/v1/mining/hashrate/1m', {
        headers: { 'User-Agent': USER_AGENT },
        timeout: TIMEOUT_MS,
      }).catch(() => null),
    ]);

    const jpyPrices = extractClosePrices(jpyChart);
    const btcPrices = extractClosePrices(btcChart);
    const btcAligned = extractAlignedPriceVolume(btcChart);
    const qqqPrices = extractClosePrices(qqqChart);
    const xlpPrices = extractClosePrices(xlpChart);

    const jpyRoc30 = rateOfChange(jpyPrices, 30);
    const liquidityStatus = jpyRoc30 !== null ? (jpyRoc30 < -2 ? 'SQUEEZE' : 'NORMAL') : 'UNKNOWN';

    const btcReturn5 = rateOfChange(btcPrices, 5);
    const qqqReturn5 = rateOfChange(qqqPrices, 5);
    let flowStatus = 'UNKNOWN';
    if (btcReturn5 !== null && qqqReturn5 !== null) {
      flowStatus = Math.abs(btcReturn5 - qqqReturn5) > 5 ? 'PASSIVE GAP' : 'ALIGNED';
    }

    const qqqRoc20 = rateOfChange(qqqPrices, 20);
    const xlpRoc20 = rateOfChange(xlpPrices, 20);
    let regimeStatus = 'UNKNOWN';
    if (qqqRoc20 !== null && xlpRoc20 !== null) regimeStatus = qqqRoc20 > xlpRoc20 ? 'RISK-ON' : 'DEFENSIVE';

    const btcSma50 = smaCalc(btcPrices, 50);
    const btcSma200 = smaCalc(btcPrices, 200);
    const btcCurrent = btcPrices.length > 0 ? btcPrices[btcPrices.length - 1] : null;

    let btcVwap = null;
    if (btcAligned.length >= 30) {
      const last30 = btcAligned.slice(-30);
      let sumPV = 0; let sumV = 0;
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
          hashChange = +((recent - older) / older * 100).toFixed(1);
          hashStatus = hashChange > 3 ? 'GROWING' : hashChange < -3 ? 'DECLINING' : 'STABLE';
        }
      }
    }

    let momentumStatus = mayerMultiple !== null ? (mayerMultiple > 1.0 ? 'STRONG' : mayerMultiple > 0.8 ? 'MODERATE' : 'WEAK') : 'UNKNOWN';

    let fgValue; let fgLabel = 'UNKNOWN'; let fgHistory = [];
    if (fearGreed.status === 'fulfilled' && fearGreed.value?.data) {
      const d = fearGreed.value.data[0];
      fgValue = parseInt(d?.value, 10);
      if (!Number.isFinite(fgValue)) fgValue = undefined;
      fgLabel = d?.value_classification || 'UNKNOWN';
      fgHistory = (fearGreed.value.data || []).slice(0, 30).map((x) => ({
        value: parseInt(x.value, 10),
        date: new Date(parseInt(x.timestamp, 10) * 1000).toISOString().slice(0, 10),
      })).reverse();
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
    let bullishCount = 0; let totalCount = 0;
    for (const s of signalList) {
      if (s.status !== 'UNKNOWN') {
        totalCount++;
        if (s.bullish) bullishCount++;
      }
    }
    const verdict = totalCount === 0 ? 'UNKNOWN' : (bullishCount / totalCount >= 0.57 ? 'BUY' : 'CASH');

    const data = [
      { id: 'liquidity', status: liquidityStatus, value: jpyRoc30 !== null ? +jpyRoc30.toFixed(2) : undefined },
      { id: 'flowStructure', status: flowStatus, btcReturn5: btcReturn5 !== null ? +btcReturn5.toFixed(2) : undefined, qqqReturn5: qqqReturn5 !== null ? +qqqReturn5.toFixed(2) : undefined },
      { id: 'macroRegime', status: regimeStatus, qqqRoc20: qqqRoc20 !== null ? +qqqRoc20.toFixed(2) : undefined, xlpRoc20: xlpRoc20 !== null ? +xlpRoc20.toFixed(2) : undefined },
      { id: 'technicalTrend', status: trendStatus, btcPrice: btcCurrent ?? undefined, sma50: btcSma50 ? +btcSma50.toFixed(0) : undefined, sma200: btcSma200 ? +btcSma200.toFixed(0) : undefined, vwap30d: btcVwap ?? undefined, mayerMultiple: mayerMultiple ?? undefined },
      { id: 'hashRate', status: hashStatus, change30d: hashChange ?? undefined },
      { id: 'priceMomentum', status: momentumStatus },
      { id: 'fearGreed', status: fgLabel, value: fgValue, history: fgHistory },
    ];

    if (!Array.isArray(data)) {
      return {
        timestamp,
        source: 'macro-signals',
        data: [],
        status: 'error',
        errors: ['Invalid macro-signals response: expected array'],
      };
    }

    return {
      timestamp,
      source: 'macro-signals',
      data,
      status: 'success',
      verdict,
      bullishCount,
      totalCount,
      signals: {
        liquidity: { status: liquidityStatus, value: jpyRoc30 !== null ? +jpyRoc30.toFixed(2) : undefined, sparkline: jpyPrices.slice(-30) },
        flowStructure: { status: flowStatus, btcReturn5: btcReturn5 !== null ? +btcReturn5.toFixed(2) : undefined, qqqReturn5: qqqReturn5 !== null ? +qqqReturn5.toFixed(2) : undefined },
        macroRegime: { status: regimeStatus, qqqRoc20: qqqRoc20 !== null ? +qqqRoc20.toFixed(2) : undefined, xlpRoc20: xlpRoc20 !== null ? +xlpRoc20.toFixed(2) : undefined },
        technicalTrend: { status: trendStatus, btcPrice: btcCurrent ?? undefined, sma50: btcSma50 ? +btcSma50.toFixed(0) : undefined, sma200: btcSma200 ? +btcSma200.toFixed(0) : undefined, vwap30d: btcVwap ?? undefined, mayerMultiple: mayerMultiple ?? undefined, sparkline: btcPrices.slice(-30) },
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
