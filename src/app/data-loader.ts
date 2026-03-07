import type { AppContext, AppModule } from '@/app/app-context';
import type { NewsItem, MapLayers, SocialUnrestEvent } from '@/types';
import type { TimeRange } from '@/components';
import {
  getFeeds,
  getIntelSources,
  SITE_VARIANT,
  LAYER_TO_SOURCE,
} from '@/config';
import { INTEL_HOTSPOTS, CONFLICT_ZONES } from '@/config/geo';
import { tokenizeForMatch, matchKeyword } from '@/utils/keyword-match';
import {
  fetchCategoryFeeds,
  getFeedFailures,
  fetchMarketDashboard,
  fetchPredictions,
  fetchEarthquakes,
  fetchFredDashboard,
  fetchInternetOutages,
  isOutagesConfigured,
  getAisStatus,
  isAisConfigured,
  fetchCableActivity,
  parseCableHealthPayload,
  setCableHealthCache,
  getProtestStatus,
  parseFlightDelaysPayload,
  fetchMilitaryFlights,
  fetchMilitaryVessels,
  initMilitaryVesselStream,
  isMilitaryVesselTrackingConfigured,
  fetchUSNIFleetReport,
  updateBaseline,
  calculateDeviation,
  addToSignalHistory,
  analysisWorker,
  fetchPizzIntStatus,
  fetchGdeltTensions,
  fetchOilAnalytics,
  fetchBisDashboard,
  type BisData,
  fetchCyberThreats,
  adaptCyberThreatsResponse,
  drainTrendingSignals,
  fetchTradeDashboard,
  fetchSupplyChainDashboard,
  fredResponseToClientSeries,
  energyPricesToOilAnalytics,
  parsePizzintResponse,
} from '@/services';
import { checkBatchForBreakingAlerts, dispatchOrefBreakingAlert } from '@/services/breaking-news-alerts';
import { mlWorker } from '@/services/ml-worker';
import { clusterNewsHybrid } from '@/services/clustering';
import { ingestProtests, ingestFlights, ingestVessels, ingestEarthquakes, detectGeoConvergence, geoConvergenceToSignal } from '@/services/geo-convergence';
import { signalAggregator } from '@/services/signal-aggregator';
import { updateAndCheck } from '@/services/temporal-baseline';
import { flattenFires, computeRegionStats, toMapFires } from '@/services/wildfires';
import { analyzeFlightsForSurge, surgeAlertToSignal, detectForeignMilitaryPresence, foreignPresenceToSignal, type TheaterPostureSummary } from '@/services/military-surge';
import { fetchCachedTheaterPosture } from '@/services/cached-theater-posture';
import { ingestProtestsForCII, ingestMilitaryForCII, ingestNewsForCII, ingestOutagesForCII, ingestConflictsForCII, ingestUcdpForCII, ingestHapiForCII, ingestDisplacementForCII, ingestClimateForCII, ingestStrikesForCII, ingestOrefForCII, ingestAviationForCII, ingestAdvisoriesForCII, ingestGpsJammingForCII, ingestAisDisruptionsForCII, ingestSatelliteFiresForCII, ingestCyberThreatsForCII, ingestTemporalAnomaliesForCII, isInLearningMode } from '@/services/country-instability';
import { fetchGpsInterference, parseGpsJamPayload } from '@/services/gps-interference';
import { dataFreshness, type DataSourceId } from '@/services/data-freshness';
import { fetchUcdpClassifications, fetchAllHapiSummaries, fetchUcdpEvents, deduplicateAgainstAcled, mapConflictPayload, mapUcdpPayload } from '@/services/conflict';
import { fetchUnhcrPopulation } from '@/services/displacement';
import { fetchClimateAnomalies, mapClimatePayload } from '@/services/climate';
import { fetchSecurityAdvisories } from '@/services/security-advisories';
import { fetchTelegramFeed } from '@/services/telegram-intel';
import { protoToGivingSummary, fetchGivingSummary } from '@/services/giving';
import { fetchOrefAlerts, startOrefPolling, stopOrefPolling, onOrefAlertsUpdate } from '@/services/oref-alerts';
import { enrichEventsWithExposure } from '@/services/population-exposure';
import { debounce, getCircuitBreakerCooldownInfo } from '@/utils';
import { isFeatureAvailable, isFeatureEnabled } from '@/services/runtime-config';
import { getAiFlowSettings } from '@/services/ai-flow-settings';
import { t } from '@/services/i18n';
import { getHydratedData } from '@/services/bootstrap';
import { fetchRelayPanel } from '@/services/relay-http';
import { canQueueAiClassification, AI_CLASSIFY_MAX_PER_FEED } from '@/services/ai-classify-queue';
import { classifyWithAI } from '@/services/threat-classifier';
import { ingestHeadlines } from '@/services/trending-keywords';
import type { ListFeedDigestResponse } from '@/generated/client/worldmonitor/news/v1/service_client';
import type { GetSectorSummaryResponse, GetMarketDashboardResponse } from '@/generated/client/worldmonitor/market/v1/service_client';
import type { GetBisPolicyRatesResponse, GetFredDashboardResponse, GetFredSeriesResponse, GetEnergyPricesResponse } from '@/generated/client/worldmonitor/economic/v1/service_client';
import type { GetGlobalIntelDigestResponse } from '@/generated/client/worldmonitor/intelligence/v1/service_client';
import type { GetTradeBarriersResponse, GetTradeDashboardResponse } from '@/generated/client/worldmonitor/trade/v1/service_client';
import type { GetChokepointStatusResponse, GetSupplyChainDashboardResponse } from '@/generated/client/worldmonitor/supply_chain/v1/service_client';
import type { ListFireDetectionsResponse } from '@/generated/client/worldmonitor/wildfire/v1/service_client';
import type { ListCyberThreatsResponse } from '@/generated/client/worldmonitor/cyber/v1/service_client';
import type { ListPredictionMarketsResponse } from '@/generated/client/worldmonitor/prediction/v1/service_client';
import type { GetGivingSummaryResponse } from '@/generated/client/worldmonitor/giving/v1/service_client';
import type { ListGulfQuotesResponse } from '@/generated/client/worldmonitor/market/v1/service_client';
import { fetchNewsDigest } from '@/services/news-digest';
import { fetchTechEvents } from '@/services/research';
import type { MarketPanel, HeatmapPanel, CommoditiesPanel, CryptoPanel } from '@/components/MarketPanel';
import type { PredictionPanel } from '@/components/PredictionPanel';
import type { MonitorPanel } from '@/components/MonitorPanel';
import type { HeadlinesPanel } from '@/components/HeadlinesPanel';
import type { InsightsPanel } from '@/components/InsightsPanel';
import type { CIIPanel } from '@/components/CIIPanel';
import type { StrategicPosturePanel } from '@/components/StrategicPosturePanel';
import type { EconomicPanel } from '@/components/EconomicPanel';
import type { UcdpEventsPanel } from '@/components/UcdpEventsPanel';
import type { DisplacementPanel } from '@/components/DisplacementPanel';
import type { ClimateAnomalyPanel } from '@/components/ClimateAnomalyPanel';
import type { PopulationExposurePanel } from '@/components/PopulationExposurePanel';
import type { TradePolicyPanel } from '@/components/TradePolicyPanel';
import type { SupplyChainPanel } from '@/components/SupplyChainPanel';
import type { SecurityAdvisoriesPanel } from '@/components/SecurityAdvisoriesPanel';
import type { OrefSirensPanel } from '@/components/OrefSirensPanel';
import type { TelegramIntelPanel } from '@/components/TelegramIntelPanel';
import type { GivingPanel } from '@/components/GivingPanel';
import type { GulfEconomiesPanel } from '@/components/GulfEconomiesPanel';
import type { GlobalDigestPanel } from '@/components/GlobalDigestPanel';
import type { TechEventsPanel } from '@/components/TechEventsPanel';
import type { SatelliteFiresPanel } from '@/components/SatelliteFiresPanel';
import { classifyNewsItem } from '@/services/positive-classifier';
import { filterBySentiment } from '@/services/sentiment-gate';
import { fetchAllPositiveTopicIntelligence } from '@/services/gdelt-intel';
import { fetchPositiveGeoEvents, geocodePositiveNewsItems } from '@/services/positive-events-geo';
import { fetchKindnessData } from '@/services/kindness-data';
import { getPersistentCache, setPersistentCache } from '@/services/persistent-cache';
import type { ThreatLevel as ClientThreatLevel } from '@/services/threat-classifier';
import type { NewsItem as ProtoNewsItem, ThreatLevel as ProtoThreatLevel } from '@/generated/client/worldmonitor/news/v1/service_client';

