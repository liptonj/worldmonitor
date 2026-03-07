'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const http = require('../http.cjs');

describe('http', () => {
  let origFetch;

  beforeEach(() => {
    origFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('fetchWithRetry retries on 429', async () => {
    let attempts = 0;
    globalThis.fetch = async (url) => {
      attempts++;
      if (attempts < 2) {
        return { status: 429, text: () => 'rate limited' };
      }
      return { status: 200, ok: true };
    };

    const res = await http.fetchWithRetry('http://example.com', {}, 3, 10);
    assert.strictEqual(attempts, 2);
    assert.strictEqual(res.status, 200);
  });

  it('fetchWithRetry retries on 5xx', async () => {
    let attempts = 0;
    globalThis.fetch = async () => {
      attempts++;
      if (attempts < 2) {
        return { status: 502, text: () => 'bad gateway' };
      }
      return { status: 200, ok: true };
    };

    const res = await http.fetchWithRetry('http://example.com', {}, 3, 10);
    assert.strictEqual(attempts, 2);
    assert.strictEqual(res.status, 200);
  });

  it('fetchWithRetry throws after exhausting retries', async () => {
    globalThis.fetch = async () => ({ status: 500, text: () => 'error' });

    await assert.rejects(
      () => http.fetchWithRetry('http://example.com', {}, 2, 5),
      /HTTP 500/
    );
  });
});
