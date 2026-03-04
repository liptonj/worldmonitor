import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('dashboard startup budget guardrails', () => {
  it('startup request budget constant is <= 10', () => {
    const src = readFileSync('src/app/startup-load-profile.ts', 'utf-8');
    const match = src.match(/initialRequestBudget:\s*(\d+)/);
    assert.ok(match, 'initialRequestBudget not found in startup-load-profile.ts');
    assert.ok(Number(match[1]) <= 10, `startup budget must be <= 10, got ${match[1]}`);
  });

  it('phase A contains fewer than 5 tasks (critical path is small)', () => {
    const src = readFileSync('src/app/startup-load-profile.ts', 'utf-8');
    // Count entries in the phaseA array by finding it in the source
    const phaseAMatch = src.match(/phaseA:\s*\[([^\]]*)\]/s);
    assert.ok(phaseAMatch, 'phaseA not found in startup-load-profile.ts');
    const entries = phaseAMatch[1].split(',').map(s => s.trim()).filter(Boolean);
    assert.ok(entries.length < 5, `Phase A should have fewer than 5 tasks, got ${entries.length}: ${entries.join(', ')}`);
  });
});
