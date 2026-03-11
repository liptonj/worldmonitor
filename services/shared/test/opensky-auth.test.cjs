'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { getOpenSkyToken, _resetForTest } = require('../opensky-auth.cjs');

test('getOpenSkyToken returns null when no credentials configured', async () => {
  _resetForTest();
  const token = await getOpenSkyToken({});
  assert.strictEqual(token, null);
});

test('getOpenSkyToken returns token on successful OAuth2 exchange', async () => {
  _resetForTest();
  const mockFetch = async (url, opts) => {
    assert.ok(url.includes('auth.opensky-network.org'));
    assert.strictEqual(opts.method, 'POST');
    assert.ok(opts.body.includes('grant_type=client_credentials'));
    assert.ok(opts.body.includes('client_id=test-id'));
    assert.ok(opts.body.includes('client_secret=test-secret'));
    return {
      ok: true,
      json: async () => ({ access_token: 'mock-token-123', expires_in: 1800 }),
    };
  };

  const token = await getOpenSkyToken(
    { OPENSKY_CLIENT_ID: 'test-id', OPENSKY_CLIENT_SECRET: 'test-secret' },
    mockFetch,
  );
  assert.strictEqual(token, 'mock-token-123');
});

test('getOpenSkyToken caches token on subsequent calls', async () => {
  _resetForTest();
  let fetchCount = 0;
  const mockFetch = async () => {
    fetchCount++;
    return {
      ok: true,
      json: async () => ({ access_token: 'cached-token', expires_in: 1800 }),
    };
  };

  const config = { OPENSKY_CLIENT_ID: 'test-id', OPENSKY_CLIENT_SECRET: 'test-secret' };
  const t1 = await getOpenSkyToken(config, mockFetch);
  const t2 = await getOpenSkyToken(config, mockFetch);
  assert.strictEqual(t1, 'cached-token');
  assert.strictEqual(t2, 'cached-token');
  assert.strictEqual(fetchCount, 1);
});

test('getOpenSkyToken returns null and enters cooldown on auth failure', async () => {
  _resetForTest();
  let fetchCount = 0;
  const failingFetch = async () => {
    fetchCount++;
    return {
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    };
  };

  const config = { OPENSKY_CLIENT_ID: 'test-id', OPENSKY_CLIENT_SECRET: 'test-secret' };
  const token = await getOpenSkyToken(config, failingFetch);
  assert.strictEqual(token, null);

  const prevFetchCount = fetchCount;
  const succeedingFetch = async () => {
    fetchCount++;
    return {
      ok: true,
      json: async () => ({ access_token: 'should-not-get', expires_in: 1800 }),
    };
  };
  const token2 = await getOpenSkyToken(config, succeedingFetch);
  assert.strictEqual(token2, null, 'Should still return null during cooldown');
  assert.strictEqual(fetchCount, prevFetchCount, 'Should not attempt fetch during cooldown');
});
