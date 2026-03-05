import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('apply* stubs are implemented', () => {
  it('applyNewsDigest is not empty', () => {
    const src = readFileSync('src/app/data-loader.ts', 'utf-8');
    // Match the method body - must have content
    const match = src.match(/applyNewsDigest\([^)]*\)[^{]*\{([\s\S]*?)^\s{2}\}/m);
    assert.ok(match && match[1].trim().length > 0, 'applyNewsDigest must not be empty');
  });

  it('data-loader has processDigestData or equivalent helper', () => {
    const src = readFileSync('src/app/data-loader.ts', 'utf-8');
    // Either a processDigestData helper or the apply* method directly contains rendering code
    const hasHelper = src.includes('processDigestData') || src.includes('renderDigest');
    const hasDirectImpl = src.match(/applyNewsDigest[\s\S]{0,500}setNews|setData|newsByCategory/);
    assert.ok(hasHelper || hasDirectImpl, 'applyNewsDigest must call rendering code');
  });

  it('applyMarkets is not empty', () => {
    const src = readFileSync('src/app/data-loader.ts', 'utf-8');
    assert.ok(
      src.includes('renderMarketDashboard') || src.match(/applyMarkets\([^)]*\)\s*\{[\s\S]{20,}/),
      'applyMarkets must not be empty'
    );
  });

  for (const name of ['applyBisData', 'applyFredData', 'applyOilData']) {
    it(`${name} is not empty`, () => {
      const src = readFileSync('src/app/data-loader.ts', 'utf-8');
      const helperName = name.replace('apply', 'render');
      const hasHelper = src.includes(helperName);
      const match = src.match(new RegExp(`${name}\\s*\\([^)]*\\)\\s*\\{[\\s\\S]{20,}?^\\s{2}\\}`, 'm'));
      assert.ok(hasHelper || match, `${name} must not be empty`);
    });
  }

  for (const name of ['applyIntelligence', 'applyPizzInt', 'applyTradePolicy', 'applySupplyChain']) {
    it(`${name} is not empty`, () => {
      const src = readFileSync('src/app/data-loader.ts', 'utf-8');
      const helperName = name.replace('apply', 'render');
      assert.ok(
        src.includes(helperName),
        `${name} must use a render helper (render${name.replace('apply', '')})`
      );
    });
  }

  for (const name of ['applyAisSignals', 'applyCableHealth', 'applyFlightDelays', 'applyWeatherAlerts']) {
    it(`${name} is not empty`, () => {
      const src = readFileSync('src/app/data-loader.ts', 'utf-8');
      assert.ok(
        src.includes(`render${name.replace('apply', '')}`),
        `${name} must use a render helper`
      );
    });
  }

  for (const name of ['applyNatural', 'applyCyberThreats', 'applyPredictions', 'applySpending', 'applyGiving', 'applyTelegramIntel']) {
    it(`${name} is not empty`, () => {
      const src = readFileSync('src/app/data-loader.ts', 'utf-8');
      assert.ok(
        src.includes(`render${name.replace('apply', '')}`),
        `${name} must use a render helper`
      );
    });
  }
});