const PROTO_TO_CLIENT_LEVEL: Record<ProtoThreatLevel, ClientThreatLevel> = {
  THREAT_LEVEL_UNSPECIFIED: 'info',
  THREAT_LEVEL_LOW: 'low',
  THREAT_LEVEL_MEDIUM: 'medium',
  THREAT_LEVEL_HIGH: 'high',
  THREAT_LEVEL_CRITICAL: 'critical',
};

function protoItemToNewsItem(p: ProtoNewsItem): NewsItem {
  const level = PROTO_TO_CLIENT_LEVEL[p.threat?.level ?? 'THREAT_LEVEL_UNSPECIFIED'];
  return {
    source: p.source,
    title: p.title,
    link: p.link,
    pubDate: new Date(p.publishedAt),
    isAlert: p.isAlert,
    threat: p.threat ? {
      level,
      category: p.threat.category as import('@/services/threat-classifier').EventCategory,
      confidence: p.threat.confidence,
      source: (p.threat.source || 'keyword') as 'keyword' | 'ml' | 'llm',
    } : undefined,
    ...(p.locationName && { locationName: p.locationName }),
    ...(p.location && { lat: p.location.latitude, lon: p.location.longitude }),
  };
}

const CYBER_LAYER_ENABLED = import.meta.env.VITE_ENABLE_CYBER_LAYER === 'true';

export interface DataLoaderCallbacks {
  renderCriticalBanner: (postures: TheaterPostureSummary[]) => void;
}

export class DataLoaderManager implements AppModule {
  private ctx: AppContext;
  private callbacks: DataLoaderCallbacks;

  private sourcesReady: Promise<void> = Promise.resolve(); // default: already ready

  private mapFlashCache: Map<string, number> = new Map();
  private readonly MAP_FLASH_COOLDOWN_MS = 10 * 60 * 1000;
  private readonly applyTimeRangeFilterToNewsPanelsDebounced = debounce(() => {
    this.applyTimeRangeFilterToNewsPanels();
  }, 120);

  public updateSearchIndex: () => void = () => {};


  private readonly persistedDigestMaxAgeMs = 6 * 60 * 60 * 1000;
  private readonly perFeedFallbackCategoryFeedLimit = 3;
  private readonly perFeedFallbackIntelFeedLimit = 6;
  private readonly perFeedFallbackBatchSize = 2;
  private lastGoodDigest: ListFeedDigestResponse | null = null;
  private lastCommodityData: Array<{ display: string; price: number | null; change: number | null; sparkline?: number[] }> = [];
  private firesCache: ListFireDetectionsResponse | null = null;

  constructor(ctx: AppContext, callbacks: DataLoaderCallbacks) {
    this.ctx = ctx;
    this.callbacks = callbacks;
  }

  public setSourcesReady(promise: Promise<unknown>): void {
    this.sourcesReady = promise.then(() => {}).catch(() => {});
  }

  init(): void {}

  destroy(): void {
    stopOrefPolling();
  }

  private async tryFetchDigest(): Promise<ListFeedDigestResponse | null> {
    const data = fetchNewsDigest(0);
    if (data) {
      this.lastGoodDigest = data;
      this.persistDigest(data);
      return data;
    }
    return this.lastGoodDigest ?? await this.loadPersistedDigest();
  }

  private persistDigest(data: ListFeedDigestResponse): void {
    setPersistentCache('digest:last-good', data).catch(() => {});
  }

