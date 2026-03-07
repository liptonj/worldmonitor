'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const redis = require('../redis.cjs');
const { setClientForTesting } = require('./redis-test-helper.cjs');

describe('redis', () => {
  const mockClient = {
    _store: new Map(),
    async get(key) {
      return this._store.get(key) ?? null;
    },
    async setex(key, ttl, value) {
      this._store.set(key, value);
      return 'OK';
    },
  };

  beforeEach(() => {
    setClientForTesting(mockClient);
    mockClient._store.clear();
  });

  afterEach(() => {
    setClientForTesting(null);
  });

  it('get returns null for missing key', async () => {
    const result = await redis.get('nonexistent');
    assert.strictEqual(result, null);
  });

  it('setex and get round-trip JSON', async () => {
    await redis.setex('k1', 60, { a: 1, b: 'x' });
    const out = await redis.get('k1');
    assert.deepStrictEqual(out, { a: 1, b: 'x' });
  });

  it('get returns null on parse error', async () => {
    mockClient._store.set('bad', 'not valid json {{{');
    const result = await redis.get('bad');
    assert.strictEqual(result, null);
  });
});
