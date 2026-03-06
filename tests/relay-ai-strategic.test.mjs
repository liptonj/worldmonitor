// tests/relay-ai-strategic.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('relay AI strategic analysis', () => {
  const src = readFileSync('scripts/ais-relay.cjs', 'utf8');

  it('defines generatePostureAnalysis', () => {
    assert.ok(src.includes('generatePostureAnalysis'));
  });

  it('defines generateInstabilityAnalysis', () => {
    assert.ok(src.includes('generateInstabilityAnalysis'));
  });

  it('defines generateRiskOverview', () => {
    assert.ok(src.includes('generateRiskOverview'));
  });

  it('broadcasts to ai:posture-analysis', () => {
    assert.ok(src.includes("'ai:posture-analysis'"));
  });

  it('broadcasts to ai:instability-analysis', () => {
    assert.ok(src.includes("'ai:instability-analysis'"));
  });

  it('broadcasts to ai:risk-overview', () => {
    assert.ok(src.includes("'ai:risk-overview'"));
  });
});
