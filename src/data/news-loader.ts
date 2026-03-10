/**
 * News domain loader — loadNews, loadNewsCategory, happy variant.
 */

import type { AppContext } from '@/app/app-context';
import type { NewsItem } from '@/types';
import { newsStore } from '@/stores/news-store';
import type { DataLoaderBridge } from './loader-bridge';
import { getFeeds, getIntelSources, SITE_VARIANT } from '@/config';
import { fetchCategoryFeeds, getFeedFailures, updateBaseline, calculateDeviation } from '@/services';
import { checkBatchForBreakingAlerts } from '@/services/breaking-news-alerts';
import { mlWorker } from '@/services/ml-worker';
import { clusterNewsHybrid } from '@/services/clustering';
import { signalAggregator } from '@/services/signal-aggregator';
import { updateAndCheck } from '@/services/temporal-baseline';
import { ingestTemporalAnomaliesForCII } from '@/services/country-instability';
import { analysisWorker } from '@/services';
import { t } from '@/services/i18n';
import { tryFetchDigest, flashMapForNews, renderNewsForCategory } from './news-handler';
import { consumePendingRawNewsData } from '@/services/news-digest';
import { classifyNewsItem } from '@/services/positive-classifier';
import { filterBySentiment } from '@/services/sentiment-gate';
import { fetchAllPositiveTopicIntelligence } from '@/services/gdelt-intel';
import { fetchKindnessData } from '@/services/kindness-data';
import { getPersistentCache, setPersistentCache } from '@/services/persistent-cache';
import { isFeatureEnabled } from '@/services/runtime-config';
import type { InsightsPanel } from '@/components/InsightsPanel';
import type { CIIPanel } from '@/components/CIIPanel';
import type { MonitorPanel } from '@/components/MonitorPanel';
import type { HeadlinesPanel } from '@/components/HeadlinesPanel';

const PER_FEED_FALLBACK_CATEGORY_LIMIT = 3;
const PER_FEED_FALLBACK_INTEL_LIMIT = 6;
const PER_FEED_FALLBACK_BATCH_SIZE = 2;
const HAPPY_ITEMS_CACHE_KEY = 'happy-all-items';

function getStaleNewsItems(category: string): NewsItem[] {
  const staleItems = newsStore.newsByCategory[category];
  if (!Array.isArray(staleItems) || staleItems.length === 0) return [];
  return [...staleItems].sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());
}

function selectLimitedFeeds<T>(feeds: T[], maxFeeds: number): T[] {
  if (feeds.length <= maxFeeds) return feeds;
  return feeds.slice(0, maxFeeds);
}

function isPerFeedFallbackEnabled(): boolean {
  return isFeatureEnabled('newsPerFeedFallback');
}

