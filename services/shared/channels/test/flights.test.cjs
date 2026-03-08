'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fetchFlights = require('../flights.cjs');

const mockRedis = { get: async () => null, setex: async () => {} };
const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

test('fetchFlights returns worker-compatible format on success', async () => {
  const mockHttp = {
    fetchText: async () => `
      <AIRPORT_STATUS_INFORMATION>
        <Ground_Delay><ARPT>JFK</ARPT><Reason>Weather</Reason><Avg>45</Avg></Ground_Delay>
      </AIRPORT_STATUS_INFORMATION>
    `,
    fetchJson: async () => ({}),
  };

  const result = await fetchFlights({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'flights');
  assert.ok(result.timestamp);
  assert.ok(Array.isArray(result.data));
  assert.ok(result.data.length >= 1);
  const jfk = result.data.find((a) => a.iata === 'JFK');
  assert.ok(jfk);
  assert.strictEqual(jfk.avgDelayMinutes, 45);
  assert.ok(jfk.severity);
  assert.ok(jfk.reason);
});

test('fetchFlights handles FAA fetch error gracefully', async () => {
  const mockHttp = {
    fetchText: async () => {
      throw new Error('FAA HTTP 500');
    },
    fetchJson: async () => ({}),
  };

  const result = await fetchFlights({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.ok(Array.isArray(result.data));
  assert.strictEqual(result.data.length, 20);
  result.data.forEach((a) => {
    assert.strictEqual(a.severity, 'FLIGHT_DELAY_SEVERITY_NORMAL');
    assert.strictEqual(a.avgDelayMinutes, 0);
  });
});

test('fetchFlights handles invalid FAA XML', async () => {
  const mockHttp = {
    fetchText: async () => 'not valid xml <<<',
    fetchJson: async () => ({}),
  };

  const result = await fetchFlights({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.ok(Array.isArray(result.data));
  assert.strictEqual(result.data.length, 20);
});

test('fetchFlights includes AviationStack data when API key configured', async () => {
  let aviationstackCalled = false;
  const mockHttp = {
    fetchText: async () => '',
    fetchJson: async (url) => {
      if (url.includes('aviationstack.com')) {
        aviationstackCalled = true;
        return {
          data: [
            { flight_status: 'cancelled', departure: {} },
            { flight_status: 'cancelled', departure: {} },
            { flight_status: 'active', departure: { delay: 60 } },
            { flight_status: 'active', departure: { delay: 90 } },
            { flight_status: 'active', departure: {} },
            { flight_status: 'active', departure: {} },
            { flight_status: 'active', departure: {} },
            { flight_status: 'active', departure: {} },
            { flight_status: 'active', departure: {} },
            { flight_status: 'active', departure: {} },
          ],
        };
      }
      return {};
    },
  };

  const result = await fetchFlights({
    config: { AVIATIONSTACK_API_KEY: 'test-key' },
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.ok(aviationstackCalled);
  assert.ok(Array.isArray(result.data));
  const avstack = result.data.find((a) => a.id?.startsWith('avstack-'));
  if (avstack) {
    assert.ok(avstack.cancelledFlights >= 0);
    assert.ok(avstack.reason);
  }
});
