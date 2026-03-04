import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('loadMarkets implementation', () => {
  it('calls fetchMarketDashboard only once', () => {
    const src = readFileSync(resolve('src/app/data-loader.ts'), 'utf-8');
    const loadMarketsBlock = src.slice(
      src.indexOf('async loadMarkets()'),
      src.indexOf('async loadPredictions()')
    );
    const count = (loadMarketsBlock.match(/fetchMarketDashboard\(/g) || []).length;
    assert.equal(count, 1, 'loadMarkets should call fetchMarketDashboard exactly once');
  });
});
