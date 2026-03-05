import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('apply* stubs are implemented', () => {
  it('applyNewsDigest is not empty', () => {
    const src = readFileSync('src/app/data-loader.ts', 'utf-8');
    // Match the method body - must have content
    const match = src.match(/applyNewsDigest\([^)]*\)[^{]*\{([\s\S]*?)^\s{2}\}/m);
    assert.ok(match && match[1].trim().length > 0, 'applyNewsDigest must not be empty');
  });

  it('data-loader has processDigestData or equivalent helper', () => {
    const src = readFileSync('src/app/data-loader.ts', 'utf-8');
    // Either a processDigestData helper or the apply* method directly contains rendering code
    const hasHelper = src.includes('processDigestData') || src.includes('renderDigest');
    const hasDirectImpl = src.match(/applyNewsDigest[\s\S]{0,500}setNews|setData|newsByCategory/);
    assert.ok(hasHelper || hasDirectImpl, 'applyNewsDigest must call rendering code');
  });
});
