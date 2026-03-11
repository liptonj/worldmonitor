'use strict';

// Temporal anomalies: read counts from relay keys, maintain Welford baselines, emit anomaly alerts.
// Ported from server/worldmonitor/infrastructure/v1/record-baseline-snapshot.ts and get-temporal-baseline.ts.

const BASELINE_TTL = 7776000; // 90 days
const MIN_SAMPLES = 10;
const Z_THRESHOLD_LOW = 1.5;
const Z_THRESHOLD_MEDIUM = 2.0;
const Z_THRESHOLD_HIGH = 3.0;

const DATA_SOURCES = {
  news: { key: 'news:digest:v1:full:en', countFn: (d) => (Array.isArray(d?.items) ? d.items.length : Array.isArray(d) ? d.length : 0) },
  military_flights: { key: 'relay:flights:v1', countFn: (d) => (Array.isArray(d?.flights) ? d.flights.length : 0) },
  vessels: { key: 'relay:opensky:v1', countFn: (d) => (Array.isArray(d?.vessels) ? d.vessels.length : 0) },
  ais_gaps: { key: 'relay:ais-snapshot:v1', countFn: (d) => (Array.isArray(d?.disruptions) ? d.disruptions.length : 0) },
  satellite_fires: { key: 'relay:climate:v1', countFn: (d) => (Array.isArray(d?.fires) ? d.fires.length : 0) },
};

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const TYPE_LABELS = {
  military_flights: 'Military flights',
  vessels: 'Naval vessels',
  protests: 'Protests',
  news: 'News velocity',
  ais_gaps: 'Dark ship activity',
  satellite_fires: 'Satellite fire detections',
};

function makeBaselineKey(type, region, weekday, month) {
  return `baseline:${type}:${region}:${weekday}:${month}`;
}

function getSeverity(zScore) {
  if (zScore >= Z_THRESHOLD_HIGH) return 'critical';
  if (zScore >= Z_THRESHOLD_MEDIUM) return 'high';
  if (zScore >= Z_THRESHOLD_LOW) return 'medium';
  return 'normal';
}

function formatMessage(type, _region, count, mean, multiplier) {
  const now = new Date();
  const weekday = WEEKDAY_NAMES[now.getUTCDay()];
  const month = MONTH_NAMES[now.getUTCMonth() + 1];
  const mult = multiplier < 10 ? `${multiplier.toFixed(1)}x` : `${Math.round(multiplier)}x`;
  return `${TYPE_LABELS[type] || type} ${mult} normal for ${weekday} (${month}) — ${count} vs baseline ${Math.round(mean)}`;
}

function parseIfString(raw) {
  if (raw == null) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

module.exports = async function fetchTemporalAnomalies({ redis, log }) {
  log.debug('fetchTemporalAnomalies executing');
  const timestamp = new Date().toISOString();

  if (!redis || typeof redis.get !== 'function') {
    log.warn('fetchTemporalAnomalies: redis not available');
    return {
      timestamp,
      source: 'temporal-anomalies',
      data: { anomalies: [] },
      status: 'error',
      errors: ['Redis not configured'],
    };
  }

  const now = new Date();
  const weekday = now.getUTCDay();
  const month = now.getUTCMonth() + 1;
  const region = 'global';
  const anomalies = [];

  try {
    for (const [type, src] of Object.entries(DATA_SOURCES)) {
      const rawData = await redis.get(src.key);
      const data = parseIfString(rawData);
      if (!data) continue;

      const count = src.countFn(data);
      if (typeof count !== 'number' || isNaN(count)) continue;

      const baselineKey = makeBaselineKey(type, region, weekday, month);
      const rawBaseline = await redis.get(baselineKey);
      const baseline = parseIfString(rawBaseline);
      const prev = baseline && typeof baseline.sampleCount === 'number'
        ? { mean: Number(baseline.mean) || 0, m2: Number(baseline.m2) || 0, sampleCount: baseline.sampleCount }
        : { mean: 0, m2: 0, sampleCount: 0 };

      const n = prev.sampleCount + 1;
      const delta = count - prev.mean;
      const newMean = prev.mean + delta / n;
      const delta2 = count - newMean;
      const newM2 = prev.m2 + delta * delta2;

      const baselineObject = {
        mean: newMean,
        m2: newM2,
        sampleCount: n,
        lastUpdated: now.toISOString(),
      };
      await redis.setex(baselineKey, BASELINE_TTL, baselineObject);

      if (n < MIN_SAMPLES) continue;

      const variance = Math.max(0, newM2 / (n - 1));
      const stdDev = Math.sqrt(variance);
      const zScore = stdDev > 0 ? Math.abs((count - newMean) / stdDev) : 0;

      if (zScore < Z_THRESHOLD_LOW) continue;

      const severity = getSeverity(zScore);
      const multiplier = newMean > 0
        ? Math.round((count / newMean) * 100) / 100
        : count > 0 ? 999 : 1;

      anomalies.push({
        type,
        region,
        currentCount: count,
        expectedCount: Math.round(newMean),
        zScore: Math.round(zScore * 100) / 100,
        severity,
        message: formatMessage(type, region, count, newMean, multiplier),
      });
    }

    anomalies.sort((a, b) => b.zScore - a.zScore);

    return {
      timestamp,
      source: 'temporal-anomalies',
      data: { anomalies },
      status: 'success',
    };
  } catch (err) {
    log.error('fetchTemporalAnomalies error', { error: err?.message ?? err });
    return {
      timestamp,
      source: 'temporal-anomalies',
      data: { anomalies: [] },
      status: 'error',
      errors: [err?.message ?? String(err)],
    };
  }
};
