import type { AppContext, AppModule } from '@/app/app-context';
import { CHANNEL_REGISTRY } from '@/config/channel-registry';
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
import { newsLoader } from '@/data/news-loader';
import { marketsLoader } from '@/data/markets-loader';
import { geoLoader } from '@/data/geo-loader';
import { intelligenceLoader } from '@/data/intelligence-loader';
import { infrastructureLoader } from '@/data/infrastructure-loader';
import { economicLoader } from '@/data/economic-loader';
import type { MapLayers } from '@/types';
import { getHydratedData } from '@/services/bootstrap';
import { fetchRelayPanel } from '@/services/relay-http';
import { syncDataFreshnessWithLayers } from '@/services/data-freshness-sync';
import { runCorrelationAnalysis } from '@/services/run-correlation-analysis';
import type { ListFireDetectionsResponse } from '@/generated/client/worldmonitor/wildfire/v1/service_client';
import type { TheaterPostureSummary } from '@/services/military-surge';
import type { MonitorPanel } from '@/components/MonitorPanel';
import type { DataLoaderBridge } from '@/data/loader-bridge';
import { newsStore } from '@/stores/news-store';
import type { CommodityDataItem } from '@/data/types';

export interface DataLoaderCallbacks {
  renderCriticalBanner: (postures: TheaterPostureSummary[]) => void;
}

export class DataLoaderManager implements AppModule, DataLoaderBridge {
  private _ctx: AppContext;
  private _callbacks: DataLoaderCallbacks;
  private sourcesReady: Promise<void> = Promise.resolve();
  public updateSearchIndex: () => void = () => {};
  private domainHandlers: Record<string, (payload: unknown) => void>;
  private _firesCache: ListFireDetectionsResponse | null = null;
  private _lastCommodityData: CommodityDataItem[] = [];

  get ctx() { return this._ctx; }
  get callbacks() { return this._callbacks; }
  renderCriticalBanner(postures: unknown[]) { this._callbacks.renderCriticalBanner(postures as TheaterPostureSummary[]); }
  getSourcesReady() { return this.sourcesReady; }
  getFiresCache() { return this._firesCache; }
  setFiresCache(data: ListFireDetectionsResponse | null) { this._firesCache = data; }
  getLastCommodityData() { return this._lastCommodityData; }
  setLastCommodityData(data: CommodityDataItem[]) { this._lastCommodityData = data; }
  shouldShowIntelligenceNotifications() { return !this._ctx.isMobile && !!this._ctx.findingsBadge?.isPopupEnabled(); }

  constructor(ctx: AppContext, callbacks: DataLoaderCallbacks) {
    this._ctx = ctx;
    this._callbacks = callbacks;
    const newsCallbacks = {
      onNewsDigestProcessed: () => {
        void newsLoader.loadHappySupplementaryAndRender(this).then(() =>
          Promise.allSettled([
            this._ctx.mapLayers.positiveEvents ? geoLoader.loadPositiveEvents(this._ctx) : Promise.resolve(),
            this._ctx.mapLayers.kindness ? Promise.resolve(newsLoader.loadKindnessData(this._ctx)) : Promise.resolve(),
          ])
        );
      },
    };
    const marketsCallbacks = {
      onPredictionsRendered: () => runCorrelationAnalysis(this._ctx, { shouldShowNotifications: () => this.shouldShowIntelligenceNotifications() }),
      onMarketsRendered: (data: CommodityDataItem[]) => { this._lastCommodityData = data; },
    };
    const geoCallbacks = {
      onNaturalApplied: (data: ListFireDetectionsResponse) => { this._firesCache = data; },
    };
    this.domainHandlers = {
      ...createNewsHandlers(ctx, newsCallbacks),
      ...createMarketsHandlers(ctx, marketsCallbacks),
      ...createEconomicHandlers(ctx),
      ...createIntelligenceHandlers(ctx),
      ...createGeoHandlers(ctx, geoCallbacks),
      ...createInfrastructureHandlers(ctx),
      ...createAiHandlers(ctx),
      ...createConfigHandlers(ctx),
    };
  }

  getHandler(channel: string): ((payload: unknown) => void) | undefined {
    return this.domainHandlers[channel];
  }

  setSourcesReady(promise: Promise<unknown>): void {
    this.sourcesReady = promise.then(() => {}).catch(() => {});
  }

  init(): void {}
  destroy(): void {}

