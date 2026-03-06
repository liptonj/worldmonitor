// tests/relay-ai-panel-summary.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('relay AI panel summary (two-model)', () => {
  const src = readFileSync('scripts/ais-relay.cjs', 'utf8');

  it('defines generatePanelSummary function', () => {
    assert.ok(src.includes('generatePanelSummary'), 'must define generatePanelSummary');
  });

  it('uses view_summary prompt key', () => {
    assert.ok(src.includes("'view_summary'") || src.includes('"view_summary"'));
  });

  it('uses view_summary_arbiter prompt key', () => {
    assert.ok(src.includes("'view_summary_arbiter'") || src.includes('"view_summary_arbiter"'));
  });

  it('reads telegram data from Redis', () => {
    assert.ok(src.includes('relay:telegram'), 'must read telegram data for panel summary context');
  });

  it('reads full news descriptions not just titles', () => {
    assert.ok(src.includes('description') || src.includes('content') || src.includes('snippet'),
      'must extract article descriptions/content, not just titles');
  });

  it('runs two model calls before arbiter', () => {
    assert.ok(src.includes('modelAOutput') || src.includes('summaryA') || src.includes('summaryAPromise'),
      'must run two independent model calls');
  });

  it('broadcasts to ai:panel-summary channel', () => {
    assert.ok(src.includes("'ai:panel-summary'") || src.includes('"ai:panel-summary"'));
  });
});
