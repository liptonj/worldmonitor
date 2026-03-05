import type { Monitor, PanelConfig, MapLayers } from '@/types';
import type { AppContext } from '@/app/app-context';
import {
  DEFAULT_PANELS,
  DEFAULT_MAP_LAYERS,
  MOBILE_DEFAULT_MAP_LAYERS,
  STORAGE_KEYS,
  SITE_VARIANT,
} from '@/config';
import { initDB, cleanOldSnapshots, isAisConfigured, initAisStream, isOutagesConfigured, disconnectAisStream } from '@/services';
import { mlWorker } from '@/services/ml-worker';
import { getAiFlowSettings, subscribeAiFlowChange, isHeadlineMemoryEnabled } from '@/services/ai-flow-settings';
import { startLearning } from '@/services/country-instability';
import { dataFreshness } from '@/services/data-freshness';
import { loadFromStorage, parseMapUrlState, saveToStorage, isMobileDevice } from '@/utils';
import type { ParsedMapUrlState } from '@/utils';
import { SignalModal, IntelligenceGapBadge, BreakingNewsBanner } from '@/components';
import { initBreakingNewsAlerts, destroyBreakingNewsAlerts } from '@/services/breaking-news-alerts';
import { isDesktopRuntime } from '@/services/runtime';
import { BETA_MODE } from '@/config/beta';
import { trackEvent, trackDeeplinkOpened } from '@/services/analytics';
import { preloadCountryGeometry, getCountryNameByCode } from '@/services/country-geometry';
import { initI18n } from '@/services/i18n';

import { computeDefaultDisabledSources, getLocaleBoostedSources, getTotalFeedCount, loadNewsSources } from '@/services/feed-client';
import { loadFeatureFlags } from '@/services/feature-flag-client';
import { fetchBootstrapData } from '@/services/bootstrap';
import { DesktopUpdater } from '@/app/desktop-updater';
import { CountryIntelManager } from '@/app/country-intel';
import { SearchManager } from '@/app/search-manager';
import { PanelLayoutManager } from '@/app/panel-layout';
import { DataLoaderManager } from '@/app/data-loader';
import { EventHandlerManager } from '@/app/event-handlers';
import { resolveUserRegion } from '@/utils/user-location';
import { initDisplayPrefs } from '@/utils/display-prefs';
import { initRelayPush, subscribe as subscribeRelayPush, destroyRelayPush } from '@/services/relay-push';

const CYBER_LAYER_ENABLED = import.meta.env.VITE_ENABLE_CYBER_LAYER === 'true';

export type { CountryBriefSignals } from '@/app/app-context';

export class App {
  private state: AppContext;
  private pendingDeepLinkCountry: string | null = null;
  private pendingDeepLinkExpanded = false;

  private panelLayout: PanelLayoutManager;
  private dataLoader: DataLoaderManager;
  private eventHandlers: EventHandlerManager;
  private searchManager: SearchManager;
  private countryIntel: CountryIntelManager;
  private desktopUpdater: DesktopUpdater;

  private modules: { destroy(): void }[] = [];
  private unsubAiFlow: (() => void) | null = null;

