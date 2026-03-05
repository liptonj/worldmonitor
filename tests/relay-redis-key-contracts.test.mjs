// tests/relay-redis-key-contracts.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Map: relay-assumed key prefix → server handler file → expected key fragment in that file
const KEY_CONTRACTS = [
  { relayKey: 'news:digest:v1:full:en',      file: 'server/worldmonitor/news/v1/list-feed-digest.ts',         fragment: 'news:digest:v1' },
  { relayKey: 'market:dashboard:v1',          file: 'server/worldmonitor/market/v1/get-market-dashboard.ts',   fragment: 'market:dashboard:v1' },
  { relayKey: 'economic:macro-signals:v1',    file: 'server/worldmonitor/economic/v1/get-macro-signals.ts',    fragment: 'economic:macro-signals:v1' },
  { relayKey: 'market:etf-flows:v1',          file: 'server/worldmonitor/market/v1/list-etf-flows.ts',        fragment: 'market:etf-flows:v1' },
  { relayKey: 'supply_chain:chokepoints:v1',  file: 'server/worldmonitor/supply-chain/v1/get-chokepoint-status.ts', fragment: 'supply_chain:chokepoints:v1' },
  { relayKey: 'digest:global:v1',             file: 'server/worldmonitor/intelligence/v1/get-global-intel-digest.ts', fragment: 'digest:global:v1' },
  { relayKey: 'infra:service-statuses:v1',    file: 'server/worldmonitor/infrastructure/v1/list-service-statuses.ts', fragment: 'infra:service-statuses:v1' },
  { relayKey: 'cable-health-v1',              file: 'server/worldmonitor/infrastructure/v1/get-cable-health.ts',     fragment: 'cable-health-v1' },
  { relayKey: 'economic:bis:policy:v1',       file: 'server/worldmonitor/economic/v1/get-bis-policy-rates.ts',      fragment: 'economic:bis:policy:v1' },
  { relayKey: 'wildfire:fires:v1',            file: 'server/worldmonitor/wildfire/v1/list-fire-detections.ts',      fragment: 'wildfire:fires:v1' },
];

describe('relay Redis key contracts', () => {
  for (const { relayKey, file, fragment } of KEY_CONTRACTS) {
    it(`handler ${file} uses key fragment matching relay assumption "${relayKey}"`, () => {
      const src = readFileSync(file, 'utf8');
      assert.ok(
        src.includes(fragment),
        `${file} must contain "${fragment}" (relay uses key "${relayKey}")`
      );
    });
  }
});
