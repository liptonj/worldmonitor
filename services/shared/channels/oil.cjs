'use strict';

// Fetches data from oil market APIs
module.exports = async function fetchOil({ config, redis, log, http }) {
  log.debug('fetchOil executing');
  // TODO: implement - extract from scripts/ais-relay.cjs
  return {
    timestamp: new Date().toISOString(),
    source: 'oil',
    data: [],
    status: 'stub',
  };
};