  constructor(containerId: string) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Container ${containerId} not found`);

    const PANEL_ORDER_KEY = 'panel-order';
    const PANEL_SPANS_KEY = 'worldmonitor-panel-spans';

    const isMobile = isMobileDevice();
    const isDesktopApp = isDesktopRuntime();
    const monitors = loadFromStorage<Monitor[]>(STORAGE_KEYS.monitors, []);

    // Use mobile-specific defaults on first load (no saved layers)
    const defaultLayers = isMobile ? MOBILE_DEFAULT_MAP_LAYERS : DEFAULT_MAP_LAYERS;

    let mapLayers: MapLayers;
    let panelSettings: Record<string, PanelConfig>;

    // Check if variant changed - reset all settings to variant defaults
    const storedVariant = localStorage.getItem('worldmonitor-variant');
    const currentVariant = SITE_VARIANT;
    console.log(`[App] Variant check: stored="${storedVariant}", current="${currentVariant}"`);
    if (storedVariant !== currentVariant) {
      // Variant changed - use defaults for new variant, clear old settings
      console.log('[App] Variant changed - resetting to defaults');
      localStorage.setItem('worldmonitor-variant', currentVariant);
      localStorage.removeItem(STORAGE_KEYS.mapLayers);
      localStorage.removeItem(STORAGE_KEYS.panels);
      localStorage.removeItem(PANEL_ORDER_KEY);
      localStorage.removeItem(PANEL_SPANS_KEY);
      mapLayers = { ...defaultLayers };
      panelSettings = { ...DEFAULT_PANELS };
    } else {
      mapLayers = loadFromStorage<MapLayers>(STORAGE_KEYS.mapLayers, defaultLayers);
      // Happy variant: force non-happy layers off even if localStorage has stale true values
      if (currentVariant === 'happy') {
        const unhappyLayers: (keyof MapLayers)[] = ['conflicts', 'bases', 'hotspots', 'nuclear', 'irradiators', 'sanctions', 'military', 'protests', 'pipelines', 'waterways', 'ais', 'flights', 'spaceports', 'minerals', 'natural', 'fires', 'outages', 'cyberThreats', 'weather', 'economic', 'cables', 'datacenters', 'ucdpEvents', 'displacement', 'climate', 'iranAttacks'];
        unhappyLayers.forEach(layer => { mapLayers[layer] = false; });
      }
      panelSettings = loadFromStorage<Record<string, PanelConfig>>(
        STORAGE_KEYS.panels,
        DEFAULT_PANELS
      );
      // Merge in any new panels that didn't exist when settings were saved
      for (const [key, config] of Object.entries(DEFAULT_PANELS)) {
        if (!(key in panelSettings)) {
          panelSettings[key] = { ...config };
        }
      }
      console.log('[App] Loaded panel settings from storage:', Object.entries(panelSettings).filter(([_, v]) => !v.enabled).map(([k]) => k));

      // One-time migration: reorder panels for existing users (v1.9 panel layout)
      const PANEL_ORDER_MIGRATION_KEY = 'worldmonitor-panel-order-v1.9';
      if (!localStorage.getItem(PANEL_ORDER_MIGRATION_KEY)) {
        const savedOrder = localStorage.getItem(PANEL_ORDER_KEY);
        if (savedOrder) {
          try {
            const order: string[] = JSON.parse(savedOrder);
            const priorityPanels = ['insights', 'strategic-posture', 'cii', 'strategic-risk'];
            const filtered = order.filter(k => !priorityPanels.includes(k) && k !== 'live-news');
            const liveNewsIdx = order.indexOf('live-news');
            const newOrder = liveNewsIdx !== -1 ? ['live-news'] : [];
            newOrder.push(...priorityPanels.filter(p => order.includes(p)));
            newOrder.push(...filtered);
            localStorage.setItem(PANEL_ORDER_KEY, JSON.stringify(newOrder));
            console.log('[App] Migrated panel order to v1.8 layout');
          } catch {
            // Invalid saved order, will use defaults
          }
        }
        localStorage.setItem(PANEL_ORDER_MIGRATION_KEY, 'done');
      }

      // Tech variant migration: move insights to top (after live-news)
      if (currentVariant === 'tech') {
        const TECH_INSIGHTS_MIGRATION_KEY = 'worldmonitor-tech-insights-top-v1';
        if (!localStorage.getItem(TECH_INSIGHTS_MIGRATION_KEY)) {
          const savedOrder = localStorage.getItem(PANEL_ORDER_KEY);
          if (savedOrder) {
            try {
              const order: string[] = JSON.parse(savedOrder);
              const filtered = order.filter(k => k !== 'insights' && k !== 'live-news');
              const newOrder: string[] = [];
              if (order.includes('live-news')) newOrder.push('live-news');
              if (order.includes('insights')) newOrder.push('insights');
              newOrder.push(...filtered);
              localStorage.setItem(PANEL_ORDER_KEY, JSON.stringify(newOrder));
              console.log('[App] Tech variant: Migrated insights panel to top');
            } catch {
              // Invalid saved order, will use defaults
            }
          }
          localStorage.setItem(TECH_INSIGHTS_MIGRATION_KEY, 'done');
        }
      }
    }

    // One-time migration: clear stale panel ordering and sizing state
    const LAYOUT_RESET_MIGRATION_KEY = 'worldmonitor-layout-reset-v2.5';
    if (!localStorage.getItem(LAYOUT_RESET_MIGRATION_KEY)) {
      const hadSavedOrder = !!localStorage.getItem(PANEL_ORDER_KEY);
      const hadSavedSpans = !!localStorage.getItem(PANEL_SPANS_KEY);
      if (hadSavedOrder || hadSavedSpans) {
        localStorage.removeItem(PANEL_ORDER_KEY);
        localStorage.removeItem(PANEL_SPANS_KEY);
        console.log('[App] Applied layout reset migration (v2.5): cleared panel order/spans');
      }
      localStorage.setItem(LAYOUT_RESET_MIGRATION_KEY, 'done');
    }

    // Desktop key management panel must always remain accessible in Tauri.
    if (isDesktopApp) {
      const runtimePanel = panelSettings['runtime-config'] ?? {
        name: 'Desktop Configuration',
        enabled: true,
        priority: 2,
      };
      runtimePanel.enabled = true;
      panelSettings['runtime-config'] = runtimePanel;
      saveToStorage(STORAGE_KEYS.panels, panelSettings);
    }

    let initialUrlState: ParsedMapUrlState | null = parseMapUrlState(window.location.search, mapLayers);
    if (initialUrlState.layers) {
      if (currentVariant === 'tech') {
        const geoLayers: (keyof MapLayers)[] = ['conflicts', 'bases', 'hotspots', 'nuclear', 'irradiators', 'sanctions', 'military', 'protests', 'pipelines', 'waterways', 'ais', 'flights', 'spaceports', 'minerals'];
        const urlLayers = initialUrlState.layers;
        geoLayers.forEach(layer => {
          urlLayers[layer] = false;
        });
      }
      // For happy variant, force off all non-happy layers (including natural events)
      if (currentVariant === 'happy') {
        const unhappyLayers: (keyof MapLayers)[] = ['conflicts', 'bases', 'hotspots', 'nuclear', 'irradiators', 'sanctions', 'military', 'protests', 'pipelines', 'waterways', 'ais', 'flights', 'spaceports', 'minerals', 'natural', 'fires', 'outages', 'cyberThreats', 'weather', 'economic', 'cables', 'datacenters', 'ucdpEvents', 'displacement', 'climate', 'iranAttacks'];
        const urlLayers = initialUrlState.layers;
        unhappyLayers.forEach(layer => {
          urlLayers[layer] = false;
        });
      }
      mapLayers = initialUrlState.layers;
    }
    if (!CYBER_LAYER_ENABLED) {
      mapLayers.cyberThreats = false;
    }
    // One-time migration: reduce default-enabled sources (full variant only)
    if (currentVariant === 'full') {
      const baseKey = 'worldmonitor-sources-reduction-v3';
      if (!localStorage.getItem(baseKey)) {
        const defaultDisabled = computeDefaultDisabledSources();
        saveToStorage(STORAGE_KEYS.disabledFeeds, defaultDisabled);
        localStorage.setItem(baseKey, 'done');
        const total = getTotalFeedCount();
        console.log(`[App] Sources reduction: ${defaultDisabled.length} disabled, ${total - defaultDisabled.length} enabled`);
      }
      // Locale boost: additively enable locale-matched sources (runs once per locale)
      const userLang = ((navigator.language ?? 'en').split('-')[0] ?? 'en').toLowerCase();
      const localeKey = `worldmonitor-locale-boost-${userLang}`;
      if (userLang !== 'en' && !localStorage.getItem(localeKey)) {
        const boosted = getLocaleBoostedSources(userLang);
        if (boosted.size > 0) {
          const current = loadFromStorage<string[]>(STORAGE_KEYS.disabledFeeds, []);
          const updated = current.filter(name => !boosted.has(name));
          saveToStorage(STORAGE_KEYS.disabledFeeds, updated);
          console.log(`[App] Locale boost (${userLang}): enabled ${current.length - updated.length} sources`);
        }
        localStorage.setItem(localeKey, 'done');
      }
    }

    const disabledSources = new Set(loadFromStorage<string[]>(STORAGE_KEYS.disabledFeeds, []));

    // Build shared state object
    this.state = {
      map: null,
      isMobile,
      isDesktopApp,
      container: el,
      panels: {},
      newsPanels: {},
      panelSettings,
      mapLayers,
      allNews: [],
      newsByCategory: {},
      latestMarkets: [],
      latestPredictions: [],
      latestClusters: [],
      intelligenceCache: {},
      cyberThreatsCache: null,
      disabledSources,
      currentTimeRange: '7d',
      inFlight: new Set(),
      seenGeoAlerts: new Set(),
      monitors,
      signalModal: null,
      statusPanel: null,
      searchModal: null,
      findingsBadge: null,
      breakingBanner: null,
      playbackControl: null,
      exportPanel: null,
      unifiedSettings: null,
      mobileWarningModal: null,
      pizzintIndicator: null,
      countryBriefPage: null,
      countryTimeline: null,
      positivePanel: null,
      countersPanel: null,
      progressPanel: null,
      breakthroughsPanel: null,
      heroPanel: null,
      digestPanel: null,
      speciesPanel: null,
      renewablePanel: null,
      tvMode: null,
      happyAllItems: [],
      isDestroyed: false,
      isPlaybackMode: false,
      isIdle: false,
      initialLoadComplete: false,
      resolvedLocation: 'global',
      initialUrlState,
      PANEL_ORDER_KEY,
      PANEL_SPANS_KEY,
    };

    // Instantiate modules (callbacks wired after all modules exist)
    this.countryIntel = new CountryIntelManager(this.state);
    this.desktopUpdater = new DesktopUpdater(this.state);

    this.dataLoader = new DataLoaderManager(this.state, {
      renderCriticalBanner: (postures) => this.panelLayout.renderCriticalBanner(postures),
    });

    this.searchManager = new SearchManager(this.state, {
      openCountryBriefByCode: (code, country) => this.countryIntel.openCountryBriefByCode(code, country),
    });

    this.panelLayout = new PanelLayoutManager(this.state, {
      openCountryStory: (code, name) => this.countryIntel.openCountryStory(code, name),
      loadAllData: () => this.dataLoader.loadAllData(),
      updateMonitorResults: () => this.dataLoader.updateMonitorResults(),
      loadSecurityAdvisories: () => this.dataLoader.loadSecurityAdvisories(),
    });

    this.eventHandlers = new EventHandlerManager(this.state, {
      updateSearchIndex: () => this.searchManager.updateSearchIndex(),
      loadAllData: () => this.dataLoader.loadAllData(),
      flushStaleRefreshes: () => {},
      setHiddenSince: () => {},
      loadDataForLayer: (layer) => { void this.dataLoader.loadDataForLayer(layer as keyof MapLayers); },
      waitForAisData: () => this.dataLoader.waitForAisData(),
      syncDataFreshnessWithLayers: () => this.dataLoader.syncDataFreshnessWithLayers(),
      ensureCorrectZones: () => this.panelLayout.ensureCorrectZones(),
    });

    // Wire cross-module callback: DataLoader → SearchManager
    this.dataLoader.updateSearchIndex = () => this.searchManager.updateSearchIndex();

    // Track destroy order (reverse of init)
    this.modules = [
      this.desktopUpdater,
      this.panelLayout,
      this.countryIntel,
      this.searchManager,
      this.dataLoader,
      this.eventHandlers,
    ];
  }

  public async init(): Promise<void> {
    const initStart = performance.now();
    performance.mark('wm:init-start');

    // ── PHASE 1: Minimum for UI shell (only hard await) ──
    await initI18n();

    performance.mark('wm:i18n-done');

    // ── PHASE 2: Fire-and-forget — not needed for first paint ──
    void initDB().catch((e) => console.warn('[Storage] initDB failed:', e));

    const aiFlow = getAiFlowSettings();
    if (aiFlow.browserModel || isDesktopRuntime()) {
      void mlWorker.init().then(() => {
        if (BETA_MODE) mlWorker.loadModel('summarization-beta').catch(() => {});
      }).catch(() => {});
    }
    if (aiFlow.headlineMemory) {
      void mlWorker.init().then(ok => {
        if (ok) mlWorker.loadModel('embeddings').catch(() => {});
      }).catch(() => {});
    }

    this.unsubAiFlow = subscribeAiFlowChange((key) => {
      if (key === 'browserModel') {
        const s = getAiFlowSettings();
        if (s.browserModel) {
          void mlWorker.init().catch(() => {});
        } else if (!isHeadlineMemoryEnabled()) {
          mlWorker.terminate();
        }
      }
      if (key === 'headlineMemory') {
        if (isHeadlineMemoryEnabled()) {
          mlWorker.init().then(ok => {
            if (ok) mlWorker.loadModel('embeddings').catch(() => {});
          }).catch(() => {});
        } else {
          mlWorker.unloadModel('embeddings').catch(() => {});
          const s = getAiFlowSettings();
          if (!s.browserModel && !isDesktopRuntime()) {
            mlWorker.terminate();
          }
        }
      }
    });

    if (!isAisConfigured()) {
      this.state.mapLayers.ais = false;
    } else if (this.state.mapLayers.ais) {
      initAisStream();
    }

    void resolveUserRegion()
      .then(region => {
        this.state.resolvedLocation = region;
        if (this.state.isMobile && region !== 'global' && this.state.map) {
          this.state.map.setView(region);
          const regionSelect = document.getElementById('regionSelect') as HTMLSelectElement;
          if (regionSelect) regionSelect.value = region;
        }
      })
      .catch(() => {});

    // ── PHASE 3: Render UI shell immediately ──
    this.panelLayout.init();

    // Display prefs: fetch admin defaults in background — never blocks first paint.
    // localStorage values (getTimeFormat/getTimezoneMode/getTempUnit) already work without
    // this. When it resolves, adminDefaults is set; components read new values on next access.
    void initDisplayPrefs().catch(() => {});

    performance.mark('wm:layout-done');
    performance.measure('wm:to-layout', 'wm:init-start', 'wm:layout-done');

    if (SITE_VARIANT === 'happy') {
      await this.dataLoader.hydrateHappyPanelsFromCache();
    }

    // Phase 3b: Shared UI components + event listeners (all sync, fast)
    this.state.signalModal = new SignalModal();
    this.state.signalModal.setLocationClickHandler((lat, lon) => {
      this.state.map?.setCenter(lat, lon, 4);
    });
    if (!this.state.isMobile) {
      this.state.findingsBadge = new IntelligenceGapBadge();
      this.state.findingsBadge.setOnSignalClick((signal) => {
        if (this.state.countryBriefPage?.isVisible()) return;
        if (localStorage.getItem('wm-settings-open') === '1') return;
        this.state.signalModal?.showSignal(signal);
      });
      this.state.findingsBadge.setOnAlertClick((alert) => {
        if (this.state.countryBriefPage?.isVisible()) return;
        if (localStorage.getItem('wm-settings-open') === '1') return;
        this.state.signalModal?.showAlert(alert);
      });
    }

    if (!this.state.isMobile) {
      initBreakingNewsAlerts();
      this.state.breakingBanner = new BreakingNewsBanner();
    }

    this.eventHandlers.startHeaderClock();
    this.eventHandlers.setupMobileWarning();
    this.eventHandlers.setupPlaybackControl();
    this.eventHandlers.setupStatusPanel();
    this.eventHandlers.setupPizzIntIndicator();
    this.eventHandlers.setupExportPanel();
    this.eventHandlers.setupUnifiedSettings();
    this.eventHandlers.setupSummarizeView();

    this.searchManager.init();
    this.eventHandlers.setupMapLayerHandlers();
    this.countryIntel.init();

    this.eventHandlers.init();
    const initState = parseMapUrlState(window.location.search, this.state.mapLayers);
    this.pendingDeepLinkCountry = initState.country ?? null;
    this.pendingDeepLinkExpanded = initState.expanded === true;
    this.eventHandlers.setupUrlStateSync();

    this.state.countryBriefPage?.onStateChange?.(() => {
      this.eventHandlers.syncUrlState();
    });

    // ── PHASE 4: Data loading (no longer blocking UI) ──
    this.dataLoader.syncDataFreshnessWithLayers();
    void preloadCountryGeometry().catch(() => {});

    await fetchBootstrapData(SITE_VARIANT || 'full');
    // Fire sources and flags immediately — no await. loadNews() waits for them
    // internally (up to 3s) via the sourcesReady promise. Every other task
    // (markets, predictions, fred, bis, etc.) runs immediately without waiting.
    const sourcesReady = Promise.all([loadNewsSources(), loadFeatureFlags()]);
    this.dataLoader.setSourcesReady(sourcesReady);

    performance.mark('wm:bootstrap-done');
    performance.measure('wm:bootstrap', 'wm:layout-done', 'wm:bootstrap-done');

    startLearning();

    // Hide unconfigured layers after first data load
    if (!isAisConfigured()) {
      this.state.map?.hideLayerToggle('ais');
    }
    if (isOutagesConfigured() === false) {
      this.state.map?.hideLayerToggle('outages');
    }
    if (!CYBER_LAYER_ENABLED) {
      this.state.map?.hideLayerToggle('cyberThreats');
    }

    this.setupRelayPush();
    this.eventHandlers.setupSnapshotSaving();
    cleanOldSnapshots().catch((e) => console.warn('[Storage] Snapshot cleanup failed:', e));

    this.handleDeepLinks();
    this.desktopUpdater.init();

    trackEvent('wm_app_loaded', {
      load_time_ms: Math.round(performance.now() - initStart),
      panel_count: Object.keys(this.state.panels).length,
    });
    this.eventHandlers.setupPanelViewTracking();
  }

  public destroy(): void {
    this.state.isDestroyed = true;
    destroyRelayPush();

    // Destroy all modules in reverse order
    for (let i = this.modules.length - 1; i >= 0; i--) {
      this.modules[i]!.destroy();
    }

    // Clean up subscriptions, map, AIS, and breaking news
    this.unsubAiFlow?.();
    this.state.breakingBanner?.destroy();
    destroyBreakingNewsAlerts();
    this.state.map?.destroy();
    disconnectAisStream();
  }

  private handleDeepLinks(): void {
    const url = new URL(window.location.href);
    const MAX_DEEP_LINK_RETRIES = 60;
    const DEEP_LINK_RETRY_INTERVAL_MS = 500;
    const DEEP_LINK_INITIAL_DELAY_MS = 2000;

    // Check for story deep link: /story?c=UA&t=ciianalysis
    if (url.pathname === '/story' || url.searchParams.has('c')) {
      const countryCode = url.searchParams.get('c');
      if (countryCode) {
        trackDeeplinkOpened('story', countryCode);
        const countryName = getCountryNameByCode(countryCode.toUpperCase()) || countryCode;

        let attempts = 0;
        const checkAndOpen = () => {
          if (dataFreshness.hasSufficientData() && this.state.latestClusters.length > 0) {
            this.countryIntel.openCountryStory(countryCode.toUpperCase(), countryName);
            return;
          }
          attempts += 1;
          if (attempts >= MAX_DEEP_LINK_RETRIES) {
            this.eventHandlers.showToast('Data not available');
            return;
          } else {
            setTimeout(checkAndOpen, DEEP_LINK_RETRY_INTERVAL_MS);
          }
        };
        setTimeout(checkAndOpen, DEEP_LINK_INITIAL_DELAY_MS);

        history.replaceState(null, '', '/');
        return;
      }
    }

    // Check for country brief deep link: ?country=UA or ?country=UA&expanded=1
    const deepLinkCountry = this.pendingDeepLinkCountry;
    const deepLinkExpanded = this.pendingDeepLinkExpanded;
    this.pendingDeepLinkCountry = null;
    this.pendingDeepLinkExpanded = false;
    if (deepLinkCountry) {
      trackDeeplinkOpened('country', deepLinkCountry);
      const cName = CountryIntelManager.resolveCountryName(deepLinkCountry);
      let attempts = 0;
      const checkAndOpenBrief = () => {
        if (dataFreshness.hasSufficientData()) {
          this.countryIntel.openCountryBriefByCode(deepLinkCountry, cName, {
            maximize: deepLinkExpanded,
          });
          this.eventHandlers.syncUrlState();
          return;
        }
        attempts += 1;
        if (attempts >= MAX_DEEP_LINK_RETRIES) {
          this.eventHandlers.showToast('Data not available');
          return;
        } else {
          setTimeout(checkAndOpenBrief, DEEP_LINK_RETRY_INTERVAL_MS);
        }
      };
      setTimeout(checkAndOpenBrief, DEEP_LINK_INITIAL_DELAY_MS);
    }
  }

  private setupRelayPush(): void {
    const variant = SITE_VARIANT || 'full';
    const channels = [
      `news:${variant}`,
      'markets',
      'predictions',
      'pizzint',
      'fred',
      'oil',
      'bis',
      'trade',
      'supply-chain',
      'intelligence',
      'stablecoins',
      'etf-flows',
      'macro-signals',
      'strategic-posture',
      'strategic-risk',
      'service-status',
      'cables',
      'natural',
      'cyber',
      'flights',
      'ais',
      'weather',
      'spending',
      'giving',
      'telegram',
      'oref',
      'iran-events',
      'tech-events',
      'gulf-quotes',
      'gps-interference',
      'eonet',
      'gdacs',
    ];

    initRelayPush(channels);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dl = this.dataLoader as any;
    subscribeRelayPush(`news:${variant}`, (p) => { void dl.applyNewsDigest(p); });
    subscribeRelayPush('markets',        (p) => { void dl.applyMarkets(p); });
    subscribeRelayPush('predictions',    (p) => { void dl.applyPredictions(p); });
    subscribeRelayPush('fred',           (p) => { void dl.applyFredData(p); });
    subscribeRelayPush('oil',            (p) => { void dl.applyOilData(p); });
    subscribeRelayPush('bis',            (p) => { void dl.applyBisData(p); });
    subscribeRelayPush('intelligence',   (p) => { void dl.applyIntelligence(p); });
    subscribeRelayPush('pizzint',        (p) => { void dl.applyPizzInt(p); });
    subscribeRelayPush('trade',          (p) => { void dl.applyTradePolicy(p); });
    subscribeRelayPush('supply-chain',   (p) => { void dl.applySupplyChain(p); });
    subscribeRelayPush('natural',        (p) => { void dl.applyNatural(p); });
    subscribeRelayPush('cyber',          (p) => { void dl.applyCyberThreats(p); });
    subscribeRelayPush('cables',         (p) => { void dl.applyCableHealth(p); });
    subscribeRelayPush('flights',        (p) => { void dl.applyFlightDelays(p); });
    subscribeRelayPush('ais',            (p) => { void dl.applyAisSignals(p); });
    subscribeRelayPush('weather',        (p) => { void dl.applyWeatherAlerts(p); });
    subscribeRelayPush('spending',       (p) => { void dl.applySpending(p); });
    subscribeRelayPush('giving',         (p) => { void dl.applyGiving(p); });
    subscribeRelayPush('telegram',       (p) => { void dl.applyTelegramIntel(p); });
    subscribeRelayPush('oref',           (p) => { void dl.applyOref(p); });
    subscribeRelayPush('iran-events',    (p) => { void dl.applyIranEvents(p); });
    subscribeRelayPush('tech-events',    (p) => { void dl.applyTechEvents(p); });
    subscribeRelayPush('gulf-quotes',    (p) => { void dl.applyGulfQuotes(p); });
    subscribeRelayPush('gps-interference', (p) => { void dl.applyGpsInterference(p); });
    subscribeRelayPush('eonet',          (p) => { void dl.applyEonet(p); });
    subscribeRelayPush('gdacs',          (p) => { void dl.applyGdacs(p); });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const panel = (key: string) => (this.state.panels[key] as any)?.applyPush?.bind(this.state.panels[key]);
    subscribeRelayPush('strategic-posture', (p) => panel('strategic-posture')?.(p));
    subscribeRelayPush('strategic-risk',    (p) => panel('strategic-risk')?.(p));
    subscribeRelayPush('stablecoins',       (p) => panel('stablecoins')?.(p));
    subscribeRelayPush('etf-flows',         (p) => panel('etf-flows')?.(p));
    subscribeRelayPush('macro-signals',     (p) => panel('macro-signals')?.(p));
    subscribeRelayPush('service-status',    (p) => panel('service-status')?.(p));
  }
}
