// tests/relay-ai-client-wiring.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('relay AI client wiring', () => {
  it('channel registry includes ai:intel-digest', () => {
    const src = readFileSync('src/config/channel-registry.ts', 'utf8');
    assert.ok(src.includes("'ai:intel-digest'") || src.includes('"ai:intel-digest"'), 'channel registry must include ai:intel-digest');
  });

  it('channel registry includes ai:panel-summary', () => {
    const src = readFileSync('src/config/channel-registry.ts', 'utf8');
    assert.ok(src.includes("'ai:panel-summary'") || src.includes('"ai:panel-summary"'), 'channel registry must include ai:panel-summary');
  });

  it('channel registry includes ai:country-briefs', () => {
    const src = readFileSync('src/config/channel-registry.ts', 'utf8');
    assert.ok(src.includes("'ai:country-briefs'") || src.includes('"ai:country-briefs"'), 'channel registry must include ai:country-briefs');
  });

  it('SummarizeViewModal uses cached panel summary', () => {
    const src = readFileSync('src/components/SummarizeViewModal.ts', 'utf8');
    assert.ok(src.includes('__wmLatestPanelSummary') || src.includes('panel-summary-updated') || src.includes('latestPanelSummary'));
  });

  it('DeductionPanel calls relay /api/deduct', () => {
    const src = readFileSync('src/components/DeductionPanel.ts', 'utf8');
    assert.ok(src.includes('/api/deduct'), 'must call relay /api/deduct endpoint');
  });
});
