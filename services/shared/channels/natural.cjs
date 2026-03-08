'use strict';

// Fetches data from natural disaster/hazard APIs
module.exports = async function fetchNatural({ config, redis, log, http }) {
  log.debug('fetchNatural executing');
  // TODO: implement - extract from scripts/ais-relay.cjs
  return {
    timestamp: new Date().toISOString(),
    source: 'natural',
    data: [],
    status: 'stub',
  };
};
