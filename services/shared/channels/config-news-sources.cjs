'use strict';

// Fetches news source configuration
module.exports = async function fetchConfigNewsSources({ config, redis, log, http }) {
  log.debug('fetchConfigNewsSources executing');
  // TODO: implement - extract from scripts/ais-relay.cjs
  return {
    timestamp: new Date().toISOString(),
    source: 'config:news-sources',
    data: [],
    status: 'stub',
  };
};
