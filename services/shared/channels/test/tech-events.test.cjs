'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fetchTechEvents = require('../tech-events.cjs');

const mockRedis = { get: async () => null, setex: async () => {} };
const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

test('fetchTechEvents returns worker-compatible format on success', async () => {
  const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
SUMMARY:Tech Conference 2026
LOCATION:San Francisco, CA
DTSTART;VALUE=DATE:20260615
DTEND;VALUE=DATE:20260617
URL:https://example.com
UID:tech-2026
END:VEVENT
END:VCALENDAR`;
  const mockHttp = {
    fetchText: async (url) => {
      if (url.includes('techmeme')) return ics;
      return '';
    },
  };

  const result = await fetchTechEvents({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'tech-events');
  assert.ok(result.timestamp);
  assert.ok(Array.isArray(result.data));
  assert.ok(result.data.length >= 1);
  const ev = result.data.find((e) => e.title === 'Tech Conference 2026');
  assert.ok(ev);
  assert.strictEqual(ev.startDate, '2026-06-15');
  assert.strictEqual(ev.type, 'conference');
});

test('fetchTechEvents handles fetch error gracefully', async () => {
  const mockHttp = {
    fetchText: async () => {
      throw new Error('Techmeme HTTP 500');
    },
  };

  const result = await fetchTechEvents({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  // Fetches use .catch so we get success with curated events only when fetches fail
  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'tech-events');
  assert.ok(Array.isArray(result.data));
  assert.ok(result.data.length >= 1, 'curated events still returned when fetches fail');
});

test('fetchTechEvents includes curated events', async () => {
  const mockHttp = {
    fetchText: async () => '',
  };

  const result = await fetchTechEvents({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.ok(Array.isArray(result.data));
  const curated = result.data.filter((e) => e.source === 'curated');
  assert.ok(curated.length >= 1);
  assert.ok(curated.some((e) => e.id === 'web-summit-2026'));
});

test('fetchTechEvents handles invalid ICS', async () => {
  const mockHttp = {
    fetchText: async () => 'not valid ics content',
  };

  const result = await fetchTechEvents({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.ok(Array.isArray(result.data));
});
