'use strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'test-anon-key';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  processAisMessage,
  getSnapshot,
  _resetVessels,
} = require('../index.cjs');

describe('processAisMessage', () => {
  beforeEach(() => {
    _resetVessels();
  });

  it('parses valid message, updates vessels map, returns vessel data', () => {
    const msg = {
      MetaData: {
        MMSI: 123456789,
        latitude: 45.5,
        longitude: -122.6,
        time_utc: '2025-01-01T12:00:00Z',
        ShipName: 'Test Vessel',
      },
    };
    const result = processAisMessage(JSON.stringify(msg));
    assert.ok(result);
    assert.strictEqual(result.mmsi, '123456789');
    assert.strictEqual(result.lat, 45.5);
    assert.strictEqual(result.lon, -122.6);
    assert.strictEqual(result.ship_name, 'Test Vessel');
    assert.strictEqual(result.timestamp, '2025-01-01T12:00:00Z');

    const snapshot = getSnapshot();
    assert.strictEqual(snapshot.count, 1);
    assert.strictEqual(snapshot.vessels[0].mmsi, '123456789');
  });

  it('handles malformed JSON gracefully (returns null)', () => {
    const result = processAisMessage('not valid json {{{');
    assert.strictEqual(result, null);
  });

  it('handles missing MMSI gracefully (returns null)', () => {
    const msg = { MetaData: { latitude: 45, longitude: -122 } };
    const result = processAisMessage(JSON.stringify(msg));
    assert.strictEqual(result, null);
  });
});

describe('getSnapshot', () => {
  beforeEach(() => {
    _resetVessels();
  });

  it('returns vessels array, count, and timestamp', () => {
    processAisMessage(
      JSON.stringify({
        MetaData: { MMSI: 111, latitude: 1, longitude: 2 },
      })
    );
    processAisMessage(
      JSON.stringify({
        MetaData: { MMSI: 222, latitude: 3, longitude: 4 },
      })
    );

    const snapshot = getSnapshot();
    assert.ok(Array.isArray(snapshot.vessels));
    assert.strictEqual(snapshot.count, 2);
    assert.ok(snapshot.timestamp);
    assert.strictEqual(typeof snapshot.timestamp, 'string');
  });
});

describe('getSnapshot with disruptions and density', () => {
  beforeEach(() => {
    _resetVessels();
  });

  it('snapshot includes disruptions and density arrays', () => {
    // Add vessels near Strait of Hormuz (26.56, 56.25)
    for (let i = 0; i < 10; i++) {
      processAisMessage(JSON.stringify({
        MetaData: { MMSI: 300000 + i, latitude: 26.5 + i * 0.01, longitude: 56.2 + i * 0.01, time_utc: new Date().toISOString(), ShipName: `Tanker ${i}` },
      }));
    }
    const snapshot = getSnapshot();
    assert.ok(Array.isArray(snapshot.disruptions), 'snapshot should have disruptions array');
    assert.ok(Array.isArray(snapshot.density), 'snapshot should have density array');
  });

  it('detects chokepoint congestion when >= 5 vessels in a chokepoint', () => {
    for (let i = 0; i < 6; i++) {
      processAisMessage(JSON.stringify({
        MetaData: { MMSI: 400000 + i, latitude: 26.56 + i * 0.01, longitude: 56.25 + i * 0.01, time_utc: new Date().toISOString() },
      }));
    }
    const snapshot = getSnapshot();
    const hormuz = snapshot.disruptions.find(d => d.name === 'Strait of Hormuz');
    assert.ok(hormuz, 'should detect Strait of Hormuz congestion');
    assert.strictEqual(hormuz.type, 'chokepoint_congestion');
    assert.ok(hormuz.vesselCount >= 5);
  });

  it('calculates density zones for cells with >= 2 vessels', () => {
    processAisMessage(JSON.stringify({
      MetaData: { MMSI: 500001, latitude: 10.5, longitude: 20.5 },
    }));
    processAisMessage(JSON.stringify({
      MetaData: { MMSI: 500002, latitude: 10.6, longitude: 20.6 },
    }));
    const snapshot = getSnapshot();
    assert.ok(snapshot.density.length >= 1, 'should have at least one density zone');
    assert.ok(snapshot.density[0].intensity > 0);
  });
});
