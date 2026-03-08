'use strict';

const { buildNewsDigest } = require('./_news-helper.cjs');
const { FINANCE_FEEDS } = require('./_news-feeds.cjs');

module.exports = async function fetchNewsFinance({ config, redis, log, http }) {
  log.debug('fetchNewsFinance executing');
  return buildNewsDigest(FINANCE_FEEDS, 'news:finance', { config, redis, log, http });
};
