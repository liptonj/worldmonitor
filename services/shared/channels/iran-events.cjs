'use strict';

// Extracted from scripts/ais-relay.cjs - Iran-specific events (Redis read, populated by seed script)
// Redis key: conflict:iran-events:v1

const IRAN_EVENTS_REDIS_KEY = 'conflict:iran-events:v1';

module.exports = async function fetchIranEvents({ config, redis, log, http }) {
  log.debug('fetchIranEvents executing');
  const timestamp = new Date().toISOString();

  if (!redis || typeof redis.get !== 'function') {
    log.warn('fetchIranEvents: redis not available');
    return {
      timestamp,
      source: 'iran-events',
      data: { events: [], scrapedAt: '0' },
      status: 'error',
      errors: ['Redis not configured'],
    };
  }

  try {
    const val = await redis.get(IRAN_EVENTS_REDIS_KEY);
    if (!val || typeof val !== 'object') {
      return {
        timestamp,
        source: 'iran-events',
        data: { events: [], scrapedAt: '0' },
        status: 'success',
      };
    }
    if (!Array.isArray(val.events)) {
      log.warn('fetchIranEvents: invalid events structure');
      return {
        timestamp,
        source: 'iran-events',
        data: { events: [], scrapedAt: val.scrapedAt || '0' },
        status: 'error',
        errors: ['Invalid Redis data: events must be array'],
      };
    }
    return {
      timestamp,
      source: 'iran-events',
      data: { events: val.events, scrapedAt: val.scrapedAt || '0' },
      status: 'success',
    };
  } catch (err) {
    log.error('fetchIranEvents error', { error: err?.message ?? err });
    return {
      timestamp,
      source: 'iran-events',
      data: { events: [], scrapedAt: '0' },
      status: 'error',
      errors: [err?.message ?? String(err)],
    };
  }
};
