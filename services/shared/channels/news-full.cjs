'use strict';

// Fetches data from full news digest (multiple sources)
module.exports = async function fetchNewsFull({ config, redis, log, http }) {
  log.debug('fetchNewsFull executing');
  // TODO: implement - extract from scripts/ais-relay.cjs
  return {
    timestamp: new Date().toISOString(),
    source: 'news:full',
    data: [],
    status: 'stub',
  };
};
