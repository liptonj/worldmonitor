import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('trade dashboard batch', () => {
  it('proto defines GetTradeDashboard RPC', () => {
    const proto = readFileSync('proto/worldmonitor/trade/v1/service.proto', 'utf-8');
    assert.ok(proto.includes('GetTradeDashboard'), 'missing GetTradeDashboard in service.proto');
  });

  it('server handler exports getTradeDashboard', () => {
    const src = readFileSync('server/worldmonitor/trade/v1/handler.ts', 'utf-8');
    assert.ok(src.includes('getTradeDashboard'), 'missing getTradeDashboard in handler');
  });

  it('data-loader uses fetchTradeDashboard (one call not four)', () => {
    const src = readFileSync('src/app/data-loader.ts', 'utf-8');
    assert.ok(src.includes('fetchTradeDashboard'), 'data-loader should use fetchTradeDashboard');
    assert.ok(!src.includes('fetchTradeRestrictions('), 'data-loader should not call fetchTradeRestrictions directly');
  });
});
