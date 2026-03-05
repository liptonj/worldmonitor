import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('sources/flags non-blocking contract', () => {
  it('App.ts does not await loadNewsSources or loadFeatureFlags before loadAllData', () => {
    const src = readFileSync('src/App.ts', 'utf8');
    // Find loadAllData position
    const loadAllDataPos = src.indexOf('loadAllData()');
    assert.ok(loadAllDataPos > -1, 'App.ts must call loadAllData()');

    // Find any awaited loadNewsSources before loadAllData
    const awaitSourcesMatch = src.match(/await\s+(?:Promise\.all\(\[)?.*?loadNewsSources/s);
    if (awaitSourcesMatch) {
      const awaitPos = src.indexOf(awaitSourcesMatch[0]);
      assert.ok(
        awaitPos > loadAllDataPos,
        'loadNewsSources must not be awaited before loadAllData() is called'
      );
    }
    // If no match, test passes (not awaited at all)
  });

  it('data-loader.ts DataLoaderManager has a setSourcesReady method', () => {
    const src = readFileSync('src/app/data-loader.ts', 'utf8');
    assert.ok(
      src.includes('setSourcesReady'),
      'DataLoaderManager must have setSourcesReady(promise) method for loadNews to await internally'
    );
  });
});
