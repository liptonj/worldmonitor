import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('phased startup wiring', () => {
  it('uses startup profile and request budget in loadAllData', () => {
    const src = readFileSync('src/app/data-loader.ts', 'utf-8');
    assert.ok(src.includes('getStartupLoadProfile'), 'missing getStartupLoadProfile');
    assert.ok(src.includes('createStartupRequestBudget'), 'missing createStartupRequestBudget');
    assert.ok(src.includes('phaseA'), 'missing phaseA reference');
    assert.ok(src.includes('phaseB'), 'missing phaseB reference');
  });
});
