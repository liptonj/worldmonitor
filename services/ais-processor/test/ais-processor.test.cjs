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