async function loadNewsCategory(bridge: DataLoaderBridge, category: string, feeds: import('@/types').Feed[]): Promise<NewsItem[]> {
  const ctx = bridge.ctx;
  const panel = ctx.newsPanels[category];

  const enabledFeeds = (feeds ?? []).filter(f => !ctx.disabledSources.has(f.name));
  if (enabledFeeds.length === 0) {
    delete newsStore.newsByCategory[category];
    if (panel) panel.showError(t('common.allSourcesDisabled'));
    ctx.statusPanel?.updateFeed(category.charAt(0).toUpperCase() + category.slice(1), { status: 'ok', itemCount: 0 });
    return [];
  }
  const enabledNames = new Set(enabledFeeds.map(f => f.name));

  const renderIntervalMs = 100;
  let lastRenderTime = 0;
  let renderTimeout: ReturnType<typeof setTimeout> | null = null;
  let pendingItems: NewsItem[] | null = null;

  const flushPendingRender = () => {
    if (!pendingItems) return;
    renderNewsForCategory(ctx, category, pendingItems);
    pendingItems = null;
    lastRenderTime = Date.now();
  };

  const scheduleRender = (partialItems: NewsItem[]) => {
    if (!panel) return;
    pendingItems = partialItems;
    const elapsed = Date.now() - lastRenderTime;
    if (elapsed >= renderIntervalMs) {
      if (renderTimeout) { clearTimeout(renderTimeout); renderTimeout = null; }
      flushPendingRender();
      return;
    }
    if (!renderTimeout) {
      renderTimeout = setTimeout(() => {
        renderTimeout = null;
        flushPendingRender();
      }, renderIntervalMs - elapsed);
    }
  };

  const staleItems = getStaleNewsItems(category).filter(i => enabledNames.has(i.source));
  if (staleItems.length > 0) {
    console.warn(`[News] Digest missing for "${category}", serving stale headlines (${staleItems.length})`);
    renderNewsForCategory(ctx, category, staleItems);
    ctx.statusPanel?.updateFeed(category.charAt(0).toUpperCase() + category.slice(1), { status: 'ok', itemCount: staleItems.length });
    return staleItems;
  }

  if (!isPerFeedFallbackEnabled()) {
    console.warn(`[News] Digest missing for "${category}", limited per-feed fallback disabled`);
    renderNewsForCategory(ctx, category, []);
    ctx.statusPanel?.updateFeed(category.charAt(0).toUpperCase() + category.slice(1), { status: 'error', errorMessage: 'Digest unavailable' });
    return [];
  }

  const fallbackFeeds = selectLimitedFeeds(enabledFeeds, PER_FEED_FALLBACK_CATEGORY_LIMIT);
  if (fallbackFeeds.length < enabledFeeds.length) {
    console.warn(`[News] Digest missing for "${category}", using limited per-feed fallback (${fallbackFeeds.length}/${enabledFeeds.length} feeds)`);
  } else {
    console.warn(`[News] Digest missing for "${category}", using per-feed fallback (${fallbackFeeds.length} feeds)`);
  }

  const items = await fetchCategoryFeeds(fallbackFeeds, {
    batchSize: PER_FEED_FALLBACK_BATCH_SIZE,
    onBatch: (partialItems) => {
      scheduleRender(partialItems);
      flashMapForNews(ctx, partialItems);
      checkBatchForBreakingAlerts(partialItems);
    },
  });

  renderNewsForCategory(ctx, category, items);
  if (panel) {
    if (renderTimeout) { clearTimeout(renderTimeout); renderTimeout = null; pendingItems = null; }
    if (items.length === 0) {
      const failures = getFeedFailures();
      const failedFeeds = fallbackFeeds.filter(f => failures.has(f.name));
      if (failedFeeds.length > 0) {
        panel.showError(`${t('common.noNewsAvailable')} (${failedFeeds.map(f => f.name).join(', ')} failed)`);
      }
    }
    try {
      const baseline = await updateBaseline(`news:${category}`, items.length);
      const deviation = calculateDeviation(items.length, baseline);
      panel.setDeviation(deviation.zScore, deviation.percentChange, deviation.level);
    } catch (e) { console.warn(`[Baseline] news:${category} write failed:`, e); }
  }

  ctx.statusPanel?.updateFeed(category.charAt(0).toUpperCase() + category.slice(1), { status: 'ok', itemCount: items.length });
  ctx.statusPanel?.updateApi('RSS2JSON', { status: 'ok' });
  return items;
}

