'use strict';

// Fetches data from climate data APIs
module.exports = async function fetchClimate({ config, redis, log, http }) {
  log.debug('fetchClimate executing');
  // TODO: implement - extract from scripts/ais-relay.cjs
  return {
    timestamp: new Date().toISOString(),
    source: 'climate',
    data: [],
    status: 'stub',
  };
};
