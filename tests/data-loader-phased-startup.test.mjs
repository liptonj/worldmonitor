import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('phased startup wiring', () => {
  it('loadAllData is a relay-push no-op', () => {
    const src = readFileSync('src/app/data-loader.ts', 'utf-8');
    assert.ok(!src.includes('getStartupLoadProfile'), 'loadAllData should not use phased startup — relay push handles data');
    assert.ok(src.includes('updateSearchIndex'), 'loadAllData should still call updateSearchIndex');
  });
});
