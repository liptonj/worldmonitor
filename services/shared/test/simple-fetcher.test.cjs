'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { fetchSimple } = require('../channels/_simple-fetcher.cjs');
const { createLogger } = require('../logger.cjs');

const log = createLogger('simple-fetcher-test');

describe('fetchSimple', () => {
  let mockHttp;

  beforeEach(() => {
    mockHttp = {
      fetchJson: async () => ({ data: 'ok' }),
      fetchText: async () => '<rss><channel><item><title>T</title><link>http://x</link><pubDate></pubDate><description>D</description></item></channel></rss>',
    };
  });

  afterEach(() => {});

  it('returns {ok: true, data: ...} with response_format json', async () => {
    const out = await fetchSimple(
      { url: 'http://example.com/api', response_format: 'json' },
      { log, http: mockHttp }
    );
    assert.strictEqual(out.ok, true);
    assert.ok(Array.isArray(out.data));
    assert.deepStrictEqual(out.data[0], { data: 'ok' });
  });

  it('parses RSS items correctly with response_format rss', async () => {
    const out = await fetchSimple(
      { url: 'http://example.com/feed.xml', response_format: 'rss' },
      { log, http: mockHttp }
    );
    assert.strictEqual(out.ok, true);
    assert.ok(Array.isArray(out.data));
    assert.strictEqual(out.data.length, 1);
    assert.strictEqual(out.data[0].title, 'T');
    assert.strictEqual(out.data[0].link, 'http://x');
    assert.strictEqual(out.data[0].description, 'D');
  });

  it('returns {ok: false, error: ...} for invalid URL', async () => {
    const out = await fetchSimple(
      { url: 'not-a-valid-url!!!' },
      { log, http: mockHttp }
    );
    assert.strictEqual(out.ok, false);
    assert.ok(out.error.includes('not a valid URL'));
  });

  it('returns {ok: false, error: ...} for non-http/https URL', async () => {
    const out = await fetchSimple(
      { url: 'file:///etc/passwd' },
      { log, http: mockHttp }
    );
    assert.strictEqual(out.ok, false);
    assert.ok(out.error.includes('http or https'));
  });

  it('returns {ok: false, error: ...} when fetch throws', async () => {
    mockHttp.fetchJson = async () => {
      throw new Error('network error');
    };
    const out = await fetchSimple(
      { url: 'http://example.com/api', response_format: 'json' },
      { log, http: mockHttp }
    );
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.error, 'network error');
  });
});
