import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getStartupLoadProfile } from '../src/app/startup-load-profile.ts';

describe('startup load profile', () => {
  it('defines critical and deferred phases with request budget <= 10', () => {
    const profile = getStartupLoadProfile('full');
    assert.ok(profile.initialRequestBudget <= 10);
    assert.ok(profile.phaseA.length > 0);
    assert.ok(profile.phaseB.length > 0);
    assert.ok(profile.phaseC.length > 0);
  });
});
