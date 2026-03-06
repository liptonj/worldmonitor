// tests/relay-ai-client-wiring.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('relay AI client wiring', () => {
  it('App.ts subscribes to ai:intel-digest channel', () => {
    const src = readFileSync('src/App.ts', 'utf8');
    assert.ok(src.includes("'ai:intel-digest'") || src.includes('"ai:intel-digest"'));
  });

  it('App.ts subscribes to ai:panel-summary channel', () => {
    const src = readFileSync('src/App.ts', 'utf8');
    assert.ok(src.includes("'ai:panel-summary'") || src.includes('"ai:panel-summary"'));
  });

  it('App.ts subscribes to ai:country-briefs channel', () => {
    const src = readFileSync('src/App.ts', 'utf8');
    assert.ok(src.includes("'ai:country-briefs'") || src.includes('"ai:country-briefs"'));
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
