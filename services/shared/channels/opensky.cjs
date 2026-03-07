'use strict';

// Fetches data from OpenSky Network flight tracking API (1-min interval)
module.exports = async function fetchOpensky({ config, redis, log, http }) {
  log.debug('fetchOpensky executing');
  // TODO: implement - extract from scripts/ais-relay.cjs
  return {
    timestamp: new Date().toISOString(),
    source: 'opensky',
    data: [],
    status: 'stub',
  };
};
