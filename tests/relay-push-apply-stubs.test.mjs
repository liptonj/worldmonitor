/**
 * apply* logic is now in domain handlers, not DataLoaderManager.
 * This test verifies domain handlers implement the expected apply/render logic.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const DOMAIN_HANDLERS = [
  { file: 'src/data/news-handler.ts', has: ['processDigestData', 'renderNewsForCategory'] },
  { file: 'src/data/markets-handler.ts', has: ['renderMarketDashboard', 'renderPredictions'] },
  { file: 'src/data/economic-handler.ts', has: ['renderFredData', 'renderOilData', 'renderBisData'] },
  { file: 'src/data/intelligence-handler.ts', has: ['renderIntelligence', 'renderOrefAlerts', 'renderPizzInt'] },
  { file: 'src/data/geo-handler.ts', has: ['renderNatural', 'mergeAndRenderNaturalEvents', 'renderWeatherAlerts', 'mapClimatePayload'] },
  { file: 'src/data/infrastructure-handler.ts', has: ['renderCyberThreats', 'renderCableHealth', 'renderFlightDelays', 'renderTechEvents'] },
];

describe('apply* logic in domain handlers', () => {
  it('DataLoaderManager has no apply* methods (extracted to domain handlers)', () => {
    const src = readFileSync('src/app/data-loader.ts', 'utf-8');
    const applyMethods = ['applyNewsDigest', 'applyMarkets', 'applyPredictions', 'applyFredData', 'applyOilData', 'applyBisData', 'applyIntelligence', 'applyPizzInt', 'applyTradePolicy', 'applySupplyChain', 'applyNatural', 'applyClimate', 'applyConflict', 'applyUcdpEvents', 'applyCyberThreats', 'applyAisSignals', 'applyCableHealth', 'applyFlightDelays', 'applyWeatherAlerts', 'applySpending', 'applyGiving', 'applyTelegramIntel', 'applyOref', 'applyIranEvents', 'applyTechEvents', 'applyGpsInterference', 'applyGulfQuotes', 'applyEonet', 'applyGdacs'];
    for (const name of applyMethods) {
      const hasMethod = new RegExp(`\\b${name}\\s*\\(`).test(src);
      assert.ok(!hasMethod, `DataLoaderManager must not have ${name} (extracted to domain handlers)`);
    }
  });

  it('DataLoaderManager uses domainHandlers and getHandler delegates', () => {
    const src = readFileSync('src/app/data-loader.ts', 'utf-8');
    assert.ok(src.includes('domainHandlers'), 'DataLoaderManager must use domainHandlers');
    assert.ok(src.includes('getHandler'), 'DataLoaderManager must have getHandler');
    assert.ok(src.includes('domainHandlers[channel]') || src.includes('domainHandlers.get(channel)'), 'getHandler must delegate to domainHandlers');
  });

  for (const { file, has } of DOMAIN_HANDLERS) {
    describe(file, () => {
      for (const fn of has) {
        it(`${fn} is implemented`, () => {
          const src = readFileSync(file, 'utf-8');
          assert.ok(src.includes(fn), `${file} must implement ${fn}`);
        });
      }
    });
  }

  it('StrategicRiskPanel has applyPush', () => {
    const src = readFileSync('src/components/StrategicRiskPanel.ts', 'utf-8');
    assert.ok(src.includes('applyPush'), 'StrategicRiskPanel must implement applyPush');
  });

  it('StrategicPosturePanel has applyPush', () => {
    const src = readFileSync('src/components/StrategicPosturePanel.ts', 'utf-8');
    assert.ok(src.includes('applyPush'), 'StrategicPosturePanel must implement applyPush');
  });
});
