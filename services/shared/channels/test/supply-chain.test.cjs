'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fetchSupplyChain = require('../supply-chain.cjs');

const mockRedis = { get: async () => null, setex: async () => {} };
const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

test('fetchSupplyChain returns worker-compatible format on success', async () => {
  const mockHttp = {
    fetchJson: async () => ({
      broadcast_warn: [
        { navArea: 'IV', msgYear: '2026', msgNumber: '001', text: 'Suez Canal restricted. Red sea transit delays.', subregion: '' },
      ],
    }),
  };

  const result = await fetchSupplyChain({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'supply-chain');
  assert.ok(result.timestamp);
  assert.ok(Array.isArray(result.data));
  assert.strictEqual(result.data.length, 6);
  const suez = result.data.find((c) => c.id === 'suez');
  assert.ok(suez);
  assert.ok(suez.activeWarnings >= 1);
  assert.ok(['green', 'yellow', 'red'].includes(suez.status));
});

test('fetchSupplyChain handles fetch error gracefully', async () => {
  const mockHttp = {
    fetchJson: async () => {
      throw new Error('NGA HTTP 500');
    },
  };

  const result = await fetchSupplyChain({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.ok(Array.isArray(result.data));
  assert.strictEqual(result.data.length, 6);
  result.data.forEach((cp) => {
    assert.strictEqual(cp.activeWarnings, 0);
    assert.strictEqual(cp.status, 'green');
  });
});

test('fetchSupplyChain handles invalid NGA response', async () => {
  const mockHttp = {
    fetchJson: async () => null,
  };

  const result = await fetchSupplyChain({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.ok(Array.isArray(result.data));
  assert.strictEqual(result.data.length, 6);
});

test('fetchSupplyChain returns all chokepoints with correct structure', async () => {
  const mockHttp = {
    fetchJson: async () => [],
  };

  const result = await fetchSupplyChain({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  const ids = new Set(result.data.map((c) => c.id));
  assert.ok(ids.has('suez'));
  assert.ok(ids.has('malacca'));
  assert.ok(ids.has('hormuz'));
  assert.ok(ids.has('bab_el_mandeb'));
  assert.ok(ids.has('panama'));
  assert.ok(ids.has('taiwan'));
  result.data.forEach((cp) => {
    assert.ok(cp.name);
    assert.ok(typeof cp.lat === 'number');
    assert.ok(typeof cp.lon === 'number');
    assert.ok(cp.affectedRoutes);
    assert.ok(Array.isArray(cp.affectedRoutes));
  });
});
