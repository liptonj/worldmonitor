'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseNewsFromRedis, unwrapEnvelope } = require('../../utils/news-parse.cjs');

test('parseNewsFromRedis returns [] for null/undefined', () => {
  assert.deepStrictEqual(parseNewsFromRedis(null), []);
  assert.deepStrictEqual(parseNewsFromRedis(undefined), []);
});

test('parseNewsFromRedis parses JSON string', () => {
  assert.deepStrictEqual(parseNewsFromRedis('{"items":[{"title":"A"}]}'), [{ title: 'A' }]);
});

test('parseNewsFromRedis flattens categories', () => {
  const raw = {
    categories: {
      intel: { items: [{ title: 'Intel 1' }, { title: 'Intel 2' }] },
      conflict: { items: [{ title: 'Conflict 1' }] },
    },
  };
  assert.deepStrictEqual(parseNewsFromRedis(raw), [
    { title: 'Intel 1' },
    { title: 'Intel 2' },
    { title: 'Conflict 1' },
  ]);
});

test('parseNewsFromRedis unwraps envelope then flattens', () => {
  const raw = {
    timestamp: '2026-01-01',
    source: 'news',
    status: 'success',
    data: {
      categories: {
        a: { items: [{ title: 'A1' }] },
      },
    },
  };
  assert.deepStrictEqual(parseNewsFromRedis(raw), [{ title: 'A1' }]);
});

test('parseNewsFromRedis supports data/items fallback', () => {
  assert.deepStrictEqual(parseNewsFromRedis({ data: [{ title: 'D' }] }), [{ title: 'D' }]);
  assert.deepStrictEqual(parseNewsFromRedis({ items: [{ title: 'I' }] }), [{ title: 'I' }]);
});
