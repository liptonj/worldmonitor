// tests/zero-browser-api-calls.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('zero browser API calls', () => {
  it('data-loader.ts does not contain fetch() calls', () => {
    const src = readFileSync('src/app/data-loader.ts', 'utf8');
    const fetchCalls = (src.match(/\bfetch\(/g) || []).length;
    assert.ok(fetchCalls === 0, `data-loader.ts still has ${fetchCalls} fetch() calls — all data should come via relay push`);
  });

  it('App.ts does not import RefreshScheduler', () => {
    const src = readFileSync('src/App.ts', 'utf8');
    assert.ok(!src.includes('RefreshScheduler'), 'App.ts must not use RefreshScheduler — relay push handles all data');
  });

  it('App.ts does not call scheduleRefresh', () => {
    const src = readFileSync('src/App.ts', 'utf8');
    assert.ok(!src.includes('scheduleRefresh'), 'No scheduleRefresh calls should exist');
  });

  it('no panel makes its own fetch call', () => {
    const panels = [
      'src/components/StablecoinPanel.ts',
      'src/components/ETFFlowsPanel.ts',
      'src/components/MacroSignalsPanel.ts',
      'src/components/ServiceStatusPanel.ts',
    ];
    for (const file of panels) {
      const src = readFileSync(file, 'utf8');
      assert.ok(!src.includes('ServiceClient'), `${file} should not use a ServiceClient — data arrives via relay push`);
    }
  });
});
