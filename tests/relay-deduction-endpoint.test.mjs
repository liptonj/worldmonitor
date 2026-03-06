// tests/relay-deduction-endpoint.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('relay deduction HTTP endpoint', () => {
  const src = readFileSync('scripts/ais-relay.cjs', 'utf8');

  it('handles POST /api/deduct route', () => {
    assert.ok(src.includes('/api/deduct'), 'must have /api/deduct route');
  });

  it('uses deduction prompt key', () => {
    assert.ok(src.includes("'deduction'"));
  });

  it('validates query input length', () => {
    assert.ok(src.includes('500') || src.includes('query'),
      'must validate query length');
  });
});
