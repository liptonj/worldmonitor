'use strict';

const CHANNEL_REGISTRY = {
  'markets': require('./markets.cjs'),
  'stablecoins': require('./stablecoins.cjs'),
  'etf-flows': require('./etf-flows.cjs'),
  'macro-signals': require('./macro-signals.cjs'),
  'strategic-risk': require('./strategic-risk.cjs'),
  'predictions': require('./predictions.cjs'),
  'news:full': require('./news-full.cjs'),
  'news:tech': require('./news-tech.cjs'),
  'news:finance': require('./news-finance.cjs'),
  'news:happy': require('./news-happy.cjs'),
  'supply-chain': require('./supply-chain.cjs'),
  'strategic-posture': require('./strategic-posture.cjs'),
  'pizzint': require('./pizzint.cjs'),
  'iran-events': require('./iran-events.cjs'),
  'weather': require('./weather.cjs'),
  'gps-interference': require('./gps-interference.cjs'),
  'cables': require('./cables.cjs'),
  'cyber': require('./cyber.cjs'),
  'service-status': require('./service-status.cjs'),
  'trade': require('./trade.cjs'),
  'fred': require('./fred.cjs'),
  'oil': require('./oil.cjs'),
  'conflict': require('./conflict.cjs'),
  'natural': require('./natural.cjs'),
  'eonet': require('./eonet.cjs'),
  'gdacs': require('./gdacs.cjs'),
  'oref': require('./oref.cjs'),
  'opensky': require('./opensky.cjs'),
  'gdelt': require('./gdelt.cjs'),
  'youtube-live': require('./youtube-live.cjs'),
  'bis': require('./bis.cjs'),
  'flights': require('./flights.cjs'),
  'aviation-precache': require('./aviation-precache.cjs'),
  'giving': require('./giving.cjs'),
  'climate': require('./climate.cjs'),
  'ucdp-events': require('./ucdp-events.cjs'),
  'gulf-quotes': require('./gulf-quotes.cjs'),
  'tech-events': require('./tech-events.cjs'),
  'security-advisories': require('./security-advisories.cjs'),
  'spending': require('./spending.cjs'),
  'config:news-sources': require('./config-news-sources.cjs'),
  'config:feature-flags': require('./config-feature-flags.cjs'),
  'temporal-anomalies': require('./temporal-anomalies.cjs'),
};

function getChannel(serviceKey) {
  return CHANNEL_REGISTRY[serviceKey] || null;
}

module.exports = { CHANNEL_REGISTRY, getChannel };
