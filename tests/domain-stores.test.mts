/**
 * Domain store modules verification.
 * Ensures news-store, markets-store, and intel-store are properly exported and initialized.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { newsStore } from '../src/stores/news-store.ts';
import { marketsStore } from '../src/stores/markets-store.ts';
import { intelStore } from '../src/stores/intel-store.ts';

function resetStores(): void {
  newsStore.allNews.length = 0;
  newsStore.newsByCategory = {};
  newsStore.latestClusters.length = 0;
  marketsStore.latestMarkets.length = 0;
  marketsStore.latestPredictions.length = 0;
  intelStore.intelligenceCache = {};
  intelStore.cyberThreatsCache = null;
}

describe('domain stores', () => {
  beforeEach(resetStores);

  describe('news-store', () => {
    it('exports newsStore with expected shape', () => {
    assert.ok(newsStore);
    assert.ok(Array.isArray(newsStore.allNews));
    assert.ok(newsStore.allNews.length === 0);
    assert.ok(typeof newsStore.newsByCategory === 'object');
    assert.ok(Object.keys(newsStore.newsByCategory).length === 0);
    assert.ok(Array.isArray(newsStore.latestClusters));
    assert.ok(newsStore.latestClusters.length === 0);
    });

    it('allNews is mutable', () => {
    const item = { id: 'test', title: 'Test', source: 'test', link: '', pubDate: new Date() };
    newsStore.allNews.push(item as never);
    assert.equal(newsStore.allNews.length, 1);
    newsStore.allNews.pop();
    assert.equal(newsStore.allNews.length, 0);
    });
  });

  describe('markets-store', () => {
    it('exports marketsStore with expected shape', () => {
    assert.ok(marketsStore);
    assert.ok(Array.isArray(marketsStore.latestMarkets));
    assert.ok(marketsStore.latestMarkets.length === 0);
    assert.ok(Array.isArray(marketsStore.latestPredictions));
    assert.ok(marketsStore.latestPredictions.length === 0);
    });

    it('latestMarkets and latestPredictions are mutable', () => {
    marketsStore.latestMarkets.push({ symbol: 'TEST', price: 100 } as never);
    assert.equal(marketsStore.latestMarkets.length, 1);
    marketsStore.latestMarkets.pop();
    assert.equal(marketsStore.latestMarkets.length, 0);
    });
  });

  describe('intel-store', () => {
    it('exports intelStore with expected shape', () => {
    assert.ok(intelStore);
    assert.ok(typeof intelStore.intelligenceCache === 'object');
    assert.ok(Object.keys(intelStore.intelligenceCache).length === 0);
    assert.equal(intelStore.cyberThreatsCache, null);
    });

    it('intelligenceCache is mutable', () => {
    intelStore.intelligenceCache.flightDelays = [];
    assert.ok(Array.isArray(intelStore.intelligenceCache.flightDelays));
    delete intelStore.intelligenceCache.flightDelays;
    });

    it('cyberThreatsCache accepts array or null', () => {
    intelStore.cyberThreatsCache = [];
    assert.ok(Array.isArray(intelStore.cyberThreatsCache));
    intelStore.cyberThreatsCache = null;
    assert.equal(intelStore.cyberThreatsCache, null);
    });
  });

  describe('stores index', () => {
    it('index exports all stores', async () => {
    const index = await import('../src/stores/index.ts');
    assert.ok(index.newsStore);
    assert.ok(index.marketsStore);
    assert.ok(index.intelStore);
    });
  });
});
