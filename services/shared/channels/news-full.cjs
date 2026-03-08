'use strict';

const { buildNewsDigest } = require('./_news-helper.cjs');
const { FULL_FEEDS } = require('./_news-feeds.cjs');

module.exports = async function fetchNewsFull({ config, redis, log, http }) {
  log.debug('fetchNewsFull executing');
  return buildNewsDigest(FULL_FEEDS, 'news:full', { config, redis, log, http });
};
