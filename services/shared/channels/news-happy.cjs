'use strict';

const { buildNewsDigest } = require('./_news-helper.cjs');
const { HAPPY_FEEDS } = require('./_news-feeds.cjs');

module.exports = async function fetchNewsHappy({ config, redis, log, http }) {
  log.debug('fetchNewsHappy executing');
  return buildNewsDigest(HAPPY_FEEDS, 'news:happy', { config, redis, log, http });
};
