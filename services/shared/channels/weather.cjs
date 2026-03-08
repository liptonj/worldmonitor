'use strict';

// Extracted from scripts/ais-relay.cjs - NWS severe weather alerts
// API: National Weather Service (api.weather.gov)

const TIMEOUT_MS = 15_000;
const USER_AGENT = 'WorldMonitor/1.0';

module.exports = async function fetchWeather({ config, redis, log, http }) {
  log.debug('fetchWeather executing');
  const timestamp = new Date().toISOString();

  try {
    const url = 'https://api.weather.gov/alerts/active';
    const data = await http.fetchJson(url, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: TIMEOUT_MS,
    });

    const rawFeatures = data?.features;
    if (!Array.isArray(rawFeatures)) {
      return {
        timestamp,
        source: 'weather',
        data: [],
        status: 'success',
      };
    }

    const alerts = [];
    for (const a of rawFeatures) {
      const p = a.properties || {};
      if (p.severity === 'Unknown') continue;

      let coords = [];
      const geom = a.geometry;
      if (geom?.type === 'Polygon' && Array.isArray(geom.coordinates?.[0])) {
        coords = geom.coordinates[0].map((c) => [c[0], c[1]]);
      } else if (geom?.type === 'MultiPolygon' && Array.isArray(geom.coordinates?.[0]?.[0])) {
        coords = geom.coordinates[0][0].map((c) => [c[0], c[1]]);
      }

      const centroid =
        coords.length > 0
          ? [
              coords.reduce((s, c) => s + c[0], 0) / coords.length,
              coords.reduce((s, c) => s + c[1], 0) / coords.length,
            ]
          : undefined;

      alerts.push({
        id: a.id,
        event: p.event || '',
        severity: p.severity || 'Unknown',
        headline: p.headline || '',
        description: (p.description || '').slice(0, 500),
        areaDesc: p.areaDesc || '',
        onset: p.onset ? new Date(p.onset).toISOString() : new Date().toISOString(),
        expires: p.expires ? new Date(p.expires).toISOString() : new Date().toISOString(),
        coordinates: coords,
        centroid,
      });
    }

    return {
      timestamp,
      source: 'weather',
      data: alerts.slice(0, 50),
      status: 'success',
    };
  } catch (err) {
    log.error('fetchWeather error', { error: err?.message ?? err });
    return {
      timestamp,
      source: 'weather',
      data: [],
      status: 'error',
      errors: [err?.message ?? String(err)],
    };
  }
};
