// tests/relay-cron-contracts.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('relay cron contracts', () => {
  it('relay requires node-cron', () => {
    const src = readFileSync('scripts/ais-relay.cjs', 'utf8');
    assert.ok(src.includes("require('node-cron')") || src.includes('require("node-cron")'),
      'relay must require node-cron');
  });

  it('relay defines warmIntelligenceAndBroadcast for LLM route', () => {
    const src = readFileSync('scripts/ais-relay.cjs', 'utf8');
    assert.ok(src.includes('warmIntelligenceAndBroadcast'),
      'relay must define warmIntelligenceAndBroadcast for intelligence channel');
  });

  it('relay schedules market cron every 5 minutes', () => {
    const src = readFileSync('scripts/ais-relay.cjs', 'utf8');
    assert.ok(src.includes("'*/5 * * * *'") || src.includes('"*/5 * * * *"'),
      'relay must schedule a cron every 5 minutes');
  });

  it('relay schedules news cron', () => {
    const src = readFileSync('scripts/ais-relay.cjs', 'utf8');
    assert.ok(src.includes('news') && src.includes('cron.schedule'),
      'relay must schedule a news cron');
  });
});
