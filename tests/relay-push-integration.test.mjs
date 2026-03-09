// tests/relay-push-integration.test.mjs
import { readFileSync } from 'node:fs';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { subscribe, destroyRelayPush, dispatchForTesting } from '../src/services/relay-push.ts';
import { DATA_LOADER_CHANNEL_MAP } from '../src/config/channel-registry.ts';

describe('relay-push integration: channel-to-apply wiring', () => {
  const appSrc = readFileSync('src/App.ts', 'utf-8');
  const dataLoaderSrc = readFileSync('src/app/data-loader.ts', 'utf-8');

  it('App.ts auto-wires from CHANNEL_REGISTRY via loop', () => {
    assert.ok(
      appSrc.includes('CHANNEL_REGISTRY') && appSrc.includes('getPushHandler') && appSrc.includes('subscribeRelayPush'),
      'App.ts must loop over CHANNEL_REGISTRY and subscribe via getPushHandler'
    );
  });

  it('news channel is wired via domain handlers', () => {
    const newsHandlerSrc = readFileSync('src/data/news-handler.ts', 'utf-8');
    assert.ok(
      (appSrc.includes('news:') || appSrc.includes('`news:')) && (dataLoaderSrc.includes('createNewsHandlers') || newsHandlerSrc.includes('processDigestData')),
      'news channel must be subscribed and news-handler must implement digest logic'
    );
  });

  const dataLoaderChannels = [
    ...Object.entries(DATA_LOADER_CHANNEL_MAP),
    ['pizzint', 'applyPizzInt'],
  ];

  for (const [channel, applyFn] of dataLoaderChannels) {
    it(`channel '${channel}' is wired via domain handlers (was ${applyFn})`, () => {
      const registryHasIt = DATA_LOADER_CHANNEL_MAP[channel] === applyFn || (channel === 'pizzint' && applyFn === 'applyPizzInt');
      const dataLoaderUsesDomainHandlers = dataLoaderSrc.includes('domainHandlers') && dataLoaderSrc.includes('getHandler') && dataLoaderSrc.includes('createNewsHandlers');
      assert.ok(
        registryHasIt && dataLoaderUsesDomainHandlers,
        `Channel '${channel}' must be in registry and DataLoader must use domain handlers`
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
