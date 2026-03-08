'use strict';

// Extracted from scripts/ais-relay.cjs - NOAA NCEI global climate anomaly data

const TIMEOUT_MS = 15_000;

module.exports = async function fetchClimate({ config, redis, log, http }) {
  log.debug('fetchClimate executing');
  const timestamp = new Date().toISOString();

  try {
    const currentYear = new Date().getFullYear();
    const url = `https://www.ncei.noaa.gov/access/monitoring/climate-at-a-glance/global/time-series/globe/land_ocean/ann/1/1990-${currentYear}.json`;

    const json = await http.fetchJson(url, {
      timeout: TIMEOUT_MS,
    });

    const entries = Object.entries(json?.data ?? {});
    const anomalies = [];
    for (const [period, rawValue] of entries) {
      const value = parseFloat(rawValue);
      if (isNaN(value)) continue;
      const absVal = Math.abs(value);
      const severity = absVal >= 1.0 ? 'ANOMALY_SEVERITY_EXTREME' : absVal >= 0.5 ? 'ANOMALY_SEVERITY_MODERATE' : null;
      if (!severity) continue;
      anomalies.push({
        zone: 'Global',
        location: { latitude: 0, longitude: 0 },
        tempDelta: value,
        precipDelta: 0,
        severity,
        type: value > 0 ? 'ANOMALY_TYPE_WARM' : 'ANOMALY_TYPE_COLD',
        period,
      });
    }

    const data = Array.isArray(anomalies) ? anomalies.slice(-12) : [];
    return {
      timestamp,
      source: 'climate',
      data,
      status: 'success',
    };
  } catch (err) {
    log.error('fetchClimate error', { error: err?.message ?? err });
    return {
      timestamp,
      source: 'climate',
      data: [],
      status: 'error',
      errors: [err?.message ?? String(err)],
    };
  }
};
