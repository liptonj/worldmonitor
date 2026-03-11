'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { extractJson, interpolate } = require('../llm.cjs');

test('extractJson parses clean JSON', () => {
  const input = '{"key": "value"}';
  const result = extractJson(input);
  assert.deepStrictEqual(result, { key: 'value' });
});

test('extractJson parses JSON with leading/trailing whitespace', () => {
  const result = extractJson('  \n{"key": "value"}\n  ');
  assert.deepStrictEqual(result, { key: 'value' });
});

test('extractJson extracts from markdown code fence', () => {
  const input = 'Here is the result:\n\n```json\n{"summary": "test"}\n```\n\nHope this helps!';
  const result = extractJson(input);
  assert.deepStrictEqual(result, { summary: 'test' });
});

test('extractJson extracts from fence without json label', () => {
  const input = '```\n{"summary": "test"}\n```';
  const result = extractJson(input);
  assert.deepStrictEqual(result, { summary: 'test' });
});

test('extractJson extracts JSON from prose preamble', () => {
  const input = 'Sure! Here is the JSON you requested:\n{"summary": "test", "items": [1, 2]}';
  const result = extractJson(input);
  assert.deepStrictEqual(result, { summary: 'test', items: [1, 2] });
});

test('extractJson extracts JSON array', () => {
  const input = 'Results:\n[{"id": 1}, {"id": 2}]';
  const result = extractJson(input);
  assert.deepStrictEqual(result, [{ id: 1 }, { id: 2 }]);
});

test('extractJson throws on empty string', () => {
  assert.throws(() => extractJson(''), /empty content/);
});

test('extractJson throws on non-string', () => {
  assert.throws(() => extractJson(null), /empty content/);
});

test('extractJson throws on plain text with no JSON', () => {
  assert.throws(() => extractJson('This is just a sentence.'), /does not contain valid JSON/);
});

test('interpolate replaces placeholders', () => {
  const template = 'Hello {name}, today is {date}.';
  const result = interpolate(template, { name: 'World', date: '2026-03-10' });
  assert.strictEqual(result, 'Hello World, today is 2026-03-10.');
});

test('interpolate handles missing keys as empty string', () => {
  const result = interpolate('Value: {missing}', {});
  assert.strictEqual(result, 'Value: ');
});

test('interpolate handles null/undefined values as empty string', () => {
  const result = interpolate('{a} and {b}', { a: null, b: undefined });
  assert.strictEqual(result, ' and ');
});

test('interpolate returns empty for null template', () => {
  assert.strictEqual(interpolate(null, {}), '');
});
