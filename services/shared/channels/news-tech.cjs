'use strict';

const { buildNewsDigest } = require('./_news-helper.cjs');
const { TECH_FEEDS } = require('./_news-feeds.cjs');

module.exports = async function fetchNewsTech({ config, redis, log, http }) {
  log.debug('fetchNewsTech executing');
  return buildNewsDigest(TECH_FEEDS, 'news:tech', { config, redis, log, http });
};
