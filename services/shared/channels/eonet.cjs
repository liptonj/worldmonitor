'use strict';

// Extracted from scripts/ais-relay.cjs - NASA EONET natural events
// API: NASA EONET (Earth Observatory Natural Event Tracker)

const TIMEOUT_MS = 15_000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const WILDFIRE_MAX_AGE_MS = 48 * 60 * 60 * 1000;

module.exports = async function fetchEonet({ config, redis, log, http }) {
  log.debug('fetchEonet executing');
  const timestamp = new Date().toISOString();

  try {
    const url = 'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=30';
    const data = await http.fetchJson(url, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: TIMEOUT_MS,
    });

    const rawEvents = data?.events;
    if (!Array.isArray(rawEvents)) {
      return {
        timestamp,
        source: 'eonet',
        data: [],
        status: 'success',
      };
    }

    const now = Date.now();
    const events = [];

    for (const event of rawEvents) {
      const category = event.categories?.[0];
      if (!category || category.id === 'earthquakes') continue;

      const geometry = event.geometry;
      if (!Array.isArray(geometry) || geometry.length === 0) continue;

      const latestGeo = geometry[geometry.length - 1];
      if (!latestGeo || latestGeo.type !== 'Point') continue;

      const eventDate = new Date(latestGeo.date).getTime();
      if (category.id === 'wildfires' && now - eventDate > WILDFIRE_MAX_AGE_MS) continue;

      const [lon, lat] = latestGeo.coordinates || [0, 0];
      const source = event.sources?.[0];

      events.push({
        id: event.id,
        title: event.title,
        description: event.description || undefined,
        category: category.id,
        categoryTitle: category.title,
        lat,
        lon,
        date: new Date(latestGeo.date),
        magnitude: latestGeo.magnitudeValue,
        magnitudeUnit: latestGeo.magnitudeUnit,
        sourceUrl: source?.url,
        sourceName: source?.id,
        closed: event.closed !== null,
      });
    }

    return {
      timestamp,
      source: 'eonet',
      data: events,
      status: 'success',
    };
  } catch (err) {
    log.error('fetchEonet error', { error: err?.message ?? err });
    return {
      timestamp,
      source: 'eonet',
      data: [],
      status: 'error',
      errors: [err?.message ?? String(err)],
    };
  }
};
