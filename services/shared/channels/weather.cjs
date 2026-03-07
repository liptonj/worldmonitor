'use strict';

// Fetches data from global weather APIs
module.exports = async function fetchWeather({ config, redis, log, http }) {
  log.debug('fetchWeather executing');
  // TODO: implement - extract from scripts/ais-relay.cjs
  return {
    timestamp: new Date().toISOString(),
    source: 'weather',
    data: [],
    status: 'stub',
  };
};
