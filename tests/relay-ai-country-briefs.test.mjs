// tests/relay-ai-country-briefs.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('relay AI country briefs', () => {
  const src = readFileSync('scripts/ais-relay.cjs', 'utf8');

  it('defines generateCountryBriefs function', () => {
    assert.ok(src.includes('generateCountryBriefs'));
  });

  it('uses intel_brief prompt key', () => {
    assert.ok(src.includes("'intel_brief'") || src.includes('"intel_brief"'));
  });

  it('broadcasts to ai:country-briefs channel', () => {
    assert.ok(src.includes("'ai:country-briefs'") || src.includes('"ai:country-briefs"'));
  });

  it('determines active countries from data', () => {
    assert.ok(src.includes('activeCountries') || src.includes('topCountries') || src.includes('detectActiveCountries'),
      'must determine which countries to generate briefs for');
  });
});
