import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('FRED dashboard batch', () => {
  it('proto defines GetFredDashboard RPC', () => {
    const proto = readFileSync('proto/worldmonitor/economic/v1/service.proto', 'utf-8');
    assert.ok(proto.includes('GetFredDashboard'), 'missing GetFredDashboard in service.proto');
  });

  it('server handler exports getFredDashboard', () => {
    const src = readFileSync('server/worldmonitor/economic/v1/handler.ts', 'utf-8');
    assert.ok(src.includes('getFredDashboard'), 'missing getFredDashboard in handler');
  });

  it('client service exports fetchFredDashboard replacing individual fetches', () => {
    const src = readFileSync('src/services/economic/index.ts', 'utf-8');
    assert.ok(src.includes('fetchFredDashboard'), 'missing fetchFredDashboard in economic service');
  });

  it('data-loader uses fetchFredDashboard instead of fetchFredData', () => {
    const src = readFileSync('src/app/data-loader.ts', 'utf-8');
    assert.ok(src.includes('fetchFredDashboard'), 'data-loader should use fetchFredDashboard');
    assert.ok(!src.includes('fetchFredData('), 'data-loader should not call fetchFredData directly');
  });
});
