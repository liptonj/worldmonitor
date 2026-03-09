// tests/relay-push-integration.test.mjs
import { readFileSync } from 'node:fs';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { subscribe, destroyRelayPush, dispatchForTesting } from '../src/services/relay-push.ts';

describe('relay-push integration: channel-to-apply wiring', () => {
  const appSrc = readFileSync('src/App.ts', 'utf-8');
  const dataLoaderSrc = readFileSync('src/app/data-loader.ts', 'utf-8');

  it('App.ts auto-wires from CHANNEL_REGISTRY via loop', () => {
    assert.ok(
      appSrc.includes('CHANNEL_REGISTRY') && appSrc.includes('getPushHandler') && appSrc.includes('subscribeRelayPush'),
      'App.ts must loop over CHANNEL_REGISTRY and subscribe via getPushHandler'
    );
  });

  it('news channel is wired to applyNewsDigest', () => {
    assert.ok(
      (appSrc.includes('news:') || appSrc.includes('`news:')) && (appSrc.includes('applyNewsDigest') || dataLoaderSrc.includes('applyNewsDigest')),
      'news channel must be subscribed and use applyNewsDigest'
    );
  });

  const dataLoaderChannels = [
    ['markets', 'applyMarkets'],
    ['predictions', 'applyPredictions'],
    ['fred', 'applyFredData'],
    ['bis', 'applyBisData'],
    ['oil', 'applyOilData'],
    ['cables', 'applyCableHealth'],
    ['natural', 'applyNatural'],
    ['cyber', 'applyCyberThreats'],
    ['flights', 'applyFlightDelays'],
    ['ais', 'applyAisSignals'],
    ['weather', 'applyWeatherAlerts'],
    ['spending', 'applySpending'],
    ['giving', 'applyGiving'],
    ['telegram', 'applyTelegramIntel'],
    ['intelligence', 'applyIntelligence'],
    ['oref', 'applyOref'],
    ['iran-events', 'applyIranEvents'],
    ['tech-events', 'applyTechEvents'],
    ['gulf-quotes', 'applyGulfQuotes'],
    ['gps-interference', 'applyGpsInterference'],
    ['eonet', 'applyEonet'],
    ['gdacs', 'applyGdacs'],
    ['pizzint', 'applyPizzInt'],
    ['trade', 'applyTradePolicy'],
    ['supply-chain', 'applySupplyChain'],
  ];

  for (const [channel, applyFn] of dataLoaderChannels) {
    it(`channel '${channel}' is wired to ${applyFn}`, () => {
      const channelPattern = channel.includes('-') ? `'${channel}'` : `${channel}:`;
      const inDataLoader = dataLoaderSrc.includes(channelPattern) && dataLoaderSrc.includes(applyFn);
      const inApp = appSrc.includes(`'${channel}'`) && appSrc.includes(applyFn);
      assert.ok(
        inDataLoader || inApp,
        `Channel '${channel}' must be wired to ${applyFn} (in data-loader CHANNEL_TO_APPLY_METHOD or App)`
      );
    });
  }
});

describe('relay-push integration: behavioral dispatch', () => {
  afterEach(() => {
    destroyRelayPush();
  });

  it('subscribeRelayPush calls callback when payload arrives via dispatchForTesting', () => {
    let received = null;
    const unsub = subscribe('test-channel', (p) => { received = p; });
    const payload = { test: true, value: 42 };
    dispatchForTesting('test-channel', payload);
    assert.deepEqual(received, payload, 'callback must receive dispatched payload');
    unsub();
  });

  it('unsubscribe prevents callback from being called', () => {
    let callCount = 0;
    const unsub = subscribe('test-channel-2', () => { callCount += 1; });
    dispatchForTesting('test-channel-2', {});
    assert.equal(callCount, 1, 'callback called once before unsubscribe');
    unsub();
    dispatchForTesting('test-channel-2', {});
    assert.equal(callCount, 1, 'callback must not be called after unsubscribe');
  });

  it('markets channel dispatch invokes applyMarkets-style callback with GetMarketDashboardResponse shape', () => {
    const appliedPayloads = [];
    const mockApplyMarkets = (p) => { appliedPayloads.push(p); };
    const unsub = subscribe('markets', mockApplyMarkets);

    const validPayload = {
      stocks: [{ symbol: 'AAPL', name: 'Apple', display: 'AAPL', price: 150, change: 1.5, sparkline: [] }],
      sectors: [],
      commodities: [],
      crypto: [],
    };
    dispatchForTesting('markets', validPayload);

    assert.equal(appliedPayloads.length, 1, 'applyMarkets callback must be invoked');
    assert.deepEqual(appliedPayloads[0], validPayload, 'payload must be passed through');
    unsub();
  });
});
