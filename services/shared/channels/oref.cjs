'use strict';

// Fetches data from Israel OREF rocket alert system API
module.exports = async function fetchOref({ config, redis, log, http }) {
  log.debug('fetchOref executing');
  // TODO: implement - extract from scripts/ais-relay.cjs
  return {
    timestamp: new Date().toISOString(),
    source: 'oref',
    data: [],
    status: 'stub',
  };
};
