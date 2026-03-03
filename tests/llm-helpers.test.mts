// tests/llm-helpers.test.mts
import { strict as assert } from 'assert';
import { test } from 'node:test';

test('buildPrompt: replaces {date} placeholder', async () => {
  const { buildPrompt } = await import('../server/_shared/llm.js');
  const result = buildPrompt('Hello {date}', { date: '2026-03-03' });
  assert.strictEqual(result, 'Hello 2026-03-03');
});

test('buildPrompt: leaves unknown placeholders untouched', async () => {
  const { buildPrompt } = await import('../server/_shared/llm.js');
  const result = buildPrompt('Hi {unknown}', { date: '2026-03-03' });
  assert.strictEqual(result, 'Hi {unknown}');
});
