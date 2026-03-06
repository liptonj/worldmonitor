// tests/relay-ai-intel-digest.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('relay AI intel digest', () => {
  const src = readFileSync('scripts/ais-relay.cjs', 'utf8');

  it('defines generateIntelDigest function', () => {
    assert.ok(src.includes('generateIntelDigest'), 'must define generateIntelDigest');
  });

  it('uses intel_digest prompt key', () => {
    assert.ok(src.includes("'intel_digest'") || src.includes('"intel_digest"'),
      'must load intel_digest prompt');
  });

  it('reads headlines from Redis', () => {
    assert.ok(src.includes('wm:headlines') || src.includes('relay:news:full') || src.includes('news:digest'),
      'must read headlines from Redis cache');
  });

  it('broadcasts to ai:intel-digest channel', () => {
    assert.ok(src.includes("'ai:intel-digest'") || src.includes('"ai:intel-digest"'),
      'must broadcast to ai:intel-digest');
  });
});
