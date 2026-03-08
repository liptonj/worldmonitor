'use strict';

/**
 * Test-only helper to inject a mock Redis client.
 * Uses process.__REDIS_TEST_CLIENT__ which redis.cjs checks when NODE_ENV=test.
 * Not part of the redis public API.
 */
function setClientForTesting(client) {
  process.__REDIS_TEST_CLIENT__ = client;
}

module.exports = { setClientForTesting };
