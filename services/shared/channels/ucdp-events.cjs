'use strict';

// Fetches data from UCDP armed conflict events API
module.exports = async function fetchUcdpEvents({ config, redis, log, http }) {
  log.debug('fetchUcdpEvents executing');
  // TODO: implement - extract from scripts/ais-relay.cjs
  return {
    timestamp: new Date().toISOString(),
    source: 'ucdp-events',
    data: [],
    status: 'stub',
  };
};
