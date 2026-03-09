import type { AppContext, AppModule } from '@/app/app-context';
import {
  createNewsHandlers,
  createMarketsHandlers,
  createEconomicHandlers,
  createIntelligenceHandlers,
  createGeoHandlers,
  createInfrastructureHandlers,
  createAiHandlers,
  createConfigHandlers,
} from '@/data';
import { renderNewsForCategory, tryFetchDigest, flashMapForNews } from '@/data/news-handler';
import { mergeAndRenderNaturalEvents } from '@/data/geo-handler';
import type { NewsItem, MapLayers, SocialUnrestEvent } from '@/types';
import {
  getFeeds,
  getIntelSources,
  SITE_VARIANT,
  LAYER_TO_SOURCE,
} from '@/config';
import {
  fetchCategoryFeeds,
  getFeedFailures,
  fetchEarthquakes,
  fetchInternetOutages,
  isOutagesConfigured,
  getAisStatus,
  isAisConfigured,
  fetchCableActivity,
  getProtestStatus,
  fetchMilitaryFlights,
  fetchMilitaryVessels,
  initMilitaryVesselStream,
  isMilitaryVesselTrackingConfigured,
  fetchUSNIFleetReport,
  updateBaseline,
  calculateDeviation,
  addToSignalHistory,
  analysisWorker,
  fetchCyberThreats,
  drainTrendingSignals,
  fetchMarketDashboard,
} from '@/services';
import { checkBatchForBreakingAlerts } from '@/services/breaking-news-alerts';
import { mlWorker } from '@/services/ml-worker';
import { clusterNewsHybrid } from '@/services/clustering';
import { ingestFlights, ingestVessels, ingestEarthquakes, detectGeoConvergence, geoConvergenceToSignal } from '@/services/geo-convergence';
import { signalAggregator } from '@/services/signal-aggregator';
import { updateAndCheck } from '@/services/temporal-baseline';
import { analyzeFlightsForSurge, surgeAlertToSignal, detectForeignMilitaryPresence, foreignPresenceToSignal, type TheaterPostureSummary } from '@/services/military-surge';
import { fetchCachedTheaterPosture } from '@/services/cached-theater-posture';
import { ingestMilitaryForCII, ingestNewsForCII, ingestOutagesForCII, ingestUcdpForCII, ingestHapiForCII, ingestDisplacementForCII, ingestClimateForCII, ingestAdvisoriesForCII, ingestGpsJammingForCII, ingestTemporalAnomaliesForCII, isInLearningMode } from '@/services/country-instability';
import { fetchGpsInterference } from '@/services/gps-interference';
import { dataFreshness, type DataSourceId } from '@/services/data-freshness';
import { fetchUcdpClassifications, fetchAllHapiSummaries, fetchUcdpEvents, deduplicateAgainstAcled } from '@/services/conflict';
import { fetchUnhcrPopulation } from '@/services/displacement';
import { fetchClimateAnomalies } from '@/services/climate';
import { fetchSecurityAdvisories } from '@/services/security-advisories';
import { fetchTelegramFeed } from '@/services/telegram-intel';
import { fetchGivingSummary } from '@/services/giving';
import type { OrefAlertsResponse } from '@/services/oref-alerts';
import { enrichEventsWithExposure } from '@/services/population-exposure';
import { isFeatureEnabled } from '@/services/runtime-config';
import { t } from '@/services/i18n';
import { getHydratedData } from '@/services/bootstrap';
import { fetchRelayPanel } from '@/services/relay-http';
import type { GetSectorSummaryResponse, SectorPerformance } from '@/generated/client/worldmonitor/market/v1/service_client';
import type { ListFireDetectionsResponse } from '@/generated/client/worldmonitor/wildfire/v1/service_client';
import { fetchTechEvents } from '@/services/research';
import type { HeatmapPanel, CommoditiesPanel } from '@/components/MarketPanel';
import type { MonitorPanel } from '@/components/MonitorPanel';
import type { HeadlinesPanel } from '@/components/HeadlinesPanel';
import type { InsightsPanel } from '@/components/InsightsPanel';
import type { CIIPanel } from '@/components/CIIPanel';
import type { StrategicPosturePanel } from '@/components/StrategicPosturePanel';
import type { UcdpEventsPanel } from '@/components/UcdpEventsPanel';
import type { DisplacementPanel } from '@/components/DisplacementPanel';
import type { ClimateAnomalyPanel } from '@/components/ClimateAnomalyPanel';
import type { PopulationExposurePanel } from '@/components/PopulationExposurePanel';
import type { SecurityAdvisoriesPanel } from '@/components/SecurityAdvisoriesPanel';
import { classifyNewsItem } from '@/services/positive-classifier';
import { filterBySentiment } from '@/services/sentiment-gate';
import { fetchAllPositiveTopicIntelligence } from '@/services/gdelt-intel';
import { fetchPositiveGeoEvents, geocodePositiveNewsItems } from '@/services/positive-events-geo';
import { fetchKindnessData } from '@/services/kindness-data';
import { getPersistentCache, setPersistentCache } from '@/services/persistent-cache';

const CYBER_LAYER_ENABLED = import.meta.env.VITE_ENABLE_CYBER_LAYER === 'true';

export interface DataLoaderCallbacks {
  renderCriticalBanner: (postures: TheaterPostureSummary[]) => void;
}

export class DataLoaderManager implements AppModule {
  private ctx: AppContext;
  private callbacks: DataLoaderCallbacks;

  private sourcesReady: Promise<void> = Promise.resolve(); // default: already ready

  public updateSearchIndex: () => void = () => {};

  private readonly perFeedFallbackCategoryFeedLimit = 3;
  private readonly perFeedFallbackIntelFeedLimit = 6;
  private readonly perFeedFallbackBatchSize = 2;
  private lastCommodityData: Array<{ display: string; price: number | null; change: number | null; sparkline?: number[] }> = [];
  private firesCache: ListFireDetectionsResponse | null = null;

  private domainHandlers: Record<string, (payload: unknown) => void>;

  constructor(ctx: AppContext, callbacks: DataLoaderCallbacks) {
    this.ctx = ctx;
    this.callbacks = callbacks;
    const newsCallbacks = {
      onNewsDigestProcessed: () => {
        void this.loadHappySupplementaryAndRender().then(() =>
          Promise.allSettled([
            this.ctx.mapLayers.positiveEvents ? this.loadPositiveEvents() : Promise.resolve(),
            this.ctx.mapLayers.kindness ? Promise.resolve(this.loadKindnessData()) : Promise.resolve(),
          ])
        );
      },
    };
    const marketsCallbacks = {
      onPredictionsRendered: () => this.runCorrelationAnalysis(),
      onMarketsRendered: (commodityData: import('@/data/types').CommodityDataItem[]) => {
        this.lastCommodityData = commodityData;
      },
    };
    const geoCallbacks = {
      onNaturalApplied: (data: ListFireDetectionsResponse) => {
        this.firesCache = data;
      },
    };
    this.domainHandlers = {
      ...createNewsHandlers(this.ctx, newsCallbacks),
      ...createMarketsHandlers(this.ctx, marketsCallbacks),
      ...createEconomicHandlers(this.ctx),
      ...createIntelligenceHandlers(this.ctx),
      ...createGeoHandlers(this.ctx, geoCallbacks),
      ...createInfrastructureHandlers(this.ctx),
      ...createAiHandlers(this.ctx),
      ...createConfigHandlers(this.ctx),
    };
  }

