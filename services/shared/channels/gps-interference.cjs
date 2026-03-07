'use strict';

// Fetches data from GPS interference/spoofing detection APIs
module.exports = async function fetchGpsInterference({ config, redis, log, http }) {
  log.debug('fetchGpsInterference executing');
  // TODO: implement - extract from scripts/ais-relay.cjs
  return {
    timestamp: new Date().toISOString(),
    source: 'gps-interference',
    data: [],
    status: 'stub',
  };
};
