import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('BIS dashboard batch', () => {
  it('proto defines GetBisDashboard RPC', () => {
    const proto = readFileSync('proto/worldmonitor/economic/v1/service.proto', 'utf-8');
    assert.ok(proto.includes('GetBisDashboard'), 'missing GetBisDashboard in service.proto');
  });

  it('server handler exports getBisDashboard', () => {
    const src = readFileSync('server/worldmonitor/economic/v1/handler.ts', 'utf-8');
    assert.ok(src.includes('getBisDashboard'), 'missing getBisDashboard in handler');
  });

  it('data-loader uses fetchBisDashboard (one call not three)', () => {
    const src = readFileSync('src/app/data-loader.ts', 'utf-8');
    assert.ok(src.includes('fetchBisDashboard'), 'data-loader should use fetchBisDashboard');
  });
});
