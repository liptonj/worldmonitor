'use strict';

// Fetches data from GDACS disaster alerts API
module.exports = async function fetchGdacs({ config, redis, log, http }) {
  log.debug('fetchGdacs executing');
  // TODO: implement - extract from scripts/ais-relay.cjs
  return {
    timestamp: new Date().toISOString(),
    source: 'gdacs',
    data: [],
    status: 'stub',
  };
};
