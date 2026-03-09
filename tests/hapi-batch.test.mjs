import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('HAPI batch', () => {
  it('proto defines ListAllHumanitarianSummaries RPC', () => {
    const proto = readFileSync('proto/worldmonitor/conflict/v1/service.proto', 'utf-8');
    assert.ok(proto.includes('ListAllHumanitarianSummaries'), 'missing RPC in service.proto');
  });

  it('server handler exports listAllHumanitarianSummaries', () => {
    const src = readFileSync('server/worldmonitor/conflict/v1/handler.ts', 'utf-8');
    assert.ok(src.includes('listAllHumanitarianSummaries'), 'missing in handler');
  });

  it('conflict service exports fetchAllHapiSummaries', () => {
    const src = readFileSync('src/services/conflict/index.ts', 'utf-8');
    assert.ok(src.includes('fetchAllHapiSummaries'), 'missing fetchAllHapiSummaries in conflict service');
  });

  it('intelligence-loader uses fetchAllHapiSummaries not looping fetchHapiSummary', () => {
    const src = readFileSync('src/data/intelligence-loader.ts', 'utf-8');
    assert.ok(src.includes('fetchAllHapiSummaries'), 'intelligence-loader should use fetchAllHapiSummaries');
    // fetchHapiSummary (singular) should no longer be called directly in intelligence-loader
    assert.ok(!src.includes('fetchHapiSummary('), 'intelligence-loader should not call fetchHapiSummary directly');
  });
});