  /** Alternate hydration keys (camelCase) used by some relays (e.g. ais-relay) when bootstrap returns data. */
  private static readonly HYDRATION_ALIASES: Record<string, string> = {
    'strategic-posture': 'strategicPosture',
    'strategic-risk': 'strategicRisk',
    'conflict': 'acledEvents',
    'ais': 'aisSnapshot',
    'climate': 'climateAnomalies',
    'gps-interference': 'gpsInterference',
    'ucdp-events': 'ucdpEvents',
    'supply-chain': 'chokepoints',
    'etf-flows': 'etfFlows',
    'macro-signals': 'macroSignals',
    'service-status': 'serviceStatuses',
  };

  async loadChannelWithFallback<T>(channel: string, renderFn: (data: T) => void): Promise<boolean> {
    const alias = DataLoaderManager.HYDRATION_ALIASES[channel];
    const hydrated = getHydratedData(channel) ?? (alias ? getHydratedData(alias) : undefined);
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

  async loadAllData(): Promise<void> {
    for (const [channel] of Object.entries(CHANNEL_REGISTRY)) {
      const alias = DataLoaderManager.HYDRATION_ALIASES[channel];
      const data = getHydratedData(channel) ?? (alias ? getHydratedData(alias) : undefined);
      if (data !== undefined && data !== null) {
        const handler = this.domainHandlers[channel];
        if (handler) {
          try {
            handler(data);
          } catch (err) {
            console.warn(`[DataLoader] handler error draining "${channel}":`, err);
          }
        }
      }
    }
    this.updateSearchIndex();
  }

  async loadDataForLayer(layer: keyof MapLayers): Promise<void> {
    if (this._ctx.isDestroyed || this._ctx.inFlight.has(layer)) return;
    this._ctx.inFlight.add(layer);
    this._ctx.map?.setLayerLoading(layer, true);
    try {
      switch (layer) {
        case 'natural':
          await geoLoader.loadNatural(this);
          break;
        case 'fires':
          await geoLoader.loadFirmsData(this);
          break;
        case 'weather':
          await geoLoader.loadWeatherAlerts(this);
          break;
        case 'outages':
          await infrastructureLoader.loadOutages(this);
          break;
        case 'cyberThreats':
          await infrastructureLoader.loadCyberThreats(this);
          break;
        case 'ais':
          await infrastructureLoader.loadAisSignals(this);
          break;
        case 'cables':
          await Promise.all([infrastructureLoader.loadCableActivity(this._ctx), infrastructureLoader.loadCableHealth(this)]);
          break;
        case 'protests':
          await intelligenceLoader.loadProtests(this);
          break;
        case 'flights':
          await infrastructureLoader.loadFlightDelays(this);
          break;
        case 'military':
          await intelligenceLoader.loadMilitary(this);
          break;
        case 'techEvents':
          await geoLoader.loadTechEvents(this);
          break;
        case 'positiveEvents':
          await geoLoader.loadPositiveEvents(this._ctx);
          break;
        case 'kindness':
          newsLoader.loadKindnessData(this._ctx);
          break;
        case 'iranAttacks':
          await intelligenceLoader.loadIranEvents(this);
          break;
        case 'ucdpEvents':
        case 'displacement':
        case 'climate':
        case 'gpsJamming':
          await intelligenceLoader.loadIntelligenceSignals(this);
          break;
      }
    } finally {
      this._ctx.inFlight.delete(layer);
      this._ctx.map?.setLayerLoading(layer, false);
    }
  }

  async loadNews(): Promise<void> {
    await newsLoader.loadNews(this);
  }

  async loadMarkets(): Promise<void> {
    await marketsLoader.loadMarkets(this);
  }

  async loadGiving(): Promise<void> {
    await economicLoader.loadGiving(this);
  }

  async hydrateHappyPanelsFromCache(): Promise<void> {
    await newsLoader.hydrateHappyPanelsFromCache(this._ctx);
  }

  waitForAisData(): void {
    infrastructureLoader.waitForAisData(this);
  }

  async loadSecurityAdvisories(): Promise<void> {
    await intelligenceLoader.loadSecurityAdvisories(this._ctx);
  }

  syncDataFreshnessWithLayers(): void {
    syncDataFreshnessWithLayers(this._ctx.mapLayers);
  }

  updateMonitorResults(): void {
    (this._ctx.panels['monitors'] as MonitorPanel).renderResults(newsStore.allNews);
  }

  async runCorrelationAnalysis(): Promise<void> {
    await runCorrelationAnalysis(this._ctx, { shouldShowNotifications: () => this.shouldShowIntelligenceNotifications() });
  }
}
