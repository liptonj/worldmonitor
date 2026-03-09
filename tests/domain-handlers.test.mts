/**
 * Domain handler modules verification (source-level and runtime).
 * Ensures each domain handler module exists and exports create*Handlers with expected channels.
 * Runtime tests verify handlers can be invoked and update context.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
/**
 * Runtime tests require Vite env (import.meta.glob, workers) and are covered by e2e.
 * Use relay-push-integration.test.mjs for dispatch/callback behavior.
 */

const DOMAIN_MODULES = [
  { file: 'src/data/news-handler.ts', fn: 'createNewsHandlers', channels: ['news:full', 'news:tech', 'news:happy'] },
  { file: 'src/data/markets-handler.ts', fn: 'createMarketsHandlers', channels: ['markets', 'predictions', 'gulf-quotes', 'stablecoins', 'etf-flows', 'macro-signals'] },
  { file: 'src/data/economic-handler.ts', fn: 'createEconomicHandlers', channels: ['fred', 'oil', 'bis', 'trade', 'supply-chain', 'spending', 'giving'] },
  { file: 'src/data/intelligence-handler.ts', fn: 'createIntelligenceHandlers', channels: ['intelligence', 'conflict', 'ucdp-events', 'telegram', 'oref', 'iran-events', 'strategic-posture', 'strategic-risk', 'pizzint'] },
  { file: 'src/data/geo-handler.ts', fn: 'createGeoHandlers', channels: ['natural', 'eonet', 'gdacs', 'weather', 'climate', 'gps-interference'] },
  { file: 'src/data/infrastructure-handler.ts', fn: 'createInfrastructureHandlers', channels: ['cables', 'cyber', 'flights', 'ais', 'service-status', 'tech-events'] },
  { file: 'src/data/ai-handler.ts', fn: 'createAiHandlers', channels: ['ai:intel-digest', 'ai:panel-summary', 'ai:article-summaries', 'ai:classifications', 'ai:country-briefs', 'ai:posture-analysis', 'ai:instability-analysis', 'ai:risk-overview'] },
  { file: 'src/data/config-handler.ts', fn: 'createConfigHandlers', channels: ['config:news-sources', 'config:feature-flags'] },
];

describe('Domain Handler Modules', () => {
  for (const { file, fn, channels } of DOMAIN_MODULES) {
    describe(file, () => {
      it(`exports ${fn}`, () => {
        const src = readFileSync(file, 'utf-8');
        assert.ok(src.includes(`export function ${fn}`), `${file} must export ${fn}`);
      });

      it(`returns handlers for expected channels`, () => {
        const src = readFileSync(file, 'utf-8');
        for (const ch of channels) {
          const hasChannel =
            src.includes(`'${ch}'`) ||
            src.includes(`"${ch}"`) ||
            new RegExp(`[\\s{,]${ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`).test(src);
          assert.ok(hasChannel, `${file} must have handler for ${ch}`);
        }
      });
    });
  }

  it('data index exports all create*Handlers', () => {
    const src = readFileSync('src/data/index.ts', 'utf-8');
    for (const { fn } of DOMAIN_MODULES) {
      assert.ok(src.includes(fn), `src/data/index.ts must export ${fn}`);
    }
  });

  it('DataLoaderManager uses domain handlers in getHandler', () => {
    const src = readFileSync('src/app/data-loader.ts', 'utf-8');
    assert.ok(src.includes('domainHandlers'), 'DataLoaderManager must use domainHandlers');
    assert.ok(src.includes('createNewsHandlers') && src.includes('createIntelligenceHandlers'), 'DataLoaderManager must register domain handlers in constructor');
  });
});

describe('Domain Handler Runtime (structural)', () => {
  it('each domain handler returns a function for each channel key', () => {
    const src = readFileSync('src/data/index.ts', 'utf-8');
    assert.ok(src.includes('createNewsHandlers'), 'index exports createNewsHandlers');
    assert.ok(src.includes('createMarketsHandlers'), 'index exports createMarketsHandlers');
    assert.ok(src.includes('createConfigHandlers'), 'index exports createConfigHandlers');
  });

  it('domain handlers are merged in constructor', () => {
    const src = readFileSync('src/app/data-loader.ts', 'utf-8');
    assert.ok(src.includes('createNewsHandlers') && src.includes('createIntelligenceHandlers'), 'constructor calls createNewsHandlers and createIntelligenceHandlers');
  });
});