  private async loadPersistedDigest(): Promise<ListFeedDigestResponse | null> {
    try {
      const envelope = await getPersistentCache<ListFeedDigestResponse>('digest:last-good');
      if (!envelope) return null;
      if (Date.now() - envelope.updatedAt > this.persistedDigestMaxAgeMs) return null;
      this.lastGoodDigest = envelope.data;
      return envelope.data;
    } catch { return null; }
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

  private findFlashLocation(title: string): { lat: number; lon: number } | null {
    const tokens = tokenizeForMatch(title);
    let bestMatch: { lat: number; lon: number; matches: number } | null = null;

    const countKeywordMatches = (keywords: string[] | undefined): number => {
      if (!keywords) return 0;
      let matches = 0;
      for (const keyword of keywords) {
        const cleaned = keyword.trim().toLowerCase();
        if (cleaned.length >= 3 && matchKeyword(tokens, cleaned)) {
          matches++;
        }
      }
      return matches;
    };

    for (const hotspot of INTEL_HOTSPOTS) {
      const matches = countKeywordMatches(hotspot.keywords);
      if (matches > 0 && (!bestMatch || matches > bestMatch.matches)) {
        bestMatch = { lat: hotspot.lat, lon: hotspot.lon, matches };
      }
    }

    for (const conflict of CONFLICT_ZONES) {
      const matches = countKeywordMatches(conflict.keywords);
      if (matches > 0 && (!bestMatch || matches > bestMatch.matches)) {
        bestMatch = { lat: conflict.center[1], lon: conflict.center[0], matches };
      }
    }

    return bestMatch;
  }

  private flashMapForNews(items: NewsItem[]): void {
    if (!this.ctx.map || !this.ctx.initialLoadComplete) return;
    if (!getAiFlowSettings().mapNewsFlash) return;
    const now = Date.now();

    for (const [key, timestamp] of this.mapFlashCache.entries()) {
      if (now - timestamp > this.MAP_FLASH_COOLDOWN_MS) {
        this.mapFlashCache.delete(key);
      }
    }

    for (const item of items) {
      const cacheKey = `${item.source}|${item.link || item.title}`;
      const lastSeen = this.mapFlashCache.get(cacheKey);
      if (lastSeen && now - lastSeen < this.MAP_FLASH_COOLDOWN_MS) {
        continue;
      }

      const location = this.findFlashLocation(item.title);
      if (!location) continue;

      this.ctx.map.flashLocation(location.lat, location.lon);
      this.mapFlashCache.set(cacheKey, now);
    }
  }

  getTimeRangeWindowMs(range: TimeRange): number {
    const ranges: Record<TimeRange, number> = {
      '1h': 60 * 60 * 1000,
      '6h': 6 * 60 * 60 * 1000,
      '24h': 24 * 60 * 60 * 1000,
      '48h': 48 * 60 * 60 * 1000,
      '7d': 7 * 24 * 60 * 60 * 1000,
      'all': Infinity,
    };
    return ranges[range];
  }

  filterItemsByTimeRange(items: NewsItem[], range: TimeRange = this.ctx.currentTimeRange): NewsItem[] {
    if (range === 'all') return items;
    const cutoff = Date.now() - this.getTimeRangeWindowMs(range);
    return items.filter((item) => {
      const ts = item.pubDate instanceof Date ? item.pubDate.getTime() : new Date(item.pubDate).getTime();
      return Number.isFinite(ts) ? ts >= cutoff : true;
    });
  }

  getTimeRangeLabel(range: TimeRange = this.ctx.currentTimeRange): string {
    const labels: Record<TimeRange, string> = {
      '1h': 'the last hour',
      '6h': 'the last 6 hours',
      '24h': 'the last 24 hours',
      '48h': 'the last 48 hours',
      '7d': 'the last 7 days',
      'all': 'all time',
    };
    return labels[range];
  }

  renderNewsForCategory(category: string, items: NewsItem[]): void {
    this.ctx.newsByCategory[category] = items;
    const panel = this.ctx.newsPanels[category];
    if (!panel) return;
    const filteredItems = this.filterItemsByTimeRange(items);
    if (filteredItems.length === 0 && items.length > 0) {
      panel.renderFilteredEmpty(`No items in ${this.getTimeRangeLabel()}`);
      return;
    }
    panel.renderNews(filteredItems);
  }

  applyTimeRangeFilterToNewsPanels(): void {
    Object.entries(this.ctx.newsByCategory).forEach(([category, items]) => {
      this.renderNewsForCategory(category, items);
    });
  }

  applyTimeRangeFilterDebounced(): void {
    this.applyTimeRangeFilterToNewsPanelsDebounced();
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
        this.renderNewsForCategory(category, pendingItems);
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
        this.renderNewsForCategory(category, staleItems);
        this.ctx.statusPanel?.updateFeed(category.charAt(0).toUpperCase() + category.slice(1), {
          status: 'ok',
          itemCount: staleItems.length,
        });
        return staleItems;
      }

      if (!this.isPerFeedFallbackEnabled()) {
        console.warn(`[News] Digest missing for "${category}", limited per-feed fallback disabled`);
        this.renderNewsForCategory(category, []);
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
          this.flashMapForNews(partialItems);
          checkBatchForBreakingAlerts(partialItems);
        },
      });

      this.renderNewsForCategory(category, items);
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
    const digestPromise = this.tryFetchDigest();

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
      this.processDigestData(digest);
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
          this.renderNewsForCategory('intel', staleIntel);
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
            this.renderNewsForCategory('intel', intel);
            if (intelPanel) {
              try {
                const baseline = await updateBaseline('news:intel', intel.length);
                const deviation = calculateDeviation(intel.length, baseline);
                intelPanel.setDeviation(deviation.zScore, deviation.percentChange, deviation.level);
              } catch (e) { console.warn('[Baseline] news:intel write failed:', e); }
            }
            this.ctx.statusPanel?.updateFeed('Intel', { status: 'ok', itemCount: intel.length });
            collectedNews.push(...intel);
            this.flashMapForNews(intel);
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

    // Instant hydration from bootstrap cache (shows stale data immediately)
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
      this.renderMarketDashboard(dashboard);

      // Prefer hydrated sectors from bootstrap when available (startup optimization)
      const hydratedSectors = getHydratedData('sectors') as GetSectorSummaryResponse | undefined;
      if (hydratedSectors?.sectors?.length) {
        (this.ctx.panels['heatmap'] as HeatmapPanel).renderHeatmap(
          hydratedSectors.sectors.map((s) => ({ name: s.name, change: s.change })),
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

  private renderPredictions(predictions: import('@/services/prediction').PredictionMarket[]): void {
    this.ctx.latestPredictions = predictions;
    (this.ctx.panels['polymarket'] as PredictionPanel).renderPredictions(predictions);
    this.ctx.statusPanel?.updateFeed('Polymarket', { status: 'ok', itemCount: predictions.length });
    this.ctx.statusPanel?.updateApi('Polymarket', { status: 'ok' });
    dataFreshness.recordUpdate('polymarket', predictions.length);
    dataFreshness.recordUpdate('predictions', predictions.length);
    void this.runCorrelationAnalysis();
  }

  async loadPredictions(): Promise<void> {
    try {
      const predictions = await fetchPredictions();
      this.renderPredictions(predictions);
    } catch (error) {
      this.ctx.statusPanel?.updateFeed('Polymarket', { status: 'error', errorMessage: String(error) });
      this.ctx.statusPanel?.updateApi('Polymarket', { status: 'error' });
      dataFreshness.recordError('polymarket', String(error));
      dataFreshness.recordError('predictions', String(error));
    }
  }

  async loadNatural(): Promise<void> {
    const hasCachedNatural = (this.ctx.intelligenceCache.eonetEvents?.length ?? 0) > 0 || (this.ctx.intelligenceCache.gdacsEvents?.length ?? 0) > 0;
    const hasCachedEarthquakes = (this.ctx.intelligenceCache.earthquakes?.length ?? 0) > 0;

    if (hasCachedNatural) {
      this.mergeAndRenderNaturalEvents();
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

    const [earthquakeResult, relayEonet, relayGdacs] = await Promise.all([
      fetchEarthquakes().then((v) => ({ status: 'fulfilled' as const, value: v })).catch((e) => ({ status: 'rejected' as const, reason: e })),
      fetchRelayPanel('eonet'),
      fetchRelayPanel('gdacs'),
    ]);

    if (relayEonet) this.applyEonet(relayEonet);
    if (relayGdacs) this.applyGdacs(relayGdacs);

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

    if (!relayEonet && !relayGdacs && !hasCachedNatural) {
      this.ctx.map?.setNaturalEvents([]);
      this.ctx.statusPanel?.updateFeed('EONET', { status: 'error', errorMessage: 'No data from relay' });
      this.ctx.statusPanel?.updateApi('NASA EONET', { status: 'error' });
    }

    const hasEarthquakes = earthquakeResult.status === 'fulfilled' && earthquakeResult.value.length > 0;
    const hasEonet = !!relayEonet || !!relayGdacs || hasCachedNatural;
    this.ctx.map?.setLayerReady('natural', hasEarthquakes || hasEonet);
  }

  async loadTechEvents(): Promise<void> {
    if (SITE_VARIANT !== 'tech' && !this.ctx.mapLayers.techEvents) return;

    try {
      const data = await fetchRelayPanel('tech-events');
      if (data) {
        this.applyTechEvents(data);
        return;
      }
    } catch {}
    try {
      const data = await fetchTechEvents('conference', true, 90, 50);
      if (!data.success) throw new Error(data.error || 'Unknown error');
      this.renderTechEvents(data);
    } catch (error) {
      console.error('[App] Failed to load tech events:', error);
      this.ctx.map?.setTechEvents([]);
      this.ctx.map?.setLayerReady('techEvents', false);
      this.ctx.statusPanel?.updateFeed('Tech Events', { status: 'error', errorMessage: String(error) });
    }
  }

  private renderWeatherAlerts(alerts: import('@/services/weather').WeatherAlert[]): void {
    this.ctx.intelligenceCache.weatherAlerts = alerts;
    this.ctx.map?.setWeatherAlerts(alerts);
    this.ctx.map?.setLayerReady('weather', alerts.length > 0);
    this.ctx.statusPanel?.updateFeed('Weather', { status: 'ok', itemCount: alerts.length });
    dataFreshness.recordUpdate('weather', alerts.length);
  }

  async loadWeatherAlerts(): Promise<void> {
    if (this.ctx.intelligenceCache.weatherAlerts) {
      this.renderWeatherAlerts(this.ctx.intelligenceCache.weatherAlerts);
      return;
    }
    try {
      const data = await fetchRelayPanel('weather');
      if (data) {
        this.applyWeatherAlerts(data);
        return;
      }
    } catch {}
    this.ctx.map?.setLayerReady('weather', false);
    dataFreshness.recordError('weather', 'Relay data unavailable');
    this.ctx.statusPanel?.updateFeed('Weather', { status: 'error' });
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
        const data = await fetchRelayPanel('conflict');
        if (data) {
          this.applyConflict(data);
          return this.ctx.intelligenceCache.protests?.events || [];
        }
      } catch {}
      return [];
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

    // OREF sirens
    tasks.push((async () => {
      try {
        const data = await fetchOrefAlerts();
        (this.ctx.panels['oref-sirens'] as OrefSirensPanel)?.setData(data);
        const alertCount = data.alerts?.length ?? 0;
        const historyCount24h = data.historyCount24h ?? 0;
        ingestOrefForCII(alertCount, historyCount24h);
        this.ctx.intelligenceCache.orefAlerts = { alertCount, historyCount24h };
        if (data.alerts?.length) dispatchOrefBreakingAlert(data.alerts);
        onOrefAlertsUpdate((update) => {
          (this.ctx.panels['oref-sirens'] as OrefSirensPanel)?.setData(update);
          const updAlerts = update.alerts?.length ?? 0;
          const updHistory = update.historyCount24h ?? 0;
          ingestOrefForCII(updAlerts, updHistory);
          this.ctx.intelligenceCache.orefAlerts = { alertCount: updAlerts, historyCount24h: updHistory };
          if (update.alerts?.length) dispatchOrefBreakingAlert(update.alerts);
        });
        startOrefPolling();
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

  private renderCyberThreats(threats: import('@/types').CyberThreat[]): void {
    this.ctx.cyberThreatsCache = threats;
    this.ctx.map?.setCyberThreats(threats);
    this.ctx.map?.setLayerReady('cyberThreats', threats.length > 0);
    ingestCyberThreatsForCII(threats);
    (this.ctx.panels['cii'] as CIIPanel)?.refresh();
    this.ctx.statusPanel?.updateFeed('Cyber Threats', { status: 'ok', itemCount: threats.length });
    this.ctx.statusPanel?.updateApi('Cyber Threats API', { status: 'ok' });
    dataFreshness.recordUpdate('cyber_threats', threats.length);
  }

  async loadCyberThreats(): Promise<void> {
    if (!CYBER_LAYER_ENABLED) {
      this.ctx.mapLayers.cyberThreats = false;
      this.ctx.map?.setLayerReady('cyberThreats', false);
      return;
    }

    if (this.ctx.cyberThreatsCache) {
      this.renderCyberThreats(this.ctx.cyberThreatsCache);
      return;
    }

    try {
      const data = await fetchRelayPanel('cyber');
      if (data) {
        this.applyCyberThreats(data);
        return;
      }
    } catch {}

    const threats = fetchCyberThreats();
    if (threats.length > 0) {
      this.renderCyberThreats(threats);
    } else {
      this.ctx.map?.setLayerReady('cyberThreats', false);
    }
  }

  async loadIranEvents(): Promise<void> {
    if (this.ctx.intelligenceCache.iranEvents) {
      this.renderIranEvents(this.ctx.intelligenceCache.iranEvents);
      return;
    }
    try {
      const data = await fetchRelayPanel('iran-events');
      if (data) {
        this.applyIranEvents(data);
        return;
      }
    } catch {}
    this.ctx.map?.setLayerReady('iranAttacks', false);
  }

  private renderAisSignals(disruptions: import('@/types').AisDisruptionEvent[], density: import('@/types').AisDensityZone[]): void {
    const aisStatus = getAisStatus();
    this.ctx.map?.setAisData(disruptions, density);
    signalAggregator.ingestAisDisruptions(disruptions);
    ingestAisDisruptionsForCII(disruptions);
    (this.ctx.panels['cii'] as CIIPanel)?.refresh();
    updateAndCheck([
      { type: 'ais_gaps', region: 'global', count: disruptions.length },
    ]).then(anomalies => {
      if (anomalies.length > 0) {
        signalAggregator.ingestTemporalAnomalies(anomalies);
        ingestTemporalAnomaliesForCII(anomalies);
        (this.ctx.panels['cii'] as CIIPanel)?.refresh();
      }
    }).catch(() => { });

    const hasData = disruptions.length > 0 || density.length > 0;
    this.ctx.map?.setLayerReady('ais', hasData);

    const shippingCount = disruptions.length + density.length;
    const shippingStatus = shippingCount > 0 ? 'ok' : (aisStatus.connected ? 'warning' : 'error');
    this.ctx.statusPanel?.updateFeed('Shipping', {
      status: shippingStatus,
      itemCount: shippingCount,
      errorMessage: !aisStatus.connected && shippingCount === 0 ? 'AIS snapshot unavailable' : undefined,
    });
    this.ctx.statusPanel?.updateApi('AISStream', {
      status: aisStatus.connected ? 'ok' : 'warning',
    });
    if (hasData) {
      dataFreshness.recordUpdate('ais', shippingCount);
    }
  }

  async loadAisSignals(): Promise<void> {
    try {
      const data = await fetchRelayPanel('ais');
      if (data) {
        this.applyAisSignals(data);
        return;
      }
    } catch {}
    this.ctx.map?.setLayerReady('ais', false);
    this.ctx.statusPanel?.updateFeed('Shipping', { status: 'error', errorMessage: 'No data from relay' });
    this.ctx.statusPanel?.updateApi('AISStream', { status: 'error' });
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

  private renderCableHealth(cables: Record<string, import('@/types').CableHealthRecord>): void {
    this.ctx.map?.setCableHealth(cables);
    const cableIds = Object.keys(cables);
    const faultCount = cableIds.filter((id) => cables[id]?.status === 'fault').length;
    const degradedCount = cableIds.filter((id) => cables[id]?.status === 'degraded').length;
    this.ctx.statusPanel?.updateFeed('CableHealth', { status: 'ok', itemCount: faultCount + degradedCount });
  }

  async loadCableHealth(): Promise<void> {
    try {
      const data = await fetchRelayPanel('cables');
      if (data) {
        this.applyCableHealth(data);
        return;
      }
    } catch {}
    this.ctx.map?.setLayerReady('cables', false);
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
    try {
      const data = await fetchRelayPanel('conflict');
      if (data) {
        this.applyConflict(data);
        return;
      }
    } catch {}

    this.ctx.map?.setLayerReady('protests', false);
    this.ctx.statusPanel?.updateFeed('Protests', { status: 'error', errorMessage: 'No data from relay' });
    this.ctx.statusPanel?.updateApi('ACLED', { status: 'error' });
    this.ctx.statusPanel?.updateApi('GDELT Doc', { status: 'error' });
  }

  private renderFlightDelays(delays: import('@/services/aviation').AirportDelayAlert[]): void {
    this.ctx.map?.setFlightDelays(delays);
    this.ctx.map?.setLayerReady('flights', delays.length > 0);
    this.ctx.intelligenceCache.flightDelays = delays;
    const severe = delays.filter(d => d.severity === 'major' || d.severity === 'severe' || d.delayType === 'closure');
    if (severe.length > 0) ingestAviationForCII(severe);
    this.ctx.statusPanel?.updateFeed('Flights', {
      status: 'ok',
      itemCount: delays.length,
    });
    this.ctx.statusPanel?.updateApi('FAA', { status: 'ok' });
  }

  async loadFlightDelays(): Promise<void> {
    if (this.ctx.intelligenceCache.flightDelays) {
      this.renderFlightDelays(this.ctx.intelligenceCache.flightDelays);
      return;
    }
    try {
      const data = await fetchRelayPanel('flights');
      if (data) {
        this.applyFlightDelays(data);
        return;
      }
    } catch {}
    this.ctx.map?.setLayerReady('flights', false);
    this.ctx.statusPanel?.updateFeed('Flights', { status: 'error', errorMessage: 'No data from relay' });
    this.ctx.statusPanel?.updateApi('FAA', { status: 'error' });
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

  private renderFredData(data: import('@/services/economic').FredSeries[]): void {
    const economicPanel = this.ctx.panels['economic'] as EconomicPanel;
    economicPanel?.setErrorState(false);
    economicPanel?.update(data);
    this.ctx.statusPanel?.updateApi('FRED', { status: data.length > 0 ? 'ok' : 'error' });
    if (data.length > 0) dataFreshness.recordUpdate('economic', data.length);
  }

  async loadFredData(): Promise<void> {
    const economicPanel = this.ctx.panels['economic'] as EconomicPanel;
    const cbInfo = getCircuitBreakerCooldownInfo('FRED Dashboard');
    if (cbInfo.onCooldown) {
      economicPanel?.setErrorState(true, `Temporarily unavailable (retry in ${cbInfo.remainingSeconds}s)`);
      this.ctx.statusPanel?.updateApi('FRED', { status: 'error' });
      return;
    }

    try {
      economicPanel?.setLoading(true);
      const data = await fetchFredDashboard();

      const postInfo = getCircuitBreakerCooldownInfo('FRED Dashboard');
      if (postInfo.onCooldown) {
        economicPanel?.setErrorState(true, `Temporarily unavailable (retry in ${postInfo.remainingSeconds}s)`);
        this.ctx.statusPanel?.updateApi('FRED', { status: 'error' });
        return;
      }

      if (data.length === 0) {
        if (!isFeatureAvailable('economicFred')) {
          this.ctx.statusPanel?.updateApi('FRED', { status: 'error' });
          return;
        }
        economicPanel?.showRetrying();
        await new Promise(r => setTimeout(r, 20_000));
        const retryData = await fetchFredDashboard();
        if (retryData.length === 0) {
          economicPanel?.setErrorState(true, 'FRED data temporarily unavailable — will retry');
          this.ctx.statusPanel?.updateApi('FRED', { status: 'error' });
          return;
        }
        this.renderFredData(retryData);
        return;
      }

      this.renderFredData(data);
    } catch {
      if (isFeatureAvailable('economicFred')) {
        economicPanel?.showRetrying();
        try {
          await new Promise(r => setTimeout(r, 20_000));
          const retryData = await fetchFredDashboard();
          if (retryData.length > 0) {
            this.renderFredData(retryData);
            return;
          }
        } catch {}
      }
      this.ctx.statusPanel?.updateApi('FRED', { status: 'error' });
      economicPanel?.setErrorState(true, 'FRED data temporarily unavailable — will retry');
      economicPanel?.setLoading(false);
    }
  }

  private renderOilData(data: import('@/services/economic').OilAnalytics): void {
    const economicPanel = this.ctx.panels['economic'] as EconomicPanel;
    economicPanel?.updateOil(data);
    const hasData = !!(data.wtiPrice || data.brentPrice || data.usProduction || data.usInventory);
    this.ctx.statusPanel?.updateApi('EIA', { status: hasData ? 'ok' : 'error' });
    if (hasData) {
      const metricCount = [data.wtiPrice, data.brentPrice, data.usProduction, data.usInventory].filter(Boolean).length;
      dataFreshness.recordUpdate('oil', metricCount || 1);
    } else {
      dataFreshness.recordError('oil', 'Oil analytics returned no values');
    }
  }

  async loadOilAnalytics(): Promise<void> {
    try {
      const data = await fetchOilAnalytics();
      this.renderOilData(data);
    } catch (e) {
      console.error('[App] Oil analytics failed:', e);
      this.ctx.statusPanel?.updateApi('EIA', { status: 'error' });
      dataFreshness.recordError('oil', String(e));
    }
  }

  private renderSpending(data: import('@/services/usa-spending').SpendingSummary): void {
    const economicPanel = this.ctx.panels['economic'] as EconomicPanel;
    economicPanel?.updateSpending(data);
    this.ctx.statusPanel?.updateApi('USASpending', { status: data.awards.length > 0 ? 'ok' : 'error' });
    if (data.awards.length > 0) {
      dataFreshness.recordUpdate('spending', data.awards.length);
    } else {
      dataFreshness.recordError('spending', 'No awards returned');
    }
  }

  async loadGovernmentSpending(): Promise<void> {
    try {
      const data = await fetchRelayPanel('spending');
      if (data) {
        this.applySpending(data);
        return;
      }
    } catch (e) {
      console.error('[App] Government spending failed:', e);
    }
    this.ctx.statusPanel?.updateApi('USASpending', { status: 'error' });
    dataFreshness.recordError('spending', 'No data from relay');
  }

  private renderBisData(data: BisData): void {
    const economicPanel = this.ctx.panels['economic'] as EconomicPanel;
    economicPanel?.updateBis(data);
    const hasData = data.policyRates.length > 0;
    this.ctx.statusPanel?.updateApi('BIS', { status: hasData ? 'ok' : 'error' });
    if (hasData) dataFreshness.recordUpdate('bis', data.policyRates.length);
  }

  async loadBisData(): Promise<void> {
    const hPolicy = getHydratedData('bisPolicy') as { rates?: unknown[] } | undefined;
    const hEer = getHydratedData('bisExchange') as { rates?: unknown[] } | undefined;
    const hCredit = getHydratedData('bisCredit') as { entries?: unknown[] } | undefined;

    if (hPolicy != null && hEer != null && hCredit != null) {
      const data: BisData = {
        policyRates: (hPolicy.rates ?? []) as BisData['policyRates'],
        exchangeRates: (hEer.rates ?? []) as BisData['exchangeRates'],
        creditToGdp: (hCredit.entries ?? []) as BisData['creditToGdp'],
        fetchedAt: new Date(),
      };
      this.renderBisData(data);
      return;
    }

    try {
      const dashboard = await fetchBisDashboard();
      const data: BisData = {
        policyRates: dashboard.policyRates,
        exchangeRates: dashboard.exchangeRates,
        creditToGdp: dashboard.creditGdp,
        fetchedAt: new Date(),
      };
      this.renderBisData(data);
    } catch (e) {
      console.error('[App] BIS data failed:', e);
      this.ctx.statusPanel?.updateApi('BIS', { status: 'error' });
      dataFreshness.recordError('bis', String(e));
    }
  }

  private renderTradePolicy(data: GetTradeDashboardResponse | GetTradeBarriersResponse): void {
    const tradePanel = this.ctx.panels['trade-policy'] as TradePolicyPanel | undefined;
    if (!tradePanel) return;

    if ('restrictions' in data || 'tariffs' in data || 'flows' in data) {
      const dashboard = data as GetTradeDashboardResponse;
      const restrictions = dashboard.restrictions ?? { restrictions: [], fetchedAt: '', upstreamUnavailable: false };
      const tariffs = dashboard.tariffs ?? { datapoints: [], fetchedAt: '', upstreamUnavailable: false };
      const flows = dashboard.flows ?? { flows: [], fetchedAt: '', upstreamUnavailable: false };
      const barriers = dashboard.barriers ?? { barriers: [], fetchedAt: '', upstreamUnavailable: false };

      tradePanel.updateRestrictions(restrictions);
      tradePanel.updateTariffs(tariffs);
      tradePanel.updateFlows(flows);
      tradePanel.updateBarriers(barriers);

      const totalItems = restrictions.restrictions.length + tariffs.datapoints.length + flows.flows.length + barriers.barriers.length;
      const anyUnavailable = restrictions.upstreamUnavailable || tariffs.upstreamUnavailable || flows.upstreamUnavailable || barriers.upstreamUnavailable;

      this.ctx.statusPanel?.updateApi('WTO', { status: anyUnavailable ? 'warning' : totalItems > 0 ? 'ok' : 'error' });

      if (totalItems > 0) {
        dataFreshness.recordUpdate('wto_trade', totalItems);
      } else if (anyUnavailable) {
        dataFreshness.recordError('wto_trade', 'WTO upstream temporarily unavailable');
      }
    } else {
      tradePanel.updateBarriers(data as GetTradeBarriersResponse);
      const barriers = data as GetTradeBarriersResponse;
      const totalItems = barriers.barriers?.length ?? 0;
      const anyUnavailable = barriers.upstreamUnavailable;
      this.ctx.statusPanel?.updateApi('WTO', { status: anyUnavailable ? 'warning' : totalItems > 0 ? 'ok' : 'error' });
      if (totalItems > 0) dataFreshness.recordUpdate('wto_trade', totalItems);
    }
  }

  async loadTradePolicy(): Promise<void> {
    try {
      const dashboard = await fetchTradeDashboard();
      this.renderTradePolicy(dashboard);
    } catch (e) {
      console.error('[App] Trade policy failed:', e);
      this.ctx.statusPanel?.updateApi('WTO', { status: 'error' });
      dataFreshness.recordError('wto_trade', String(e));
    }
  }

  private renderSupplyChain(data: GetSupplyChainDashboardResponse | GetChokepointStatusResponse): void {
    const scPanel = this.ctx.panels['supply-chain'] as SupplyChainPanel | undefined;
    if (!scPanel) return;

    if ('shipping' in data || 'minerals' in data) {
      const dashboard = data as GetSupplyChainDashboardResponse;
      const shippingData = dashboard.shipping ?? null;
      const chokepointData = dashboard.chokepoints ?? null;
      const mineralsData = dashboard.minerals ?? null;

      if (shippingData) scPanel.updateShippingRates(shippingData);
      if (chokepointData) scPanel.updateChokepointStatus(chokepointData);
      if (mineralsData) scPanel.updateCriticalMinerals(mineralsData);

      const totalItems = (shippingData?.indices.length || 0) + (chokepointData?.chokepoints.length || 0) + (mineralsData?.minerals.length || 0);
      const anyUnavailable = shippingData?.upstreamUnavailable || chokepointData?.upstreamUnavailable || mineralsData?.upstreamUnavailable;

      this.ctx.statusPanel?.updateApi('SupplyChain', { status: anyUnavailable ? 'warning' : totalItems > 0 ? 'ok' : 'error' });

      if (totalItems > 0) {
        dataFreshness.recordUpdate('supply_chain', totalItems);
      } else if (anyUnavailable) {
        dataFreshness.recordError('supply_chain', 'Supply chain upstream temporarily unavailable');
      }
    } else {
      const chokepointData = data as GetChokepointStatusResponse;
      scPanel.updateChokepointStatus(chokepointData);
      const totalItems = chokepointData.chokepoints?.length ?? 0;
      const anyUnavailable = chokepointData.upstreamUnavailable;
      this.ctx.statusPanel?.updateApi('SupplyChain', { status: anyUnavailable ? 'warning' : totalItems > 0 ? 'ok' : 'error' });
      if (totalItems > 0) dataFreshness.recordUpdate('supply_chain', totalItems);
    }
  }

  async loadSupplyChain(): Promise<void> {
    try {
      const dashboard = await fetchSupplyChainDashboard();
      this.renderSupplyChain(dashboard);
    } catch (e) {
      console.error('[App] Supply chain failed:', e);
      this.ctx.statusPanel?.updateApi('SupplyChain', { status: 'error' });
      dataFreshness.recordError('supply_chain', String(e));
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
      this.renderNatural(this.firesCache);
      return;
    }
    try {
      const data = await fetchRelayPanel('natural');
      if (data) {
        this.applyNatural(data);
        return;
      }
    } catch {}
    this.ctx.statusPanel?.updateApi('FIRMS', { status: 'error' });
  }

  private renderNatural(data: ListFireDetectionsResponse): void {
    const detections = data.fireDetections ?? [];
    if (detections.length > 0) this.firesCache = data;
    if (detections.length === 0) {
      ingestSatelliteFiresForCII([]);
      (this.ctx.panels['cii'] as CIIPanel)?.refresh();
      (this.ctx.panels['satellite-fires'] as SatelliteFiresPanel)?.update([], 0);
      this.ctx.statusPanel?.updateApi('FIRMS', { status: 'ok' });
      return;
    }
    const regions: Record<string, import('@/services/wildfires').FireDetection[]> = {};
    for (const d of detections) {
      const r = d.region || 'Unknown';
      (regions[r] ??= []).push(d);
    }
    const flat = flattenFires(regions);
    const stats = computeRegionStats(regions);
    const satelliteFires = flat.map(f => ({
      lat: f.location?.latitude ?? 0,
      lon: f.location?.longitude ?? 0,
      brightness: f.brightness,
      frp: f.frp,
      region: f.region,
      acq_date: new Date(f.detectedAt).toISOString().slice(0, 10),
    }));
    signalAggregator.ingestSatelliteFires(satelliteFires);
    ingestSatelliteFiresForCII(satelliteFires);
    (this.ctx.panels['cii'] as CIIPanel)?.refresh();
    this.ctx.map?.setFires(toMapFires(flat));
    (this.ctx.panels['satellite-fires'] as SatelliteFiresPanel)?.update(stats, flat.length);
    dataFreshness.recordUpdate('firms', flat.length);
    updateAndCheck([{ type: 'satellite_fires', region: 'global', count: flat.length }]).then(anomalies => {
      if (anomalies.length > 0) {
        signalAggregator.ingestTemporalAnomalies(anomalies);
        ingestTemporalAnomaliesForCII(anomalies);
        (this.ctx.panels['cii'] as CIIPanel)?.refresh();
      }
    }).catch(() => { });
    this.ctx.statusPanel?.updateApi('FIRMS', { status: 'ok' });
  }

  private renderGiving(data: import('@/services/giving').GivingSummary): void {
    (this.ctx.panels['giving'] as GivingPanel)?.setData(data);
    dataFreshness.recordUpdate('giving', data.platforms.length);
  }

  async loadGiving(): Promise<void> {
    try {
      const result = await fetchGivingSummary();
      if (result.ok && result.data) {
        this.renderGiving(result.data);
      }
    } catch (error) {
      console.error('[App] Giving summary fetch failed:', error);
      dataFreshness.recordError('giving', String(error));
    }
  }

  private renderPizzInt(status: import('@/types').PizzIntStatus, tensions: import('@/types').GdeltTensionPair[]): void {
    if (status.locationsMonitored === 0) {
      this.ctx.pizzintIndicator?.hide();
      this.ctx.statusPanel?.updateApi('PizzINT', { status: 'error' });
      dataFreshness.recordError('pizzint', 'No monitored locations returned');
      return;
    }

    this.ctx.pizzintIndicator?.show();
    this.ctx.pizzintIndicator?.updateStatus(status);
    this.ctx.pizzintIndicator?.updateTensions(tensions);
    this.ctx.statusPanel?.updateApi('PizzINT', { status: 'ok' });
    dataFreshness.recordUpdate('pizzint', Math.max(status.locationsMonitored, tensions.length));
  }

  async loadPizzInt(): Promise<void> {
    try {
      const [status, tensions] = await Promise.all([
        fetchPizzIntStatus(),
        fetchGdeltTensions()
      ]);
      this.renderPizzInt(status, tensions);
    } catch (error) {
      console.error('[App] PizzINT load failed:', error);
      this.ctx.pizzintIndicator?.hide();
      this.ctx.statusPanel?.updateApi('PizzINT', { status: 'error' });
      dataFreshness.recordError('pizzint', String(error));
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
      this.renderTelegramIntel(result);
    } catch (error) {
      console.error('[App] Telegram intel fetch failed:', error);
    }
  }

  private renderTelegramIntel(result: import('@/services/telegram-intel').TelegramFeedResponse): void {
    (this.ctx.panels['telegram-intel'] as TelegramIntelPanel)?.setData(result);
  }

  /**
   * Process digest data and render to UI. Shared by loadNews (when digest available)
   * and applyNewsDigest (when relay pushes payload). Does not fetch — data is already loaded.
   */
  private processDigestData(data: ListFeedDigestResponse): void {
    if (!data?.categories || typeof data.categories !== 'object') return;

    const feedsMap = getFeeds();
    const categories = Object.entries(feedsMap)
      .filter((entry): entry is [string, import('@/types').Feed[]] => Array.isArray(entry[1]) && entry[1].length > 0)
      .map(([key, feeds]) => ({ key, feeds }));

    const collectedNews: NewsItem[] = [];

    for (const { key: category, feeds } of categories) {
      if (!(category in data.categories)) continue;

      const enabledFeeds = (feeds ?? []).filter(f => !this.ctx.disabledSources.has(f.name));
      if (enabledFeeds.length === 0) {
        delete this.ctx.newsByCategory[category];
        const panel = this.ctx.newsPanels[category];
        if (panel) panel.showError(t('common.allSourcesDisabled'));
        this.ctx.statusPanel?.updateFeed(category.charAt(0).toUpperCase() + category.slice(1), {
          status: 'ok',
          itemCount: 0,
        });
        continue;
      }

      const enabledNames = new Set(enabledFeeds.map(f => f.name));
      const items = (data.categories[category]?.items ?? [])
        .map(protoItemToNewsItem)
        .filter(i => enabledNames.has(i.source));

      ingestHeadlines(items.map(i => ({ title: i.title, pubDate: i.pubDate, source: i.source, link: i.link })));

      const aiCandidates = items
        .filter(i => i.threat?.source === 'keyword')
        .sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime())
        .slice(0, AI_CLASSIFY_MAX_PER_FEED);
      for (const item of aiCandidates) {
        if (!canQueueAiClassification(item.title)) continue;
        classifyWithAI(item.title, SITE_VARIANT).then(ai => {
          if (ai && item.threat && ai.confidence > item.threat.confidence) {
            item.threat = ai;
            item.isAlert = ai.level === 'critical' || ai.level === 'high';
          }
        }).catch(() => {});
      }

      checkBatchForBreakingAlerts(items);
      this.flashMapForNews(items);
      this.renderNewsForCategory(category, items);

      this.ctx.statusPanel?.updateFeed(category.charAt(0).toUpperCase() + category.slice(1), {
        status: 'ok',
        itemCount: items.length,
      });

      const panel = this.ctx.newsPanels[category];
      if (panel) {
        updateBaseline(`news:${category}`, items.length)
          .then(baseline => {
            const deviation = calculateDeviation(items.length, baseline);
            panel.setDeviation(deviation.zScore, deviation.percentChange, deviation.level);
          })
          .catch(e => { console.warn(`[Baseline] news:${category} write failed:`, e); });
      }

      collectedNews.push(...items);
    }

    if (SITE_VARIANT === 'full' && data.categories && 'intel' in data.categories) {
      const enabledIntelSources = getIntelSources().filter(f => !this.ctx.disabledSources.has(f.name));
      const enabledIntelNames = new Set(enabledIntelSources.map(f => f.name));
      const intelPanel = this.ctx.newsPanels['intel'];

      if (enabledIntelSources.length === 0) {
        delete this.ctx.newsByCategory['intel'];
        if (intelPanel) intelPanel.showError(t('common.allIntelSourcesDisabled'));
        this.ctx.statusPanel?.updateFeed('Intel', { status: 'ok', itemCount: 0 });
      } else {
        const intel = (data.categories['intel']?.items ?? [])
          .map(protoItemToNewsItem)
          .filter(i => enabledIntelNames.has(i.source));
        checkBatchForBreakingAlerts(intel);
        this.renderNewsForCategory('intel', intel);
        if (intelPanel) {
          updateBaseline('news:intel', intel.length)
            .then(baseline => {
              const deviation = calculateDeviation(intel.length, baseline);
              intelPanel.setDeviation(deviation.zScore, deviation.percentChange, deviation.level);
            })
            .catch(e => { console.warn('[Baseline] news:intel write failed:', e); });
        }
        this.ctx.statusPanel?.updateFeed('Intel', { status: 'ok', itemCount: intel.length });
        collectedNews.push(...intel);
        this.flashMapForNews(intel);
      }
    }

    if (SITE_VARIANT === 'happy') {
      for (const item of collectedNews) {
        item.happyCategory = classifyNewsItem(item.source, item.title);
      }
      this.ctx.happyAllItems = collectedNews;
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
      void this.loadHappySupplementaryAndRender().then(() =>
        Promise.allSettled([
          this.ctx.mapLayers.positiveEvents ? this.loadPositiveEvents() : Promise.resolve(),
          this.ctx.mapLayers.kindness ? Promise.resolve(this.loadKindnessData()) : Promise.resolve(),
        ])
      );
    }
  }

  /**
   * Render market dashboard to UI panels. Shared by loadMarkets (after fetch)
   * and applyMarkets (when relay pushes payload). Does not fetch — data is already loaded.
   */
  private renderMarketDashboard(dashboard: GetMarketDashboardResponse): void {
    const commoditiesPanel = this.ctx.panels['commodities'] as CommoditiesPanel;

    // Stocks panel
    const stockData = dashboard.stocks.map((q) => ({
      symbol: q.symbol,
      name: q.name,
      display: q.display || q.symbol,
      price: q.price != null ? q.price : null,
      change: q.change ?? null,
      sparkline: q.sparkline.length > 0 ? q.sparkline : undefined,
    }));
    this.ctx.latestMarkets = stockData;
    (this.ctx.panels['markets'] as MarketPanel).renderMarkets(
      stockData,
      dashboard.rateLimited,
    );

    if (dashboard.finnhubSkipped) {
      this.ctx.statusPanel?.updateApi('Finnhub', { status: 'error' });
    } else {
      this.ctx.statusPanel?.updateApi('Finnhub', { status: stockData.length > 0 ? 'ok' : 'error' });
    }

    // Sector heatmap
    if (dashboard.sectors.length > 0) {
      (this.ctx.panels['heatmap'] as HeatmapPanel).renderHeatmap(
        dashboard.sectors.map((s) => ({ name: s.name, change: s.change })),
      );
    }

    // Commodities panel
    const commodityData = dashboard.commodities.map((q) => ({
      display: q.display || q.symbol,
      price: q.price != null ? q.price : null,
      change: q.change ?? null,
      sparkline: (q.sparkline?.length ?? 0) > 0 ? (q.sparkline ?? []) : undefined,
    }));
    if (commodityData.length > 0 && commodityData.some((d) => d.price !== null)) {
      this.lastCommodityData = commodityData;
      commoditiesPanel.renderCommodities(commodityData);
    } else if (this.lastCommodityData.length > 0) {
      commoditiesPanel.renderCommodities(this.lastCommodityData, true);
    } else {
      commoditiesPanel.renderCommodities([]);
    }

    // Crypto panel
    const cryptoData = dashboard.crypto.map((q) => ({
      name: q.name,
      symbol: q.symbol,
      price: q.price,
      change: q.change,
      sparkline: q.sparkline.length > 0 ? q.sparkline : undefined,
    }));
    (this.ctx.panels['crypto'] as CryptoPanel).renderCrypto(cryptoData);
    this.ctx.statusPanel?.updateApi('CoinGecko', { status: cryptoData.length > 0 ? 'ok' : 'error' });
  }

  // ── apply* methods: receive relay-push payloads ──
  applyNewsDigest(payload: unknown): void {
    const data = payload as ListFeedDigestResponse;
    if (!data?.categories || typeof data.categories !== 'object') return;
    this.processDigestData(data);
  }

  applyMarkets(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const dashboard = payload as GetMarketDashboardResponse;
    if (!Array.isArray(dashboard.stocks)) return;
    this.renderMarketDashboard(dashboard);
  }

  applyPredictions(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const resp = payload as ListPredictionMarketsResponse;
    if (!Array.isArray(resp.markets)) return;
    const predictions = resp.markets.map(m => ({
      title: m.title,
      yesPrice: (m.yesPrice ?? 0.5) * 100,
      volume: m.volume,
      url: m.url,
      endDate: m.closesAt ? new Date(m.closesAt).toISOString() : undefined,
    }));
    this.renderPredictions(predictions);
  }

  applyFredData(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const resp = payload as GetFredDashboardResponse | GetFredSeriesResponse;
    if (!('series' in resp)) return;
    const data = fredResponseToClientSeries(resp);
    this.renderFredData(data);
  }

  applyOilData(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const resp = payload as GetEnergyPricesResponse;
    if (!Array.isArray(resp.prices)) return;
    const data = energyPricesToOilAnalytics(resp);
    this.renderOilData(data);
  }

  applyBisData(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const resp = payload as GetBisPolicyRatesResponse;
    if (!Array.isArray(resp.rates)) return;
    const data: BisData = {
      policyRates: resp.rates,
      exchangeRates: [],
      creditToGdp: [],
      fetchedAt: new Date(),
    };
    this.renderBisData(data);
  }

  private renderIntelligence(data: GetGlobalIntelDigestResponse): void {
    (this.ctx.panels['global-digest'] as GlobalDigestPanel | undefined)?.setDigest(data);
  }

  applyIntelligence(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const data = payload as GetGlobalIntelDigestResponse;
    if (!data.digest && !data.generatedAt) return;
    this.renderIntelligence(data);
  }

  applyPizzInt(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const resp = payload as import('@/generated/client/worldmonitor/intelligence/v1/service_client').GetPizzintStatusResponse;
    if (!resp.pizzint && !(Array.isArray(resp.tensionPairs) && resp.tensionPairs.length > 0)) return;
    const { status, tensions } = parsePizzintResponse(resp);
    this.renderPizzInt(status, tensions);
  }

  applyTradePolicy(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const data = payload as GetTradeBarriersResponse;
    if (!('barriers' in data)) return;
    this.renderTradePolicy(data);
  }

  applySupplyChain(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const data = payload as GetChokepointStatusResponse;
    if (!('chokepoints' in data)) return;
    this.renderSupplyChain(data);
  }
  applyNatural(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const data = payload as ListFireDetectionsResponse;
    if (!Array.isArray(data.fireDetections)) return;
    this.renderNatural(data);
  }

  applyClimate(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const resp = payload as import('@/generated/client/worldmonitor/climate/v1/service_client').ListClimateAnomaliesResponse;
    if (!Array.isArray(resp.anomalies)) return;
    const anomalies = mapClimatePayload(resp);
    if (anomalies.length === 0) return;
    (this.ctx.panels['climate'] as ClimateAnomalyPanel)?.setAnomalies(anomalies);
    ingestClimateForCII(anomalies);
    if (this.ctx.mapLayers.climate) this.ctx.map?.setClimateAnomalies(anomalies);
    dataFreshness.recordUpdate('climate', anomalies.length);
  }

  applyConflict(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const resp = payload as import('@/generated/client/worldmonitor/conflict/v1/service_client').ListAcledEventsResponse;
    if (!Array.isArray(resp.events)) return;
    const data = mapConflictPayload(resp);
    if (data.count === 0) return;
    ingestConflictsForCII(data.events);
    dataFreshness.recordUpdate('acled_conflict', data.count);
    const protestEvents: SocialUnrestEvent[] = data.events.map((e) => ({
      id: e.id,
      title: e.location || e.country,
      eventType: 'civil_unrest' as const,
      country: e.country,
      region: e.region,
      lat: e.lat,
      lon: e.lon,
      time: e.time,
      severity: (e.fatalities > 0 ? 'high' : 'medium') as import('@/types').ProtestSeverity,
      sources: [e.source],
      sourceType: 'acled' as const,
      confidence: 'high' as const,
      validated: false,
    }));
    this.ctx.intelligenceCache.protests = { events: protestEvents, sources: { acled: data.count, gdelt: 0 } };
    if (this.ctx.mapLayers.protests) {
      this.ctx.map?.setProtests(protestEvents);
      this.ctx.map?.setLayerReady('protests', protestEvents.length > 0);
    }
    ingestProtests(protestEvents);
    ingestProtestsForCII(protestEvents);
    signalAggregator.ingestProtests(protestEvents);
    const status = getProtestStatus();
    this.ctx.statusPanel?.updateFeed('Protests', { status: 'ok', itemCount: protestEvents.length, errorMessage: status.acledConfigured === false ? 'ACLED not configured - using GDELT only' : undefined });
    this.ctx.statusPanel?.updateApi('ACLED', status.acledConfigured === true ? { status: 'ok' } : status.acledConfigured === null ? { status: 'warning' } : { status: 'error' });
    this.ctx.statusPanel?.updateApi('GDELT Doc', { status: 'ok' });
    (this.ctx.panels['cii'] as CIIPanel)?.refresh();
  }

  applyUcdpEvents(payload: unknown): void {
    const result = mapUcdpPayload(payload);
    if (!result || !result.success || result.data.length === 0) return;
    (this.ctx.panels['ucdp-events'] as UcdpEventsPanel)?.setEvents(result.data);
    if (this.ctx.mapLayers.ucdpEvents) this.ctx.map?.setUcdpEvents(result.data);
    dataFreshness.recordUpdate('ucdp_events', result.count);
  }

  applyCyberThreats(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const resp = payload as ListCyberThreatsResponse;
    if (!Array.isArray(resp.threats)) return;
    const threats = adaptCyberThreatsResponse(resp);
    this.renderCyberThreats(threats);
  }

  applyAisSignals(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const snap = payload as { disruptions?: import('@/types').AisDisruptionEvent[]; density?: import('@/types').AisDensityZone[] };
    if (!Array.isArray(snap.disruptions) || !Array.isArray(snap.density)) return;
    this.renderAisSignals(snap.disruptions, snap.density);
  }

  applyCableHealth(payload: unknown): void {
    const healthData = parseCableHealthPayload(payload);
    if (!healthData) return;
    setCableHealthCache(healthData);
    this.renderCableHealth(healthData.cables);
  }

  applyFlightDelays(payload: unknown): void {
    const delays = parseFlightDelaysPayload(payload);
    if (!delays) return;
    this.renderFlightDelays(delays);
  }

  applyWeatherAlerts(payload: unknown): void {
    if (!Array.isArray(payload)) return;
    const alerts = payload.map((a: unknown) => {
      const item = a as Record<string, unknown>;
      return {
        id: String(item.id ?? ''),
        event: String(item.event ?? ''),
        severity: (item.severity ?? 'Unknown') as import('@/services/weather').WeatherAlert['severity'],
        headline: String(item.headline ?? ''),
        description: String(item.description ?? ''),
        areaDesc: String(item.areaDesc ?? ''),
        onset: item.onset ? new Date(item.onset as string | number) : new Date(),
        expires: item.expires ? new Date(item.expires as string | number) : new Date(),
        coordinates: (Array.isArray(item.coordinates) ? item.coordinates : []) as [number, number][],
        centroid: Array.isArray(item.centroid) ? (item.centroid as [number, number]) : undefined,
      };
    });
    this.renderWeatherAlerts(alerts);
  }
  applySpending(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const data = payload as import('@/services/usa-spending').SpendingSummary;
    if (!Array.isArray(data.awards)) return;
    this.renderSpending(data);
  }

  applyGiving(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const data = protoToGivingSummary(payload as GetGivingSummaryResponse);
    if (!data || !Array.isArray(data.platforms)) return;
    this.renderGiving(data);
  }

  applyTelegramIntel(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const data = payload as import('@/services/telegram-intel').TelegramFeedResponse;
    if (!('items' in data) || !Array.isArray(data.items)) return;
    this.renderTelegramIntel(data);
  }

  private renderOrefAlerts(data: import('@/services/oref-alerts').OrefAlertsResponse): void {
    (this.ctx.panels['oref-sirens'] as OrefSirensPanel)?.setData(data);
    const alertCount = data.alerts?.length ?? 0;
    const historyCount24h = data.historyCount24h ?? 0;
    ingestOrefForCII(alertCount, historyCount24h);
    this.ctx.intelligenceCache.orefAlerts = { alertCount, historyCount24h };
    if (data.alerts?.length) dispatchOrefBreakingAlert(data.alerts);
  }

  applyOref(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const data = payload as import('@/services/oref-alerts').OrefAlertsResponse;
    if (!('configured' in data) && !('alerts' in data)) return;
    this.renderOrefAlerts(data);
  }

  private renderIranEvents(events: import('@/generated/client/worldmonitor/conflict/v1/service_client').IranEvent[]): void {
    this.ctx.intelligenceCache.iranEvents = events;
    this.ctx.map?.setIranEvents(events);
    this.ctx.map?.setLayerReady('iranAttacks', events.length > 0);
    const coerced = events.map(e => ({ ...e, timestamp: Number(e.timestamp) || 0 }));
    signalAggregator.ingestConflictEvents(coerced);
    ingestStrikesForCII(coerced);
    (this.ctx.panels['cii'] as CIIPanel)?.refresh();
  }

  applyIranEvents(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const resp = payload as { events?: import('@/generated/client/worldmonitor/conflict/v1/service_client').IranEvent[] };
    if (!Array.isArray(resp.events)) return;
    this.renderIranEvents(resp.events);
  }

  private renderTechEvents(data: import('@/generated/client/worldmonitor/research/v1/service_client').ListTechEventsResponse): void {
    if (!data.success || !Array.isArray(data.events)) return;
    const now = new Date();
    const mapEvents = data.events.map((e: { id: string; title: string; location: string; coords?: { lat: number; lng: number; country: string }; startDate: string; endDate: string; url: string }) => ({
      id: e.id,
      title: e.title,
      location: e.location,
      lat: e.coords?.lat ?? 0,
      lng: e.coords?.lng ?? 0,
      country: e.coords?.country ?? '',
      startDate: e.startDate,
      endDate: e.endDate,
      url: e.url,
      daysUntil: Math.ceil((new Date(e.startDate).getTime() - now.getTime()) / (1000 * 60 * 60 * 24)),
    }));
    this.ctx.map?.setTechEvents(mapEvents);
    this.ctx.map?.setLayerReady('techEvents', mapEvents.length > 0);
    (this.ctx.panels['events'] as TechEventsPanel | undefined)?.setEvents(data.events);
    this.ctx.statusPanel?.updateFeed('Tech Events', { status: 'ok', itemCount: mapEvents.length });
    if (SITE_VARIANT === 'tech' && this.ctx.searchModal) {
      this.ctx.searchModal.registerSource('techevent', mapEvents.map((e: { id: string; title: string; location: string; startDate: string }) => ({
        id: e.id,
        title: e.title,
        subtitle: `${e.location} • ${new Date(e.startDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`,
        data: e,
      })));
    }
  }

  applyTechEvents(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const data = payload as import('@/generated/client/worldmonitor/research/v1/service_client').ListTechEventsResponse;
    if (!('events' in data) || !Array.isArray(data.events)) return;
    this.renderTechEvents(data);
  }

  private renderGpsInterference(data: import('@/services/gps-interference').GpsJamData): void {
    ingestGpsJammingForCII(data.hexes);
    if (this.ctx.mapLayers.gpsJamming) {
      this.ctx.map?.setGpsJamming(data.hexes);
      this.ctx.map?.setLayerReady('gpsJamming', data.hexes.length > 0);
    }
    this.ctx.statusPanel?.updateFeed('GPS Jam', { status: 'ok', itemCount: data.hexes.length });
    dataFreshness.recordUpdate('gpsjam', data.hexes.length);
  }

  applyGpsInterference(payload: unknown): void {
    const data = parseGpsJamPayload(payload);
    if (!data) return;
    this.renderGpsInterference(data);
  }

  applyGulfQuotes(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const data = payload as ListGulfQuotesResponse;
    if (!Array.isArray(data.quotes)) return;
    (this.ctx.panels['gulf-economies'] as GulfEconomiesPanel)?.setData(data);
  }

  private mergeAndRenderNaturalEvents(): void {
    const eonet = this.ctx.intelligenceCache.eonetEvents ?? [];
    const gdacs = this.ctx.intelligenceCache.gdacsEvents ?? [];
    const seen = new Set<string>();
    const merged: import('@/types').NaturalEvent[] = [];
    for (const e of [...gdacs, ...eonet]) {
      const key = `${e.lat.toFixed(1)}-${e.lon.toFixed(1)}-${e.category}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(e);
      }
    }
    this.ctx.map?.setNaturalEvents(merged);
    this.ctx.statusPanel?.updateFeed('EONET', { status: 'ok', itemCount: merged.length });
    this.ctx.statusPanel?.updateApi('NASA EONET', { status: 'ok' });
    this.ctx.map?.setLayerReady('natural', merged.length > 0);
  }

  applyEonet(payload: unknown): void {
    if (!payload || !Array.isArray(payload)) return;
    const events = payload as import('@/types').NaturalEvent[];
    const valid = events.filter((e): e is import('@/types').NaturalEvent =>
      e && typeof e === 'object' && typeof e.lat === 'number' && typeof e.lon === 'number' && typeof e.id === 'string');
    this.ctx.intelligenceCache.eonetEvents = valid;
    this.mergeAndRenderNaturalEvents();
  }

  applyGdacs(payload: unknown): void {
    if (!payload || !Array.isArray(payload)) return;
    const raw = payload as unknown[];
    const GDACS_TO_CATEGORY: Record<string, import('@/types').NaturalEventCategory> = {
      EQ: 'earthquakes', FL: 'floods', TC: 'severeStorms', VO: 'volcanoes', WF: 'wildfires', DR: 'drought',
    };
    const events: import('@/types').NaturalEvent[] = [];
    for (const item of raw) {
      const g = item as Record<string, unknown>;
      if (!g || typeof g !== 'object' || !g.id || !g.coordinates || !Array.isArray(g.coordinates)) continue;
      const coords = g.coordinates as [number, number];
      const eventType = String(g.eventType ?? '');
      const category = GDACS_TO_CATEGORY[eventType] || 'manmade';
      events.push({
        id: String(g.id),
        title: `${g.alertLevel === 'Red' ? '🔴 ' : g.alertLevel === 'Orange' ? '🟠 ' : ''}${String(g.name ?? '')}`,
        description: `${String(g.description ?? '')}${g.severity ? ` - ${g.severity}` : ''}`,
        category,
        categoryTitle: String(g.description ?? ''),
        lat: coords[1],
        lon: coords[0],
        date: g.fromDate ? new Date(g.fromDate as string) : new Date(),
        sourceUrl: g.url ? String(g.url) : undefined,
        sourceName: 'GDACS',
        closed: false,
      });
    }
    this.ctx.intelligenceCache.gdacsEvents = events;
    this.mergeAndRenderNaturalEvents();
  }
}
