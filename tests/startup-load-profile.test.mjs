import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getStartupLoadProfile } from '../src/app/startup-load-profile.ts';

describe('startup load profile', () => {
  it('defines critical and deferred phases with exact values', () => {
    const profile = getStartupLoadProfile('full');
    assert.strictEqual(profile.initialRequestBudget, 10);
    assert.ok(profile.phaseBDelayMs >= 1000, 'phaseBDelayMs should be at least 1000ms');
    assert.strictEqual(profile.phaseBDelayMs, 2000);
    assert.deepEqual(profile.phaseA, ['news', 'markets']);
    assert.deepEqual(profile.phaseB, ['predictions', 'fred', 'oil', 'bis', 'pizzint']);
    assert.deepEqual(profile.phaseC, ['intelligence', 'natural', 'weather', 'ais', 'cables', 'cyberThreats']);
    assert.ok(profile.phaseA.every((t) => typeof t === 'string'));
    assert.ok(profile.phaseB.every((t) => typeof t === 'string'));
    assert.ok(profile.phaseC.every((t) => typeof t === 'string'));
  });
});
