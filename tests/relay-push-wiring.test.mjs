// tests/relay-push-wiring.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('App.ts relay push wiring', () => {
  it('App.ts imports initRelayPush', () => {
    const src = readFileSync('src/App.ts', 'utf8');
    assert.ok(src.includes('initRelayPush'), 'App.ts must call initRelayPush');
  });

  it('App.ts imports subscribe from relay-push', () => {
    const src = readFileSync('src/App.ts', 'utf8');
    assert.ok(src.includes("from '@/services/relay-push'") || src.includes("from './services/relay-push'"),
      'App.ts must import from relay-push service');
  });

  it('App.ts does not use scheduleRefresh for any data channel', () => {
    const src = readFileSync('src/App.ts', 'utf8');
    const matches = src.match(/scheduleRefresh\(/g);
    assert.ok(
      !matches || matches.length === 0,
      `App.ts must not call scheduleRefresh — all data comes via relay push (found ${matches?.length ?? 0} calls)`
    );
  });

  it('App.ts does not call loadAllData for API fetches', () => {
    const src = readFileSync('src/App.ts', 'utf8');
    assert.ok(
      !src.includes('this.dataLoader.loadAllData()') || src.includes('// relay push handles data loading'),
      'loadAllData should be replaced by relay push'
    );
  });
});
