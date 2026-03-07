'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  routeHttpRequest,
  handleBroadcast,
  PHASE4_CHANNEL_KEYS,
  PHASE4_MAP_KEYS,
} = require('../index.cjs');

describe('routeHttpRequest', () => {
  it('/health returns { status: "ok" } with status 200', async () => {
    const redis = { get: async () => null };
    const result = await Promise.resolve(routeHttpRequest('/health', redis));
    assert.strictEqual(result.status, 200);
    const body = JSON.parse(result.body);
    assert.strictEqual(body.status, 'ok');
    assert.strictEqual(typeof body.uptime, 'number');
    assert.ok(result.headers['Access-Control-Allow-Origin']);
  });

  it('/panel/markets with Redis hit returns the data with status 200', async () => {
    const panelData = { items: [1, 2, 3] };
    const redis = {
      get: async (key) => (key === 'market:dashboard:v1' ? panelData : null),
    };
    const result = await Promise.resolve(routeHttpRequest('/panel/markets', redis));
    assert.strictEqual(result.status, 200);
    const body = JSON.parse(result.body);
    assert.deepStrictEqual(body, panelData);
  });

  it('/panel/markets with Redis miss returns { status: "pending" } with status 200', async () => {
    const redis = { get: async () => null };
    const result = await Promise.resolve(routeHttpRequest('/panel/markets', redis));
    assert.strictEqual(result.status, 200);
    const body = JSON.parse(result.body);
    assert.strictEqual(body.status, 'pending');
    assert.strictEqual(result.headers['Cache-Control'], 'no-store');
  });

  it('/panel/unknown-channel returns 404', async () => {
    const redis = { get: async () => null };
    const result = await Promise.resolve(routeHttpRequest('/panel/unknown-channel', redis));
    assert.strictEqual(result.status, 404);
    const body = JSON.parse(result.body);
    assert.strictEqual(body.error, 'Not found');
  });

  it('/bootstrap returns object with all known channels (Redis null → all null)', async () => {
    const redis = { get: async () => null };
    const result = await Promise.resolve(routeHttpRequest('/bootstrap', redis));
    assert.strictEqual(result.status, 200);
    const body = JSON.parse(result.body);
    assert.ok(typeof body === 'object');
    const channels = Object.keys(PHASE4_CHANNEL_KEYS);
    for (const ch of channels) {
      assert.ok(ch in body, `missing channel ${ch}`);
      assert.strictEqual(body[ch], null);
    }
  });

  it('/map/ais with Redis hit returns data', async () => {
    const mapData = { vessels: [] };
    const redis = {
      get: async (key) => (key === 'relay:ais-snapshot:v1' ? mapData : null),
    };
    const result = await Promise.resolve(routeHttpRequest('/map/ais', redis));
    assert.strictEqual(result.status, 200);
    const body = JSON.parse(result.body);
    assert.deepStrictEqual(body, mapData);
  });

  it('/map/unknown returns 404', async () => {
    const redis = { get: async () => null };
    const result = await Promise.resolve(routeHttpRequest('/map/unknown', redis));
    assert.strictEqual(result.status, 404);
    const body = JSON.parse(result.body);
    assert.strictEqual(body.error, 'Not found');
  });
});

describe('handleBroadcast', () => {
  it('when no clients subscribed to channel: returns 0', () => {
    const subscriptions = new Map();
    const count = handleBroadcast('markets', { x: 1 }, subscriptions);
    assert.strictEqual(count, 0);
  });

  it('when 2 clients subscribed: returns 2, both send called with correct message', () => {
    const sent = [];
    const client1 = { send: (m) => sent.push({ id: 1, msg: m }), readyState: 1 };
    const client2 = { send: (m) => sent.push({ id: 2, msg: m }), readyState: 1 };
    const subscriptions = new Map([['markets', new Set([client1, client2])]]);
    const data = { price: 100 };
    const count = handleBroadcast('markets', data, subscriptions);
    assert.strictEqual(count, 2);
    assert.strictEqual(sent.length, 2);
    for (const s of sent) {
      const parsed = JSON.parse(s.msg);
      assert.strictEqual(parsed.type, 'wm-push');
      assert.strictEqual(parsed.channel, 'markets');
      assert.deepStrictEqual(parsed.data, data);
      assert.strictEqual(typeof parsed.ts, 'number');
    }
  });

  it('send errors are caught (one client throws, other still gets message)', () => {
    const sent = [];
    const client1 = {
      send: () => {
        throw new Error('send failed');
      },
      readyState: 1,
    };
    const client2 = { send: (m) => sent.push(m), readyState: 1 };
    const subscriptions = new Map([['markets', new Set([client1, client2])]]);
    const count = handleBroadcast('markets', { x: 1 }, subscriptions);
    assert.strictEqual(count, 1);
    assert.strictEqual(sent.length, 1);
    const parsed = JSON.parse(sent[0]);
    assert.strictEqual(parsed.type, 'wm-push');
    assert.strictEqual(parsed.channel, 'markets');
  });
});

describe('PHASE4_CHANNEL_KEYS', () => {
  it('has "intelligence" as backward-compat alias for ai:intel-digest', () => {
    assert.ok('intelligence' in PHASE4_CHANNEL_KEYS);
    assert.ok('ai:intel-digest' in PHASE4_CHANNEL_KEYS);
    assert.strictEqual(
      PHASE4_CHANNEL_KEYS.intelligence,
      PHASE4_CHANNEL_KEYS['ai:intel-digest']
    );
    assert.strictEqual(PHASE4_CHANNEL_KEYS.intelligence, 'ai:digest:global:v1');
  });

  it('has "ais" key', () => {
    assert.ok('ais' in PHASE4_CHANNEL_KEYS);
    assert.strictEqual(PHASE4_CHANNEL_KEYS.ais, 'relay:ais-snapshot:v1');
  });
});
