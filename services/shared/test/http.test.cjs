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

  it('fetchWithRetry clears timer when fetch throws', async () => {
    globalThis.fetch = async () => {
      throw new Error('network error');
    };

    await assert.rejects(
      () => http.fetchWithRetry('http://example.com', {}, 1, 5),
      /network error/
    );
  });

  it('fetchJson returns parsed JSON on 200', async () => {
    globalThis.fetch = async () => ({
      status: 200,
      json: () => ({ foo: 'bar' }),
    });

    const data = await http.fetchJson('http://example.com');
    assert.deepStrictEqual(data, { foo: 'bar' });
  });

  it('fetchJson throws on non-2xx', async () => {
    globalThis.fetch = async () => ({
      status: 404,
      text: () => 'Not Found',
    });

    await assert.rejects(
      () => http.fetchJson('http://example.com'),
      /HTTP 404/
    );
  });

  it('fetchText returns text string on 200', async () => {
    globalThis.fetch = async () => ({
      status: 200,
      text: () => 'hello world',
    });

    const text = await http.fetchText('http://example.com');
    assert.strictEqual(text, 'hello world');
  });

  it('fetchText throws on non-2xx', async () => {
    globalThis.fetch = async () => ({
      status: 500,
      text: () => 'Internal Server Error',
    });

    await assert.rejects(
      () => http.fetchText('http://example.com'),
      /HTTP 500/
    );
  });

  it('fetchWithRetry rejects on timeout (AbortError)', async () => {
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';
    globalThis.fetch = async () => {
      throw abortErr;
    };

    await assert.rejects(
      () => http.fetchWithRetry('http://example.com', {}, 0, 5),
      (err) => err.name === 'AbortError' || /timeout|aborted/i.test(err.message)
    );
  });
});