  /**
   * Returns a bound handler for relay push payloads, or undefined if this channel is not handled by DataLoader.
   * Used by App.setupRelayPush to auto-wire subscriptions from CHANNEL_REGISTRY.
   */
  getHandler(channel: string): ((payload: unknown) => void) | undefined {
    return this.domainHandlers[channel];
  }

  public setSourcesReady(promise: Promise<unknown>): void {
    this.sourcesReady = promise.then(() => {}).catch(() => {});
  }

  init(): void {}

  destroy(): void {}

  /**
   * Unified data loading pattern:
   * 1. Try hydrated data from bootstrap (instant)
   * 2. If not available, fetch from /panel/:channel (fallback)
   * 3. Subscribe to WebSocket for real-time updates (handled in App.ts)
   */
  private async loadChannelWithFallback<T>(
    channel: string,
    renderFn: (data: T) => void
  ): Promise<boolean> {
    const hydrated = getHydratedData(channel);
    if (hydrated) {
      renderFn(hydrated as T);
      return true;
    }
    const panelData = await fetchRelayPanel<T>(channel);
    if (panelData) {
      renderFn(panelData);
      return true;
    }
    return false;
  }

  private isPerFeedFallbackEnabled(): boolean {
    return isFeatureEnabled('newsPerFeedFallback');
  }