export const newsLoader = {
  async loadNews(bridge: DataLoaderBridge): Promise<void> {
    const ctx = bridge.ctx;
    if (SITE_VARIANT === 'happy') newsStore.happyAllItems = [];

    const digestPromise = tryFetchDigest();
    const SOURCES_WAIT_MS = 3000;
    await Promise.race([bridge.getSourcesReady(), new Promise<void>(r => setTimeout(r, SOURCES_WAIT_MS))]);

    const feedsMap = getFeeds();
    const categories = Object.entries(feedsMap)
      .filter((e): e is [string, import('@/types').Feed[]] => Array.isArray(e[1]) && e[1].length > 0)
      .map(([key, feeds]) => ({ key, feeds }));

    const digest = await digestPromise;
    if (digest) {
      bridge.getHandler('news:full')?.(digest);
      return;
    }

    // Relay may have sent a flat array instead of a structured digest.
    // fetchNewsDigest stashed it; route through applyNewsDigest which handles
    // flat arrays, envelopes, and structured digests uniformly.
    const rawNewsData = consumePendingRawNewsData();
    if (rawNewsData != null) {
      bridge.getHandler('news:full')?.(rawNewsData);
      return;
    }

    const maxCategoryConcurrency = SITE_VARIANT === 'tech' ? 4 : 5;
    const categoryConcurrency = Math.max(1, Math.min(maxCategoryConcurrency, categories.length));
    const categoryResults: PromiseSettledResult<NewsItem[]>[] = [];
    for (let i = 0; i < categories.length; i += categoryConcurrency) {
      const chunk = categories.slice(i, i + categoryConcurrency);
      const chunkResults = await Promise.allSettled(chunk.map(({ key, feeds }) => loadNewsCategory(bridge, key, feeds)));
      categoryResults.push(...chunkResults);
    }

    const collectedNews: NewsItem[] = [];
    categoryResults.forEach((result, idx) => {
      if (result.status === 'fulfilled') {
        const items = result.value;
        if (SITE_VARIANT === 'happy') {
          for (const item of items) item.happyCategory = classifyNewsItem(item.source, item.title);
          newsStore.happyAllItems = newsStore.happyAllItems.concat(items);
        }
        collectedNews.push(...items);
      } else {
        console.error(`[App] News category ${categories[idx]?.key} failed:`, result.reason);
      }
    });

    if (SITE_VARIANT === 'full') {
      const enabledIntelSources = getIntelSources().filter(f => !ctx.disabledSources.has(f.name));
      const enabledIntelNames = new Set(enabledIntelSources.map(f => f.name));
      const intelPanel = ctx.newsPanels['intel'];
      if (enabledIntelSources.length === 0) {
        delete newsStore.newsByCategory['intel'];
        if (intelPanel) intelPanel.showError(t('common.allIntelSourcesDisabled'));
        ctx.statusPanel?.updateFeed('Intel', { status: 'ok', itemCount: 0 });
      } else {
        const staleIntel = getStaleNewsItems('intel').filter(i => enabledIntelNames.has(i.source));
        if (staleIntel.length > 0) {
          console.warn(`[News] Intel digest missing, serving stale headlines (${staleIntel.length})`);
          renderNewsForCategory(ctx, 'intel', staleIntel);
          if (intelPanel) {
            try {
              const baseline = await updateBaseline('news:intel', staleIntel.length);
              const deviation = calculateDeviation(staleIntel.length, baseline);
              intelPanel.setDeviation(deviation.zScore, deviation.percentChange, deviation.level);
            } catch (e) { console.warn('[Baseline] news:intel write failed:', e); }
          }
          ctx.statusPanel?.updateFeed('Intel', { status: 'ok', itemCount: staleIntel.length });
          collectedNews.push(...staleIntel);
        } else if (!isPerFeedFallbackEnabled()) {
          console.warn('[News] Intel digest missing, limited per-feed fallback disabled');
          delete newsStore.newsByCategory['intel'];
          ctx.statusPanel?.updateFeed('Intel', { status: 'error', errorMessage: 'Digest unavailable' });
        } else {
          const fallbackIntelFeeds = selectLimitedFeeds(enabledIntelSources, PER_FEED_FALLBACK_INTEL_LIMIT);
          const intelResult = await Promise.allSettled([fetchCategoryFeeds(fallbackIntelFeeds, { batchSize: PER_FEED_FALLBACK_BATCH_SIZE })]);
          if (intelResult[0]?.status === 'fulfilled') {
            const intel = intelResult[0].value;
            checkBatchForBreakingAlerts(intel);
            renderNewsForCategory(ctx, 'intel', intel);
            if (intelPanel) {
              try {
                const baseline = await updateBaseline('news:intel', intel.length);
                const deviation = calculateDeviation(intel.length, baseline);
                intelPanel.setDeviation(deviation.zScore, deviation.percentChange, deviation.level);
              } catch (e) { console.warn('[Baseline] news:intel write failed:', e); }
            }
            ctx.statusPanel?.updateFeed('Intel', { status: 'ok', itemCount: intel.length });
            collectedNews.push(...intel);
            flashMapForNews(ctx, intel);
          } else {
            delete newsStore.newsByCategory['intel'];
            console.error('[App] Intel feed failed:', intelResult[0]?.reason);
          }
        }
      }
    }

    newsStore.allNews = collectedNews;
    ctx.initialLoadComplete = true;

    updateAndCheck([{ type: 'news', region: 'global', count: collectedNews.length }]).then(anomalies => {
      if (anomalies.length > 0) {
        signalAggregator.ingestTemporalAnomalies(anomalies);
        ingestTemporalAnomaliesForCII(anomalies);
        (ctx.panels['cii'] as CIIPanel)?.refresh();
      }
    }).catch(() => {});

    ctx.map?.updateHotspotActivity(newsStore.allNews);

    const monitorPanel = ctx.panels['monitors'] as MonitorPanel;
    monitorPanel.renderResults(newsStore.allNews);
    const headlinesPanel = ctx.panels['headlines'];
    if (headlinesPanel && 'renderItems' in headlinesPanel) {
      (headlinesPanel as HeadlinesPanel).renderItems(newsStore.allNews);
    }

    void (mlWorker.isAvailable ? clusterNewsHybrid(newsStore.allNews) : analysisWorker.clusterNews(newsStore.allNews))
      .then(clusters => {
        if (ctx.isDestroyed) return;
        newsStore.latestClusters = clusters;
        if (clusters.length > 0) {
          (ctx.panels['insights'] as InsightsPanel | undefined)?.updateInsights(clusters);
        }
        const geoLocated = clusters
          .filter((c): c is typeof c & { lat: number; lon: number } => c.lat != null && c.lon != null)
          .map(c => ({ lat: c.lat, lon: c.lon, title: c.primaryTitle, threatLevel: c.threat?.level ?? 'info', timestamp: c.lastUpdated }));
        if (geoLocated.length > 0) ctx.map?.setNewsLocations(geoLocated);
      })
      .catch(err => console.error('[App] Clustering failed, clusters unchanged:', err));
  },

  async hydrateHappyPanelsFromCache(ctx: AppContext): Promise<void> {
    try {
      type CachedItem = Omit<NewsItem, 'pubDate'> & { pubDate: number };
      const entry = await getPersistentCache<CachedItem[]>(HAPPY_ITEMS_CACHE_KEY);
      if (!entry?.data?.length || Date.now() - entry.updatedAt > 24 * 60 * 60 * 1000) return;

      const items: NewsItem[] = entry.data.map(item => ({ ...item, pubDate: new Date(item.pubDate) }));
      const scienceSources = ['GNN Science', 'ScienceDaily', 'Nature News', 'Live Science', 'New Scientist', 'Singularity Hub', 'Human Progress', 'Greater Good (Berkeley)'];
      ctx.breakthroughsPanel?.setItems(items.filter(i => scienceSources.includes(i.source) || i.happyCategory === 'science-health'));
      ctx.heroPanel?.setHeroStory(items.filter(i => i.happyCategory === 'humanity-kindness').sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime())[0]);
      ctx.digestPanel?.setStories([...items].sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime()).slice(0, 5));
      ctx.positivePanel?.renderPositiveNews(items);
    } catch (err) {
      console.warn('[App] Happy panel cache hydration failed:', err);
    }
  },

  async loadHappySupplementaryAndRender(bridge: DataLoaderBridge): Promise<void> {
    const ctx = bridge.ctx;
    if (!ctx.positivePanel) return;

    const curated = [...newsStore.happyAllItems];
    ctx.positivePanel.renderPositiveNews(curated);

    let supplementary: NewsItem[] = [];
    try {
      const gdeltTopics = await fetchAllPositiveTopicIntelligence();
      const gdeltItems: NewsItem[] = gdeltTopics.flatMap(topic =>
        topic.articles.map(article => ({
          source: 'GDELT',
          title: article.title,
          link: article.url,
          pubDate: article.date ? new Date(article.date) : new Date(),
          isAlert: false,
          imageUrl: article.image || undefined,
          happyCategory: classifyNewsItem('GDELT', article.title),
        }))
      );
      supplementary = await filterBySentiment(gdeltItems);
    } catch (err) {
      console.warn('[App] Happy supplementary pipeline failed, using curated only:', err);
    }

    if (supplementary.length > 0) {
      const merged = [...curated, ...supplementary].sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());
      ctx.positivePanel.renderPositiveNews(merged);
    }

    const scienceSources = ['GNN Science', 'ScienceDaily', 'Nature News', 'Live Science', 'New Scientist', 'Singularity Hub', 'Human Progress', 'Greater Good (Berkeley)'];
    const scienceItems = newsStore.happyAllItems.filter(i => scienceSources.includes(i.source) || i.happyCategory === 'science-health');
    ctx.breakthroughsPanel?.setItems(scienceItems);

    const heroItem = newsStore.happyAllItems.filter(i => i.happyCategory === 'humanity-kindness').sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime())[0];
    ctx.heroPanel?.setHeroStory(heroItem);

    ctx.digestPanel?.setStories([...newsStore.happyAllItems].sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime()).slice(0, 5));

    setPersistentCache(HAPPY_ITEMS_CACHE_KEY, newsStore.happyAllItems.map(i => ({ ...i, pubDate: i.pubDate.getTime() }))).catch(() => {});
  },

  loadKindnessData(ctx: AppContext): void {
    const kindnessItems = fetchKindnessData(newsStore.happyAllItems.map(i => ({ title: i.title, happyCategory: i.happyCategory })));
    ctx.map?.setKindnessData(kindnessItems);
  },
};
