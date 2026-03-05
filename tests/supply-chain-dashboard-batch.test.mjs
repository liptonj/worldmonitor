import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('supply chain dashboard batch', () => {
  it('proto defines GetSupplyChainDashboard RPC', () => {
    const proto = readFileSync('proto/worldmonitor/supply_chain/v1/service.proto', 'utf-8');
    assert.ok(proto.includes('GetSupplyChainDashboard'), 'missing GetSupplyChainDashboard in service.proto');
  });

  it('server handler exports getSupplyChainDashboard', () => {
    const src = readFileSync('server/worldmonitor/supply-chain/v1/handler.ts', 'utf-8');
    assert.ok(src.includes('getSupplyChainDashboard'), 'missing getSupplyChainDashboard in handler');
  });

  it('data-loader uses fetchSupplyChainDashboard (one call not three)', () => {
    const src = readFileSync('src/app/data-loader.ts', 'utf-8');
    assert.ok(src.includes('fetchSupplyChainDashboard'), 'data-loader should use fetchSupplyChainDashboard');
    assert.ok(!src.includes('fetchShippingRates()'), 'data-loader should not call fetchShippingRates directly');
  });
});
