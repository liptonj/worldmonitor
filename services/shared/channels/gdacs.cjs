'use strict';

// Extracted from scripts/ais-relay.cjs - GDACS disaster alerts
// API: Global Disaster Alert and Coordination System

const TIMEOUT_MS = 15_000;
const EVENT_TYPE_NAMES = {
  EQ: 'Earthquake',
  FL: 'Flood',
  TC: 'Tropical Cyclone',
  VO: 'Volcano',
  WF: 'Wildfire',
  DR: 'Drought',
};

module.exports = async function fetchGdacs({ config, redis, log, http }) {
  log.debug('fetchGdacs executing');
  const timestamp = new Date().toISOString();

  try {
    const url = 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/MAP';
    const data = await http.fetchJson(url, {
      headers: { Accept: 'application/json' },
      timeout: TIMEOUT_MS,
    });

    const rawFeatures = data?.features;
    if (!Array.isArray(rawFeatures)) {
      return {
        timestamp,
        source: 'gdacs',
        data: [],
        status: 'success',
      };
    }

    const seen = new Set();
    const events = [];

    for (const f of rawFeatures) {
      if (f.geometry?.type !== 'Point') continue;

      const props = f.properties || {};
      const key = `${props.eventtype}-${props.eventid}`;
      if (seen.has(key)) continue;
      seen.add(key);

      if (props.alertlevel === 'Green') continue;

      events.push({
        id: `gdacs-${props.eventtype}-${props.eventid}`,
        eventType: props.eventtype,
        name: props.name,
        description: props.description || EVENT_TYPE_NAMES[props.eventtype] || props.eventtype,
        alertLevel: props.alertlevel,
        country: props.country,
        coordinates: f.geometry.coordinates,
        fromDate: props.fromdate,
        severity: props.severitydata?.severitytext || '',
        url: props.url?.report || '',
      });
    }

    return {
      timestamp,
      source: 'gdacs',
      data: events.slice(0, 100),
      status: 'success',
    };
  } catch (err) {
    log.error('fetchGdacs error', { error: err?.message ?? err });
    return {
      timestamp,
      source: 'gdacs',
      data: [],
      status: 'error',
      errors: [err?.message ?? String(err)],
    };
  }
};
