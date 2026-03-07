'use strict';

// Fetches data from NASA EONET natural events API
module.exports = async function fetchEonet({ config, redis, log, http }) {
  log.debug('fetchEonet executing');
  // TODO: implement - extract from scripts/ais-relay.cjs
  return {
    timestamp: new Date().toISOString(),
    source: 'eonet',
    data: [],
    status: 'stub',
  };
};