  private getStaleNewsItems(category: string): NewsItem[] {
    const staleItems = this.ctx.newsByCategory[category];
    if (!Array.isArray(staleItems) || staleItems.length === 0) return [];
    return [...staleItems].sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());
  }

  private selectLimitedFeeds<T>(feeds: T[], maxFeeds: number): T[] {
    if (feeds.length <= maxFeeds) return feeds;
    return feeds.slice(0, maxFeeds);
  }

  private shouldShowIntelligenceNotifications(): boolean {
    return !this.ctx.isMobile && !!this.ctx.findingsBadge?.isPopupEnabled();
  }

  async loadAllData(): Promise<void> {
    // Relay push handles all data — arrives via WebSocket on connect.
    // No browser-side polling; load* methods remain for loadDataForLayer (user-triggered).
    this.updateSearchIndex();
  }

  async loadDataForLayer(layer: keyof MapLayers): Promise<void> {
    if (this.ctx.isDestroyed || this.ctx.inFlight.has(layer)) return;
    this.ctx.inFlight.add(layer);
    this.ctx.map?.setLayerLoading(layer, true);
    try {
      switch (layer) {
        case 'natural':
          await this.loadNatural();
          break;
        case 'fires':
          await this.loadFirmsData();
          break;
        case 'weather':
          await this.loadWeatherAlerts();
          break;
        case 'outages':
          await this.loadOutages();
          break;
        case 'cyberThreats':
          await this.loadCyberThreats();
          break;
        case 'ais':
          await this.loadAisSignals();
          break;
        case 'cables':
          await Promise.all([this.loadCableActivity(), this.loadCableHealth()]);
          break;
        case 'protests':
          await this.loadProtests();
          break;
        case 'flights':
          await this.loadFlightDelays();
          break;
        case 'military':
          await this.loadMilitary();
          break;
        case 'techEvents':
          await this.loadTechEvents();
          break;
        case 'positiveEvents':
          await this.loadPositiveEvents();
          break;
        case 'kindness':
          this.loadKindnessData();
          break;
        case 'iranAttacks':
          await this.loadIranEvents();
          break;
        case 'ucdpEvents':
        case 'displacement':
        case 'climate':
        case 'gpsJamming':
          await this.loadIntelligenceSignals();
          break;
      }
    } finally {
      this.ctx.inFlight.delete(layer);
      this.ctx.map?.setLayerLoading(layer, false);
    }
  }

  private async loadNewsCategory(category: string, feeds: import('@/types').Feed[]): Promise<NewsItem[]> {
    try {
      const panel = this.ctx.newsPanels[category];

      const enabledFeeds = (feeds ?? []).filter(f => !this.ctx.disabledSources.has(f.name));
      if (enabledFeeds.length === 0) {
        delete this.ctx.newsByCategory[category];
        if (panel) panel.showError(t('common.allSourcesDisabled'));
        this.ctx.statusPanel?.updateFeed(category.charAt(0).toUpperCase() + category.slice(1), {
          status: 'ok',
          itemCount: 0,
        });
        return [];
      }
      const enabledNames = new Set(enabledFeeds.map(f => f.name));

      // Per-feed fallback: fetch each feed individually (first load or digest unavailable)
      const renderIntervalMs = 100;
      let lastRenderTime = 0;
      let renderTimeout: ReturnType<typeof setTimeout> | null = null;
      let pendingItems: NewsItem[] | null = null;

      const flushPendingRender = () => {
        if (!pendingItems) return;
        renderNewsForCategory(this.ctx, category, pendingItems);
        pendingItems = null;
        lastRenderTime = Date.now();
      };

      const scheduleRender = (partialItems: NewsItem[]) => {
        if (!panel) return;
        pendingItems = partialItems;
        const elapsed = Date.now() - lastRenderTime;
        if (elapsed >= renderIntervalMs) {
          if (renderTimeout) {
            clearTimeout(renderTimeout);
            renderTimeout = null;
          }
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

      const staleItems = this.getStaleNewsItems(category).filter(i => enabledNames.has(i.source));
      if (staleItems.length > 0) {
        console.warn(`[News] Digest missing for "${category}", serving stale headlines (${staleItems.length})`);
        renderNewsForCategory(this.ctx, category, staleItems);
        this.ctx.statusPanel?.updateFeed(category.charAt(0).toUpperCase() + category.slice(1), {
          status: 'ok',
          itemCount: staleItems.length,
        });
        return staleItems;
      }

      if (!this.isPerFeedFallbackEnabled()) {
        console.warn(`[News] Digest missing for "${category}", limited per-feed fallback disabled`);
        renderNewsForCategory(this.ctx, category, []);
        this.ctx.statusPanel?.updateFeed(category.charAt(0).toUpperCase() + category.slice(1), {
          status: 'error',
          errorMessage: 'Digest unavailable',
        });
        return [];
      }

      const fallbackFeeds = this.selectLimitedFeeds(enabledFeeds, this.perFeedFallbackCategoryFeedLimit);
      if (fallbackFeeds.length < enabledFeeds.length) {
        console.warn(`[News] Digest missing for "${category}", using limited per-feed fallback (${fallbackFeeds.length}/${enabledFeeds.length} feeds)`);
      } else {
        console.warn(`[News] Digest missing for "${category}", using per-feed fallback (${fallbackFeeds.length} feeds)`);
      }

      const items = await fetchCategoryFeeds(fallbackFeeds, {
        batchSize: this.perFeedFallbackBatchSize,
        onBatch: (partialItems) => {
          scheduleRender(partialItems);
          flashMapForNews(this.ctx, partialItems);
          checkBatchForBreakingAlerts(partialItems);
        },
      });

      renderNewsForCategory(this.ctx, category, items);
      if (panel) {
        if (renderTimeout) {
          clearTimeout(renderTimeout);
          renderTimeout = null;
          pendingItems = null;
        }

        if (items.length === 0) {
          const failures = getFeedFailures();
          const failedFeeds = fallbackFeeds.filter(f => failures.has(f.name));
          if (failedFeeds.length > 0) {
            const names = failedFeeds.map(f => f.name).join(', ');
            panel.showError(`${t('common.noNewsAvailable')} (${names} failed)`);
          }
        }

        try {
          const baseline = await updateBaseline(`news:${category}`, items.length);
          const deviation = calculateDeviation(items.length, baseline);
          panel.setDeviation(deviation.zScore, deviation.percentChange, deviation.level);
        } catch (e) { console.warn(`[Baseline] news:${category} write failed:`, e); }
      }

      this.ctx.statusPanel?.updateFeed(category.charAt(0).toUpperCase() + category.slice(1), {
        status: 'ok',
        itemCount: items.length,
      });
      this.ctx.statusPanel?.updateApi('RSS2JSON', { status: 'ok' });

      return items;
    } catch (error) {
      this.ctx.statusPanel?.updateFeed(category.charAt(0).toUpperCase() + category.slice(1), {
        status: 'error',
        errorMessage: String(error),
      });
      this.ctx.statusPanel?.updateApi('RSS2JSON', { status: 'error' });
      delete this.ctx.newsByCategory[category];
      return [];
    }
  }

  async loadNews(): Promise<void> {
    // Reset happy variant accumulator for fresh pipeline run
    if (SITE_VARIANT === 'happy') {
      this.ctx.happyAllItems = [];
    }

    // Fire digest fetch early (non-blocking) — await before category loop
    const digestPromise = tryFetchDigest();

    // Wait for news sources to be loaded — but never more than 3s.
    // App.init() fires loadNewsSources() and flags in parallel without awaiting them,
    // so on a warm bootstrap cache this resolves in ~0ms (IndexedDB fast-path).
    // On cold cache, we wait up to 3s then proceed with whatever is available
    // (stale digest path handles empty feeds gracefully).
    const SOURCES_WAIT_MS = 3000;
    await Promise.race([
      this.sourcesReady,
      new Promise<void>((resolve) => setTimeout(resolve, SOURCES_WAIT_MS)),
    ]);

    const feedsMap = getFeeds();
    const categories = Object.entries(feedsMap)
      .filter((entry): entry is [string, import('@/types').Feed[]] => Array.isArray(entry[1]) && entry[1].length > 0)
      .map(([key, feeds]) => ({ key, feeds }));

    const digest = await digestPromise;

    if (digest) {
      this.domainHandlers['news:full']?.(digest);
      return;
    }

    // Per-feed fallback when digest unavailable
    const maxCategoryConcurrency = SITE_VARIANT === 'tech' ? 4 : 5;
    const categoryConcurrency = Math.max(1, Math.min(maxCategoryConcurrency, categories.length));
    const categoryResults: PromiseSettledResult<NewsItem[]>[] = [];
    for (let i = 0; i < categories.length; i += categoryConcurrency) {
      const chunk = categories.slice(i, i + categoryConcurrency);
      const chunkResults = await Promise.allSettled(
        chunk.map(({ key, feeds }) => this.loadNewsCategory(key, feeds))
      );
      categoryResults.push(...chunkResults);
    }

    const collectedNews: NewsItem[] = [];
    categoryResults.forEach((result, idx) => {
      if (result.status === 'fulfilled') {
        const items = result.value;
        if (SITE_VARIANT === 'happy') {
          for (const item of items) {
            item.happyCategory = classifyNewsItem(item.source, item.title);
          }
          this.ctx.happyAllItems = this.ctx.happyAllItems.concat(items);
        }
        collectedNews.push(...items);
      } else {
        console.error(`[App] News category ${categories[idx]?.key} failed:`, result.reason);
      }
    });

    if (SITE_VARIANT === 'full') {
      const enabledIntelSources = getIntelSources().filter(f => !this.ctx.disabledSources.has(f.name));
      const enabledIntelNames = new Set(enabledIntelSources.map(f => f.name));
      const intelPanel = this.ctx.newsPanels['intel'];
      if (enabledIntelSources.length === 0) {
        delete this.ctx.newsByCategory['intel'];
        if (intelPanel) intelPanel.showError(t('common.allIntelSourcesDisabled'));
        this.ctx.statusPanel?.updateFeed('Intel', { status: 'ok', itemCount: 0 });
      } else {
        const staleIntel = this.getStaleNewsItems('intel').filter(i => enabledIntelNames.has(i.source));
        if (staleIntel.length > 0) {
          console.warn(`[News] Intel digest missing, serving stale headlines (${staleIntel.length})`);
          renderNewsForCategory(this.ctx, 'intel', staleIntel);
          if (intelPanel) {
            try {
              const baseline = await updateBaseline('news:intel', staleIntel.length);
              const deviation = calculateDeviation(staleIntel.length, baseline);
              intelPanel.setDeviation(deviation.zScore, deviation.percentChange, deviation.level);
            } catch (e) { console.warn('[Baseline] news:intel write failed:', e); }
          }
          this.ctx.statusPanel?.updateFeed('Intel', { status: 'ok', itemCount: staleIntel.length });
          collectedNews.push(...staleIntel);
        } else if (!this.isPerFeedFallbackEnabled()) {
          console.warn('[News] Intel digest missing, limited per-feed fallback disabled');
          delete this.ctx.newsByCategory['intel'];
          this.ctx.statusPanel?.updateFeed('Intel', { status: 'error', errorMessage: 'Digest unavailable' });
        } else {
          const fallbackIntelFeeds = this.selectLimitedFeeds(enabledIntelSources, this.perFeedFallbackIntelFeedLimit);
          if (fallbackIntelFeeds.length < enabledIntelSources.length) {
            console.warn(`[News] Intel digest missing, using limited per-feed fallback (${fallbackIntelFeeds.length}/${enabledIntelSources.length} feeds)`);
          }

          const intelResult = await Promise.allSettled([
            fetchCategoryFeeds(fallbackIntelFeeds, { batchSize: this.perFeedFallbackBatchSize }),
          ]);
          if (intelResult[0]?.status === 'fulfilled') {
            const intel = intelResult[0].value;
            checkBatchForBreakingAlerts(intel);
            renderNewsForCategory(this.ctx, 'intel', intel);
            if (intelPanel) {
              try {
                const baseline = await updateBaseline('news:intel', intel.length);
                const deviation = calculateDeviation(intel.length, baseline);
                intelPanel.setDeviation(deviation.zScore, deviation.percentChange, deviation.level);
              } catch (e) { console.warn('[Baseline] news:intel write failed:', e); }
            }
            this.ctx.statusPanel?.updateFeed('Intel', { status: 'ok', itemCount: intel.length });
            collectedNews.push(...intel);
            flashMapForNews(this.ctx, intel);
          } else {
            delete this.ctx.newsByCategory['intel'];
            console.error('[App] Intel feed failed:', intelResult[0]?.reason);
          }
        }
      }
    }

    this.ctx.allNews = collectedNews;
    this.ctx.initialLoadComplete = true;
    updateAndCheck([
      { type: 'news', region: 'global', count: collectedNews.length },
    ]).then(anomalies => {
      if (anomalies.length > 0) {
        signalAggregator.ingestTemporalAnomalies(anomalies);
        ingestTemporalAnomaliesForCII(anomalies);
        (this.ctx.panels['cii'] as CIIPanel)?.refresh();
      }
    }).catch(() => { });

    this.ctx.map?.updateHotspotActivity(this.ctx.allNews);

    this.updateMonitorResults();
    this.updateHeadlinesPanel();

    void (mlWorker.isAvailable
      ? clusterNewsHybrid(this.ctx.allNews)
      : analysisWorker.clusterNews(this.ctx.allNews)
    ).then(clusters => {
      if (this.ctx.isDestroyed) return;
      this.ctx.latestClusters = clusters;

      if (clusters.length > 0) {
        const insightsPanel = this.ctx.panels['insights'] as InsightsPanel | undefined;
        insightsPanel?.updateInsights(clusters);
      }

      const geoLocated = clusters
        .filter((c): c is typeof c & { lat: number; lon: number } => c.lat != null && c.lon != null)
        .map(c => ({
          lat: c.lat,
          lon: c.lon,
          title: c.primaryTitle,
          threatLevel: c.threat?.level ?? 'info',
          timestamp: c.lastUpdated,
        }));
      if (geoLocated.length > 0) {
        this.ctx.map?.setNewsLocations(geoLocated);
      }
    }).catch(error => {
      console.error('[App] Clustering failed, clusters unchanged:', error);
    });

    if (SITE_VARIANT === 'happy') {
      await this.loadHappySupplementaryAndRender();
      await Promise.allSettled([
        this.ctx.mapLayers.positiveEvents ? this.loadPositiveEvents() : Promise.resolve(),
        this.ctx.mapLayers.kindness ? Promise.resolve(this.loadKindnessData()) : Promise.resolve(),
      ]);
    }
  }

  async loadMarkets(): Promise<void> {
    const commoditiesPanel = this.ctx.panels['commodities'] as CommoditiesPanel;

    const hydratedCommodities = getHydratedData('commodities') as { quotes: Array<{ display?: string; symbol: string; price?: number; change?: number; sparkline?: number[] }> } | undefined;
    if (hydratedCommodities?.quotes?.length) {
      const mapped = hydratedCommodities.quotes.map((q) => ({
        display: q.display || q.symbol,
        price: q.price != null ? q.price : null,
        change: q.change ?? null,
        sparkline: (q.sparkline?.length ?? 0) > 0 ? q.sparkline : undefined,
      }));
      if (mapped.some((d) => d.price !== null)) {
        commoditiesPanel.renderCommodities(mapped);
      }
    }

    try {
      const dashboard = await fetchMarketDashboard();
      this.domainHandlers['markets']?.(dashboard);

      const hydratedSectors = getHydratedData('sectors') as GetSectorSummaryResponse | undefined;
      if (hydratedSectors?.sectors?.length) {
        (this.ctx.panels['heatmap'] as HeatmapPanel).renderHeatmap(
          hydratedSectors.sectors.map((s: SectorPerformance) => ({ name: s.name, change: s.change })),
        );
      }
    } catch {
      this.ctx.statusPanel?.updateApi('Finnhub', { status: 'error' });
      this.ctx.statusPanel?.updateApi('CoinGecko', { status: 'error' });
      if (this.lastCommodityData.length > 0) {
        commoditiesPanel.renderCommodities(this.lastCommodityData, true);
      }
    }
  }

  async loadNatural(): Promise<void> {
    const hasCachedNatural = (this.ctx.intelligenceCache.eonetEvents?.length ?? 0) > 0 || (this.ctx.intelligenceCache.gdacsEvents?.length ?? 0) > 0;
    const hasCachedEarthquakes = (this.ctx.intelligenceCache.earthquakes?.length ?? 0) > 0;

    if (hasCachedNatural) {
      mergeAndRenderNaturalEvents(this.ctx);
    }
    if (hasCachedEarthquakes && this.ctx.intelligenceCache.earthquakes) {
      this.ctx.map?.setEarthquakes(this.ctx.intelligenceCache.earthquakes);
      this.ctx.statusPanel?.updateApi('USGS', { status: 'ok' });
    }
    if (hasCachedNatural || hasCachedEarthquakes) {
      const mergedCount = (this.ctx.intelligenceCache.eonetEvents?.length ?? 0) + (this.ctx.intelligenceCache.gdacsEvents?.length ?? 0);
      this.ctx.map?.setLayerReady('natural', mergedCount > 0 || hasCachedEarthquakes);
      if (hasCachedNatural && hasCachedEarthquakes) return;
    }

    const [earthquakeResult, eonetLoaded, gdacsLoaded] = await Promise.all([
      fetchEarthquakes().then((v) => ({ status: 'fulfilled' as const, value: v })).catch((e) => ({ status: 'rejected' as const, reason: e })),
      this.loadChannelWithFallback('eonet', (data) => this.domainHandlers['eonet']?.(data)),
      this.loadChannelWithFallback('gdacs', (data) => this.domainHandlers['gdacs']?.(data)),
    ]);

    if (earthquakeResult.status === 'fulfilled') {
      this.ctx.intelligenceCache.earthquakes = earthquakeResult.value;
      this.ctx.map?.setEarthquakes(earthquakeResult.value);
      ingestEarthquakes(earthquakeResult.value);
      this.ctx.statusPanel?.updateApi('USGS', { status: 'ok' });
      dataFreshness.recordUpdate('usgs', earthquakeResult.value.length);
    } else {
      if (!hasCachedEarthquakes) {
        this.ctx.intelligenceCache.earthquakes = [];
        this.ctx.map?.setEarthquakes([]);
        this.ctx.statusPanel?.updateApi('USGS', { status: 'error' });
        dataFreshness.recordError('usgs', String(earthquakeResult.reason));
      }
    }

    if (!eonetLoaded && !gdacsLoaded && !hasCachedNatural) {
      this.ctx.map?.setNaturalEvents([]);
      this.ctx.statusPanel?.updateFeed('EONET', { status: 'error', errorMessage: 'No data from relay' });
      this.ctx.statusPanel?.updateApi('NASA EONET', { status: 'error' });
    }

    const hasEarthquakes = earthquakeResult.status === 'fulfilled' && earthquakeResult.value.length > 0;
    const hasEonet = eonetLoaded || gdacsLoaded || hasCachedNatural;
    this.ctx.map?.setLayerReady('natural', hasEarthquakes || hasEonet);
  }

  async loadTechEvents(): Promise<void> {
    if (SITE_VARIANT !== 'tech' && !this.ctx.mapLayers.techEvents) return;

    const loaded = await this.loadChannelWithFallback('tech-events', (data) => this.domainHandlers['tech-events']?.(data));
    if (loaded) return;
    try {
      const data = await fetchTechEvents('conference', true, 90, 50);
      if (!data.success) throw new Error(data.error || 'Unknown error');
      this.domainHandlers['tech-events']?.(data);
    } catch (error) {
      console.error('[App] Failed to load tech events:', error);
      this.ctx.map?.setTechEvents([]);
      this.ctx.map?.setLayerReady('techEvents', false);
      this.ctx.statusPanel?.updateFeed('Tech Events', { status: 'error', errorMessage: String(error) });
    }
  }

  async loadWeatherAlerts(): Promise<void> {
    if (this.ctx.intelligenceCache.weatherAlerts) {
      this.domainHandlers['weather']?.(this.ctx.intelligenceCache.weatherAlerts);
      return;
    }
    const loaded = await this.loadChannelWithFallback('weather', (data) => this.domainHandlers['weather']?.(data));
    if (!loaded) {
      this.ctx.map?.setLayerReady('weather', false);
      dataFreshness.recordError('weather', 'Relay data unavailable');
      this.ctx.statusPanel?.updateFeed('Weather', { status: 'error' });
    }
  }

  async loadIntelligenceSignals(): Promise<void> {
    const tasks: Promise<void>[] = [];

    tasks.push((async () => {
      try {
        const outages = await fetchInternetOutages();
        this.ctx.intelligenceCache.outages = outages;
        ingestOutagesForCII(outages);
        signalAggregator.ingestOutages(outages);
        dataFreshness.recordUpdate('outages', outages.length);
        if (this.ctx.mapLayers.outages) {
          this.ctx.map?.setOutages(outages);
          this.ctx.map?.setLayerReady('outages', outages.length > 0);
          this.ctx.statusPanel?.updateFeed('NetBlocks', { status: 'ok', itemCount: outages.length });
        }
      } catch (error) {
        console.error('[Intelligence] Outages fetch failed:', error);
        dataFreshness.recordError('outages', String(error));
      }
    })());

    const protestsTask = (async (): Promise<SocialUnrestEvent[]> => {
      try {
        await this.loadChannelWithFallback('conflict', (data) => this.domainHandlers['conflict']?.(data));
        return this.ctx.intelligenceCache.protests?.events || [];
      } catch {
        return [];
      }
    })();
    tasks.push(protestsTask.then(() => undefined));

    tasks.push((async () => {
      try {
        const classifications = await fetchUcdpClassifications();
        ingestUcdpForCII(classifications);
        if (classifications.size > 0) dataFreshness.recordUpdate('ucdp', classifications.size);
      } catch (error) {
        console.error('[Intelligence] UCDP fetch failed:', error);
        dataFreshness.recordError('ucdp', String(error));
      }
    })());

    tasks.push((async () => {
      try {
        const summaries = await fetchAllHapiSummaries();
        ingestHapiForCII(summaries);
        if (summaries.size > 0) dataFreshness.recordUpdate('hapi', summaries.size);
      } catch (error) {
        console.error('[Intelligence] HAPI fetch failed:', error);
        dataFreshness.recordError('hapi', String(error));
      }
    })());

    tasks.push((async () => {
      try {
        if (isMilitaryVesselTrackingConfigured() && this.ctx.mapLayers.ais) {
          initMilitaryVesselStream();
        }
        const [flightData, vesselData] = await Promise.all([
          fetchMilitaryFlights(),
          fetchMilitaryVessels(),
        ]);
        this.ctx.intelligenceCache.military = {
          flights: flightData.flights,
          flightClusters: flightData.clusters,
          vessels: vesselData.vessels,
          vesselClusters: vesselData.clusters,
        };
        fetchUSNIFleetReport().then((report) => {
          if (report) this.ctx.intelligenceCache.usniFleet = report;
        }).catch(() => {});
        ingestFlights(flightData.flights);
        ingestVessels(vesselData.vessels);
        ingestMilitaryForCII(flightData.flights, vesselData.vessels);
        signalAggregator.ingestFlights(flightData.flights);
        signalAggregator.ingestVessels(vesselData.vessels);
        dataFreshness.recordUpdate('opensky', flightData.flights.length);
        updateAndCheck([
          { type: 'military_flights', region: 'global', count: flightData.flights.length },
          { type: 'vessels', region: 'global', count: vesselData.vessels.length },
        ]).then(anomalies => {
          if (anomalies.length > 0) {
            signalAggregator.ingestTemporalAnomalies(anomalies);
            ingestTemporalAnomaliesForCII(anomalies);
            (this.ctx.panels['cii'] as CIIPanel)?.refresh();
          }
        }).catch(() => { });
        if (this.ctx.mapLayers.military) {
          this.ctx.map?.setMilitaryFlights(flightData.flights, flightData.clusters);
          this.ctx.map?.setMilitaryVessels(vesselData.vessels, vesselData.clusters);
          this.ctx.map?.updateMilitaryForEscalation(flightData.flights, vesselData.vessels);
          const militaryCount = flightData.flights.length + vesselData.vessels.length;
          this.ctx.statusPanel?.updateFeed('Military', {
            status: militaryCount > 0 ? 'ok' : 'warning',
            itemCount: militaryCount,
          });
        }
        if (!isInLearningMode()) {
          const surgeAlerts = analyzeFlightsForSurge(flightData.flights);
          if (surgeAlerts.length > 0) {
            const surgeSignals = surgeAlerts.map(surgeAlertToSignal);
            addToSignalHistory(surgeSignals);
            if (this.shouldShowIntelligenceNotifications()) this.ctx.signalModal?.show(surgeSignals);
          }
          const foreignAlerts = detectForeignMilitaryPresence(flightData.flights);
          if (foreignAlerts.length > 0) {
            const foreignSignals = foreignAlerts.map(foreignPresenceToSignal);
            addToSignalHistory(foreignSignals);
            if (this.shouldShowIntelligenceNotifications()) this.ctx.signalModal?.show(foreignSignals);
          }
        }
      } catch (error) {
        console.error('[Intelligence] Military fetch failed:', error);
        dataFreshness.recordError('opensky', String(error));
      }
    })());

    tasks.push((async () => {
      try {
        const protestEvents = await protestsTask;
        let result = await fetchUcdpEvents();
        for (let attempt = 1; attempt < 3 && !result.success; attempt++) {
          await new Promise(r => setTimeout(r, 15_000));
          result = await fetchUcdpEvents();
        }
        if (!result.success) {
          dataFreshness.recordError('ucdp_events', 'UCDP events unavailable (retaining prior event state)');
          return;
        }
        const acledEvents = protestEvents.map(e => ({
          latitude: e.lat, longitude: e.lon, event_date: e.time.toISOString(), fatalities: e.fatalities ?? 0,
        }));
        const events = deduplicateAgainstAcled(result.data, acledEvents);
        (this.ctx.panels['ucdp-events'] as UcdpEventsPanel)?.setEvents(events);
        if (this.ctx.mapLayers.ucdpEvents) {
          this.ctx.map?.setUcdpEvents(events);
        }
        if (events.length > 0) dataFreshness.recordUpdate('ucdp_events', events.length);
      } catch (error) {
        console.error('[Intelligence] UCDP events fetch failed:', error);
        dataFreshness.recordError('ucdp_events', String(error));
      }
    })());

    tasks.push((async () => {
      try {
        const unhcrResult = await fetchUnhcrPopulation();
        if (!unhcrResult.ok) {
          dataFreshness.recordError('unhcr', 'UNHCR displacement unavailable (retaining prior displacement state)');
          return;
        }
        const data = unhcrResult.data;
        (this.ctx.panels['displacement'] as DisplacementPanel)?.setData(data);
        ingestDisplacementForCII(data.countries);
        if (this.ctx.mapLayers.displacement && data.topFlows) {
          this.ctx.map?.setDisplacementFlows(data.topFlows);
        }
        if (data.countries.length > 0) dataFreshness.recordUpdate('unhcr', data.countries.length);
      } catch (error) {
        console.error('[Intelligence] UNHCR displacement fetch failed:', error);
        dataFreshness.recordError('unhcr', String(error));
      }
    })());

    tasks.push((async () => {
      try {
        const climateResult = await fetchClimateAnomalies();
        if (!climateResult.ok) {
          dataFreshness.recordError('climate', 'Climate anomalies unavailable (retaining prior climate state)');
          return;
        }
        const anomalies = climateResult.anomalies;
        (this.ctx.panels['climate'] as ClimateAnomalyPanel)?.setAnomalies(anomalies);
        ingestClimateForCII(anomalies);
        if (this.ctx.mapLayers.climate) {
          this.ctx.map?.setClimateAnomalies(anomalies);
        }
        if (anomalies.length > 0) dataFreshness.recordUpdate('climate', anomalies.length);
      } catch (error) {
        console.error('[Intelligence] Climate anomalies fetch failed:', error);
        dataFreshness.recordError('climate', String(error));
      }
    })());

    // Security advisories
    tasks.push(this.loadSecurityAdvisories());

    // Telegram Intel
    tasks.push(this.loadTelegramIntel());

    // OREF sirens — WebSocket push via relay (applyOref); initial load from hydration or fetch
    tasks.push((async () => {
      try {
        await this.loadChannelWithFallback<OrefAlertsResponse>('oref', (data) => this.domainHandlers['oref']?.(data));
      } catch (error) {
        console.error('[Intelligence] OREF alerts fetch failed:', error);
      }
    })());

    // GPS/GNSS jamming
    tasks.push((async () => {
      try {
        const data = await fetchGpsInterference();
        if (!data) {
          ingestGpsJammingForCII([]);
          this.ctx.map?.setLayerReady('gpsJamming', false);
          return;
        }
        ingestGpsJammingForCII(data.hexes);
        if (this.ctx.mapLayers.gpsJamming) {
          this.ctx.map?.setGpsJamming(data.hexes);
          this.ctx.map?.setLayerReady('gpsJamming', data.hexes.length > 0);
        }
        this.ctx.statusPanel?.updateFeed('GPS Jam', { status: 'ok', itemCount: data.hexes.length });
        dataFreshness.recordUpdate('gpsjam', data.hexes.length);
      } catch (error) {
        this.ctx.map?.setLayerReady('gpsJamming', false);
        this.ctx.statusPanel?.updateFeed('GPS Jam', { status: 'error' });
        dataFreshness.recordError('gpsjam', String(error));
      }
    })());

    await Promise.allSettled(tasks);

    try {
      const ucdpEvts = (this.ctx.panels['ucdp-events'] as UcdpEventsPanel)?.getEvents?.() || [];
      const events = [
        ...(this.ctx.intelligenceCache.protests?.events || []).slice(0, 10).map(e => ({
          id: e.id, lat: e.lat, lon: e.lon, type: 'conflict' as const, name: e.title || 'Protest',
        })),
        ...ucdpEvts.slice(0, 10).map(e => ({
          id: e.id, lat: e.latitude, lon: e.longitude, type: e.type_of_violence as string, name: `${e.side_a} vs ${e.side_b}`,
        })),
      ];
      if (events.length > 0) {
        const exposures = await enrichEventsWithExposure(events);
        (this.ctx.panels['population-exposure'] as PopulationExposurePanel)?.setExposures(exposures);
        if (exposures.length > 0) dataFreshness.recordUpdate('worldpop', exposures.length);
      } else {
        (this.ctx.panels['population-exposure'] as PopulationExposurePanel)?.setExposures([]);
      }
    } catch (error) {
      console.error('[Intelligence] Population exposure fetch failed:', error);
      dataFreshness.recordError('worldpop', String(error));
    }

    (this.ctx.panels['cii'] as CIIPanel)?.refresh();
  }

  async loadOutages(): Promise<void> {
    if (this.ctx.intelligenceCache.outages) {
      const outages = this.ctx.intelligenceCache.outages;
      this.ctx.map?.setOutages(outages);
      this.ctx.map?.setLayerReady('outages', outages.length > 0);
      this.ctx.statusPanel?.updateFeed('NetBlocks', { status: 'ok', itemCount: outages.length });
      return;
    }
    try {
      const outages = await fetchInternetOutages();
      this.ctx.intelligenceCache.outages = outages;
      this.ctx.map?.setOutages(outages);
      this.ctx.map?.setLayerReady('outages', outages.length > 0);
      ingestOutagesForCII(outages);
      signalAggregator.ingestOutages(outages);
      this.ctx.statusPanel?.updateFeed('NetBlocks', { status: 'ok', itemCount: outages.length });
      dataFreshness.recordUpdate('outages', outages.length);
    } catch (error) {
      this.ctx.map?.setLayerReady('outages', false);
      this.ctx.statusPanel?.updateFeed('NetBlocks', { status: 'error' });
      dataFreshness.recordError('outages', String(error));
    }
  }

  async loadCyberThreats(): Promise<void> {
    if (!CYBER_LAYER_ENABLED) {
      this.ctx.mapLayers.cyberThreats = false;
      this.ctx.map?.setLayerReady('cyberThreats', false);
      return;
    }

    if (this.ctx.cyberThreatsCache) {
      this.domainHandlers['cyber']?.({ threats: this.ctx.cyberThreatsCache });
      return;
    }

    const loaded = await this.loadChannelWithFallback('cyber', (data) => this.domainHandlers['cyber']?.(data));
    if (!loaded) {
      const threats = fetchCyberThreats();
      if (threats.length > 0) {
        this.domainHandlers['cyber']?.({ threats });
      } else {
        this.ctx.map?.setLayerReady('cyberThreats', false);
      }
    }
  }

  async loadIranEvents(): Promise<void> {
    if (this.ctx.intelligenceCache.iranEvents) {
      this.domainHandlers['iran-events']?.({ events: this.ctx.intelligenceCache.iranEvents });
      return;
    }
    const loaded = await this.loadChannelWithFallback('iran-events', (data) => this.domainHandlers['iran-events']?.(data));
    if (!loaded) {
      this.ctx.map?.setLayerReady('iranAttacks', false);
    }
  }

  async loadAisSignals(): Promise<void> {
    const loaded = await this.loadChannelWithFallback('ais', (data) => this.domainHandlers['ais']?.(data));
    if (!loaded) {
      this.ctx.map?.setLayerReady('ais', false);
      this.ctx.statusPanel?.updateFeed('Shipping', { status: 'error', errorMessage: 'No data from relay' });
      this.ctx.statusPanel?.updateApi('AISStream', { status: 'error' });
    }
  }

  waitForAisData(): void {
    const maxAttempts = 30;
    let attempts = 0;

    const checkData = () => {
      if (this.ctx.isDestroyed) return;
      attempts++;
      const status = getAisStatus();

      if (status.vessels > 0 || status.connected) {
        this.loadAisSignals();
        this.ctx.map?.setLayerLoading('ais', false);
        return;
      }

      if (attempts >= maxAttempts) {
        this.ctx.map?.setLayerLoading('ais', false);
        this.ctx.map?.setLayerReady('ais', false);
        this.ctx.statusPanel?.updateFeed('Shipping', {
          status: 'error',
          errorMessage: 'Connection timeout'
        });
        return;
      }

      setTimeout(checkData, 1000);
    };

    checkData();
  }

  async loadCableActivity(): Promise<void> {
    try {
      const activity = await fetchCableActivity();
      this.ctx.map?.setCableActivity(activity.advisories, activity.repairShips);
      const itemCount = activity.advisories.length + activity.repairShips.length;
      this.ctx.statusPanel?.updateFeed('CableOps', { status: 'ok', itemCount });
    } catch {
      this.ctx.statusPanel?.updateFeed('CableOps', { status: 'error' });
    }
  }

  async loadCableHealth(): Promise<void> {
    const loaded = await this.loadChannelWithFallback('cables', (data) => this.domainHandlers['cables']?.(data));
    if (!loaded) {
      this.ctx.map?.setLayerReady('cables', false);
    }
  }

  async loadProtests(): Promise<void> {
    if (this.ctx.intelligenceCache.protests) {
      const protestData = this.ctx.intelligenceCache.protests;
      this.ctx.map?.setProtests(protestData.events);
      this.ctx.map?.setLayerReady('protests', protestData.events.length > 0);
      const status = getProtestStatus();
      this.ctx.statusPanel?.updateFeed('Protests', {
        status: 'ok',
        itemCount: protestData.events.length,
        errorMessage: status.acledConfigured === false ? 'ACLED not configured - using GDELT only' : undefined,
      });
      if (status.acledConfigured === true) {
        this.ctx.statusPanel?.updateApi('ACLED', { status: 'ok' });
      } else if (status.acledConfigured === null) {
        this.ctx.statusPanel?.updateApi('ACLED', { status: 'warning' });
      }
      this.ctx.statusPanel?.updateApi('GDELT Doc', { status: 'ok' });
      if (protestData.sources.gdelt > 0) dataFreshness.recordUpdate('gdelt_doc', protestData.sources.gdelt);
      return;
    }
    const loaded = await this.loadChannelWithFallback('conflict', (data) => this.domainHandlers['conflict']?.(data));
    if (!loaded) {
      this.ctx.map?.setLayerReady('protests', false);
      this.ctx.statusPanel?.updateFeed('Protests', { status: 'error', errorMessage: 'No data from relay' });
      this.ctx.statusPanel?.updateApi('ACLED', { status: 'error' });
      this.ctx.statusPanel?.updateApi('GDELT Doc', { status: 'error' });
    }
  }

  async loadFlightDelays(): Promise<void> {
    if (this.ctx.intelligenceCache.flightDelays) {
      this.domainHandlers['flights']?.(this.ctx.intelligenceCache.flightDelays);
      return;
    }
    const loaded = await this.loadChannelWithFallback('flights', (data) => this.domainHandlers['flights']?.(data));
    if (!loaded) {
      this.ctx.map?.setLayerReady('flights', false);
      this.ctx.statusPanel?.updateFeed('Flights', { status: 'error', errorMessage: 'No data from relay' });
      this.ctx.statusPanel?.updateApi('FAA', { status: 'error' });
    }
  }

  async loadMilitary(): Promise<void> {
    if (this.ctx.intelligenceCache.military) {
      const { flights, flightClusters, vessels, vesselClusters } = this.ctx.intelligenceCache.military;
      this.ctx.map?.setMilitaryFlights(flights, flightClusters);
      this.ctx.map?.setMilitaryVessels(vessels, vesselClusters);
      this.ctx.map?.updateMilitaryForEscalation(flights, vessels);
      this.loadCachedPosturesForBanner();
      const insightsPanel = this.ctx.panels['insights'] as InsightsPanel | undefined;
      insightsPanel?.setMilitaryFlights(flights);
      const hasData = flights.length > 0 || vessels.length > 0;
      this.ctx.map?.setLayerReady('military', hasData);
      const militaryCount = flights.length + vessels.length;
      this.ctx.statusPanel?.updateFeed('Military', {
        status: militaryCount > 0 ? 'ok' : 'warning',
        itemCount: militaryCount,
        errorMessage: militaryCount === 0 ? 'No military activity in view' : undefined,
      });
      this.ctx.statusPanel?.updateApi('OpenSky', { status: 'ok' });
      return;
    }
    try {
      if (isMilitaryVesselTrackingConfigured() && this.ctx.mapLayers.ais) {
        initMilitaryVesselStream();
      }
      const [flightData, vesselData] = await Promise.all([
        fetchMilitaryFlights(),
        fetchMilitaryVessels(),
      ]);
      this.ctx.intelligenceCache.military = {
        flights: flightData.flights,
        flightClusters: flightData.clusters,
        vessels: vesselData.vessels,
        vesselClusters: vesselData.clusters,
      };
      fetchUSNIFleetReport().then((report) => {
        if (report) this.ctx.intelligenceCache.usniFleet = report;
      }).catch(() => {});
      this.ctx.map?.setMilitaryFlights(flightData.flights, flightData.clusters);
      this.ctx.map?.setMilitaryVessels(vesselData.vessels, vesselData.clusters);
      ingestFlights(flightData.flights);
      ingestVessels(vesselData.vessels);
      ingestMilitaryForCII(flightData.flights, vesselData.vessels);
      signalAggregator.ingestFlights(flightData.flights);
      signalAggregator.ingestVessels(vesselData.vessels);
      updateAndCheck([
        { type: 'military_flights', region: 'global', count: flightData.flights.length },
        { type: 'vessels', region: 'global', count: vesselData.vessels.length },
      ]).then(anomalies => {
        if (anomalies.length > 0) {
          signalAggregator.ingestTemporalAnomalies(anomalies);
          ingestTemporalAnomaliesForCII(anomalies);
          (this.ctx.panels['cii'] as CIIPanel)?.refresh();
        }
      }).catch(() => { });
      this.ctx.map?.updateMilitaryForEscalation(flightData.flights, vesselData.vessels);
      (this.ctx.panels['cii'] as CIIPanel)?.refresh();
      if (!isInLearningMode()) {
        const surgeAlerts = analyzeFlightsForSurge(flightData.flights);
        if (surgeAlerts.length > 0) {
          const surgeSignals = surgeAlerts.map(surgeAlertToSignal);
          addToSignalHistory(surgeSignals);
          if (this.shouldShowIntelligenceNotifications()) this.ctx.signalModal?.show(surgeSignals);
        }
        const foreignAlerts = detectForeignMilitaryPresence(flightData.flights);
        if (foreignAlerts.length > 0) {
          const foreignSignals = foreignAlerts.map(foreignPresenceToSignal);
          addToSignalHistory(foreignSignals);
          if (this.shouldShowIntelligenceNotifications()) this.ctx.signalModal?.show(foreignSignals);
        }
      }

      this.loadCachedPosturesForBanner();
      const insightsPanel = this.ctx.panels['insights'] as InsightsPanel | undefined;
      insightsPanel?.setMilitaryFlights(flightData.flights);

      const hasData = flightData.flights.length > 0 || vesselData.vessels.length > 0;
      this.ctx.map?.setLayerReady('military', hasData);
      const militaryCount = flightData.flights.length + vesselData.vessels.length;
      this.ctx.statusPanel?.updateFeed('Military', {
        status: militaryCount > 0 ? 'ok' : 'warning',
        itemCount: militaryCount,
        errorMessage: militaryCount === 0 ? 'No military activity in view' : undefined,
      });
      this.ctx.statusPanel?.updateApi('OpenSky', { status: 'ok' });
      dataFreshness.recordUpdate('opensky', flightData.flights.length);
    } catch (error) {
      this.ctx.map?.setLayerReady('military', false);
      this.ctx.statusPanel?.updateFeed('Military', { status: 'error', errorMessage: String(error) });
      this.ctx.statusPanel?.updateApi('OpenSky', { status: 'error' });
      dataFreshness.recordError('opensky', String(error));
    }
  }

  private async loadCachedPosturesForBanner(): Promise<void> {
    try {
      const data = await fetchCachedTheaterPosture();
      if (data && data.postures.length > 0) {
        this.callbacks.renderCriticalBanner(data.postures);
        const posturePanel = this.ctx.panels['strategic-posture'] as StrategicPosturePanel | undefined;
        posturePanel?.updatePostures(data);
      }
    } catch (error) {
      console.warn('[App] Failed to load cached postures for banner:', error);
    }
  }

  updateMonitorResults(): void {
    const monitorPanel = this.ctx.panels['monitors'] as MonitorPanel;
    monitorPanel.renderResults(this.ctx.allNews);
  }

  private updateHeadlinesPanel(): void {
    const panel = this.ctx.panels['headlines'];
    if (panel && 'renderItems' in panel) {
      (panel as HeadlinesPanel).renderItems(this.ctx.allNews);
    }
  }

  async runCorrelationAnalysis(): Promise<void> {
    try {
      if (this.ctx.latestClusters.length === 0 && this.ctx.allNews.length > 0) {
        this.ctx.latestClusters = mlWorker.isAvailable
          ? await clusterNewsHybrid(this.ctx.allNews)
          : await analysisWorker.clusterNews(this.ctx.allNews);
      }

      if (this.ctx.latestClusters.length > 0) {
        ingestNewsForCII(this.ctx.latestClusters);
        dataFreshness.recordUpdate('gdelt', this.ctx.latestClusters.length);
        (this.ctx.panels['cii'] as CIIPanel)?.refresh();
      }

      const signals = await analysisWorker.analyzeCorrelations(
        this.ctx.latestClusters,
        this.ctx.latestPredictions,
        this.ctx.latestMarkets
      );

      let geoSignals: ReturnType<typeof geoConvergenceToSignal>[] = [];
      if (!isInLearningMode()) {
        const geoAlerts = detectGeoConvergence(this.ctx.seenGeoAlerts);
        geoSignals = geoAlerts.map(geoConvergenceToSignal);
      }

      const keywordSpikeSignals = drainTrendingSignals();
      const allSignals = [...signals, ...geoSignals, ...keywordSpikeSignals];
      if (allSignals.length > 0) {
        addToSignalHistory(allSignals);
        if (this.shouldShowIntelligenceNotifications()) this.ctx.signalModal?.show(allSignals);
      }
    } catch (error) {
      console.error('[App] Correlation analysis failed:', error);
    }
  }

  async loadFirmsData(): Promise<void> {
    if (this.firesCache && (this.firesCache.fireDetections?.length ?? 0) > 0) {
      this.domainHandlers['natural']?.(this.firesCache);
      return;
    }
    const loaded = await this.loadChannelWithFallback('natural', (data) => this.domainHandlers['natural']?.(data));
    if (!loaded) {
      this.ctx.statusPanel?.updateApi('FIRMS', { status: 'error' });
    }
  }

  async loadGiving(): Promise<void> {
    try {
      const result = await fetchGivingSummary();
      if (result.ok && result.data) {
        this.domainHandlers['giving']?.(result.data);
      }
    } catch (error) {
      console.error('[App] Giving summary fetch failed:', error);
      dataFreshness.recordError('giving', String(error));
    }
  }

  syncDataFreshnessWithLayers(): void {
    for (const [layer, sourceIds] of Object.entries(LAYER_TO_SOURCE)) {
      const enabled = this.ctx.mapLayers[layer as keyof MapLayers] ?? false;
      for (const sourceId of sourceIds) {
        dataFreshness.setEnabled(sourceId as DataSourceId, enabled);
      }
    }

    if (!isAisConfigured()) {
      dataFreshness.setEnabled('ais', false);
    }
    if (isOutagesConfigured() === false) {
      dataFreshness.setEnabled('outages', false);
    }
  }

  private static readonly HAPPY_ITEMS_CACHE_KEY = 'happy-all-items';

  async hydrateHappyPanelsFromCache(): Promise<void> {
    try {
      type CachedItem = Omit<NewsItem, 'pubDate'> & { pubDate: number };
      const entry = await getPersistentCache<CachedItem[]>(DataLoaderManager.HAPPY_ITEMS_CACHE_KEY);
      if (!entry || !entry.data || entry.data.length === 0) return;
      if (Date.now() - entry.updatedAt > 24 * 60 * 60 * 1000) return;

      const items: NewsItem[] = entry.data.map(item => ({
        ...item,
        pubDate: new Date(item.pubDate),
      }));

      const scienceSources = ['GNN Science', 'ScienceDaily', 'Nature News', 'Live Science', 'New Scientist', 'Singularity Hub', 'Human Progress', 'Greater Good (Berkeley)'];
      this.ctx.breakthroughsPanel?.setItems(
        items.filter(item => scienceSources.includes(item.source) || item.happyCategory === 'science-health')
      );
      this.ctx.heroPanel?.setHeroStory(
        items.filter(item => item.happyCategory === 'humanity-kindness')
          .sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime())[0]
      );
      this.ctx.digestPanel?.setStories(
        [...items].sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime()).slice(0, 5)
      );
      this.ctx.positivePanel?.renderPositiveNews(items);
    } catch (err) {
      console.warn('[App] Happy panel cache hydration failed:', err);
    }
  }

  private async loadHappySupplementaryAndRender(): Promise<void> {
    if (!this.ctx.positivePanel) return;

    const curated = [...this.ctx.happyAllItems];
    this.ctx.positivePanel.renderPositiveNews(curated);

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
      const merged = [...curated, ...supplementary];
      merged.sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());
      this.ctx.positivePanel.renderPositiveNews(merged);
    }

    const scienceSources = ['GNN Science', 'ScienceDaily', 'Nature News', 'Live Science', 'New Scientist', 'Singularity Hub', 'Human Progress', 'Greater Good (Berkeley)'];
    const scienceItems = this.ctx.happyAllItems.filter(item =>
      scienceSources.includes(item.source) || item.happyCategory === 'science-health'
    );
    this.ctx.breakthroughsPanel?.setItems(scienceItems);

    const heroItem = this.ctx.happyAllItems
      .filter(item => item.happyCategory === 'humanity-kindness')
      .sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime())[0];
    this.ctx.heroPanel?.setHeroStory(heroItem);

    const digestItems = [...this.ctx.happyAllItems]
      .sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime())
      .slice(0, 5);
    this.ctx.digestPanel?.setStories(digestItems);

    setPersistentCache(
      DataLoaderManager.HAPPY_ITEMS_CACHE_KEY,
      this.ctx.happyAllItems.map(item => ({ ...item, pubDate: item.pubDate.getTime() }))
    ).catch(() => {});
  }

  private async loadPositiveEvents(): Promise<void> {
    const gdeltEvents = await fetchPositiveGeoEvents();
    const rssEvents = geocodePositiveNewsItems(
      this.ctx.happyAllItems.map(item => ({
        title: item.title,
        category: item.happyCategory,
      }))
    );
    const seen = new Set<string>();
    const merged = [...gdeltEvents, ...rssEvents].filter(e => {
      if (seen.has(e.name)) return false;
      seen.add(e.name);
      return true;
    });
    this.ctx.map?.setPositiveEvents(merged);
  }

  private loadKindnessData(): void {
    const kindnessItems = fetchKindnessData(
      this.ctx.happyAllItems.map(item => ({
        title: item.title,
        happyCategory: item.happyCategory,
      }))
    );
    this.ctx.map?.setKindnessData(kindnessItems);
  }

  async loadSecurityAdvisories(): Promise<void> {
    try {
      const result = await fetchSecurityAdvisories();
      if (result.ok) {
        (this.ctx.panels['security-advisories'] as SecurityAdvisoriesPanel)?.setData(result.advisories);
        this.ctx.intelligenceCache.advisories = result.advisories;
        ingestAdvisoriesForCII(result.advisories);
      }
    } catch (error) {
      console.error('[App] Security advisories fetch failed:', error);
    }
  }

  async loadTelegramIntel(): Promise<void> {
    try {
      const result = await fetchTelegramFeed();
      this.domainHandlers['telegram']?.(result);
    } catch (error) {
      console.error('[App] Telegram intel fetch failed:', error);
    }
  }

}
