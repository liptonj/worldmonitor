import type { AppContext, AppModule } from '@/app/app-context';
import type { RelatedAsset } from '@/types';
import type { TheaterPostureSummary } from '@/services/military-surge';
import { MapContainer, NewsPanel, MarketPanel, MonitorPanel, HeatmapPanel, CommoditiesPanel, CryptoPanel } from '@/components';
import { focusInvestmentOnMap } from '@/services/investments-focus';
import { debounce, saveToStorage } from '@/utils';
import { escapeHtml } from '@/utils/sanitize';
import {
  getFeeds,
  getIntelSources,
  DEFAULT_PANELS,
  STORAGE_KEYS,
  SITE_VARIANT,
} from '@/config';
import { BETA_MODE } from '@/config/beta';
import { t } from '@/services/i18n';
import { getCurrentTheme } from '@/utils';
import { trackCriticalBannerAction } from '@/services/analytics';
import { isDesktopRuntime } from '@/services/runtime';
import { isFeatureAvailable } from '@/services/runtime-config';

const NEWS_PANEL_KEYS = [
  'politics', 'tech', 'finance', 'gov', 'intel', 'energy',
  'africa', 'latam', 'asia', 'middleeast',
  'ai', 'layoffs', 'thinktanks',
  'startups', 'vcblogs', 'regionalStartups', 'unicorns',
  'accelerators', 'funding', 'producthunt', 'security',
  'policy', 'hardware', 'cloud', 'dev', 'github', 'ipo',
] as const;

export interface PanelLayoutCallbacks {
  openCountryStory: (code: string, name: string) => void;
  loadAllData: () => Promise<void>;
  updateMonitorResults: () => void;
  loadSecurityAdvisories?: () => Promise<void>;
}

export class PanelLayoutManager implements AppModule {
  private ctx: AppContext;
  private callbacks: PanelLayoutCallbacks;
  private panelDragCleanupHandlers: Array<() => void> = [];
  private criticalBannerEl: HTMLElement | null = null;
  private bottomGridToggleCleanup: (() => void) | null = null;
  private mobileNavCleanup: (() => void) | null = null;
  private readonly applyTimeRangeFilterDebounced: () => void;

  constructor(ctx: AppContext, callbacks: PanelLayoutCallbacks) {
    this.ctx = ctx;
    this.callbacks = callbacks;
    this.applyTimeRangeFilterDebounced = debounce(() => {
      this.applyTimeRangeFilterToNewsPanels();
    }, 120);
  }

  async init(): Promise<void> {
    await this.renderLayout();
  }

  destroy(): void {
    this.panelDragCleanupHandlers.forEach((cleanup) => cleanup());
    this.panelDragCleanupHandlers = [];
    if (this.criticalBannerEl) {
      this.criticalBannerEl.remove();
      this.criticalBannerEl = null;
    }
    // Clean up happy variant panels
    this.ctx.tvMode?.destroy();
    this.ctx.tvMode = null;
    this.ctx.countersPanel?.destroy();
    this.ctx.progressPanel?.destroy();
    this.ctx.breakthroughsPanel?.destroy();
    this.ctx.heroPanel?.destroy();
    this.ctx.digestPanel?.destroy();
    this.ctx.speciesPanel?.destroy();
    this.ctx.renewablePanel?.destroy();

    this.bottomGridToggleCleanup?.();
    this.bottomGridToggleCleanup = null;
    this.mobileNavCleanup?.();
    this.mobileNavCleanup = null;
    window.removeEventListener('resize', this.ensureCorrectZones);
  }

  async renderLayout(): Promise<void> {
    this.ctx.container.innerHTML = `
      <div class="header" id="mainHeader">
        <div class="header-left">
          <button class="hamburger-btn" id="hamburgerBtn" aria-label="Menu" aria-expanded="false"><span></span><span></span><span></span></button>
          <div class="variant-switcher">${(() => {
        const local = this.ctx.isDesktopApp || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
        const vHref = (v: string, prod: string) => local || SITE_VARIANT === v ? '#' : prod;
        const vTarget = (_v: string) => '';
        return `
            <a href="${vHref('full', __URL_FULL__)}"
               class="variant-option ${SITE_VARIANT === 'full' ? 'active' : ''}"
               data-variant="full"
               ${vTarget('full')}
               title="${t('header.world')}${SITE_VARIANT === 'full' ? ` ${t('common.currentVariant')}` : ''}">
              <span class="variant-icon">🌍</span>
              <span class="variant-label">${t('header.world')}</span>
            </a>
            <span class="variant-divider"></span>
            <a href="${vHref('tech', __URL_TECH__)}"
               class="variant-option ${SITE_VARIANT === 'tech' ? 'active' : ''}"
               data-variant="tech"
               ${vTarget('tech')}
               title="${t('header.tech')}${SITE_VARIANT === 'tech' ? ` ${t('common.currentVariant')}` : ''}">
              <span class="variant-icon">💻</span>
              <span class="variant-label">${t('header.tech')}</span>
            </a>
            <span class="variant-divider"></span>
            <a href="${vHref('finance', __URL_FINANCE__)}"
               class="variant-option ${SITE_VARIANT === 'finance' ? 'active' : ''}"
               data-variant="finance"
               ${vTarget('finance')}
               title="${t('header.finance')}${SITE_VARIANT === 'finance' ? ` ${t('common.currentVariant')}` : ''}">
              <span class="variant-icon">📈</span>
              <span class="variant-label">${t('header.finance')}</span>
            </a>
            ${SITE_VARIANT === 'happy' ? `<span class="variant-divider"></span>
            <a href="${vHref('happy', __URL_HAPPY__)}"
               class="variant-option active"
               data-variant="happy"
               ${vTarget('happy')}
               title="Good News ${t('common.currentVariant')}">
              <span class="variant-icon">☀️</span>
              <span class="variant-label">Good News</span>
            </a>` : ''}`;
      })()}</div>
          <span class="logo">MONITOR</span><span class="version">v${__APP_VERSION__}</span>${BETA_MODE ? '<span class="beta-badge">BETA</span>' : ''}
          <div class="status-indicator">
            <span class="status-dot"></span>
            <span>${t('header.live')}</span>
          </div>
          <div class="region-selector">
            <select id="regionSelect" class="region-select">
              <option value="global">${t('components.deckgl.views.global')}</option>
              <option value="america">${t('components.deckgl.views.americas')}</option>
              <option value="mena">${t('components.deckgl.views.mena')}</option>
              <option value="eu">${t('components.deckgl.views.europe')}</option>
              <option value="asia">${t('components.deckgl.views.asia')}</option>
              <option value="latam">${t('components.deckgl.views.latam')}</option>
              <option value="africa">${t('components.deckgl.views.africa')}</option>
              <option value="oceania">${t('components.deckgl.views.oceania')}</option>
            </select>
          </div>
        </div>
        <div class="header-right">
          <button class="summarize-view-btn" id="summarizeViewBtn" title="${t('header.summarizeViewTooltip')}">
            <span class="summarize-view-icon">✨</span>
            <span class="summarize-view-label">${t('header.summarizeView')}</span>
          </button>
          <button class="search-btn" id="searchBtn"><kbd>⌘K</kbd> ${t('header.search')}</button>
          ${this.ctx.isDesktopApp ? '' : `<button class="copy-link-btn" id="copyLinkBtn">${t('header.copyLink')}</button>`}
          <button class="theme-toggle-btn" id="headerThemeToggle" title="${t('header.toggleTheme')}">
            ${getCurrentTheme() === 'dark'
        ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>'
        : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>'}
          </button>
          ${this.ctx.isDesktopApp ? '' : `<button class="fullscreen-btn" id="fullscreenBtn" title="${t('header.fullscreen')}">⛶</button>`}
          ${SITE_VARIANT === 'happy' ? `<button class="tv-mode-btn" id="tvModeBtn" title="TV Mode (Shift+T)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg></button>` : ''}
          <span id="unifiedSettingsMount"></span>
          <a href="/admin.html" class="header-admin-btn" id="adminBtn" title="Admin">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          </a>
        </div>
      </div>
      <div class="mobile-nav-backdrop" id="mobileNavBackdrop"></div>
      <div class="main-content">
        <div class="map-section" id="mapSection">
          <div class="panel-header">
            <div class="panel-header-left">
              <span class="panel-title">${SITE_VARIANT === 'tech' ? t('panels.techMap') : SITE_VARIANT === 'happy' ? 'Good News Map' : t('panels.map')}</span>
            </div>
            <span class="header-clock" id="headerClock"></span>
            <div style="display:flex;align-items:center;gap:2px">
              <button class="map-pin-btn" id="mapBottomGridToggle" title="Toggle bottom panels area">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="15" x2="21" y2="15"/></svg>
              </button>
              <button class="map-pin-btn" id="mapFullscreenBtn" title="Fullscreen">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>
              </button>
              <button class="map-pin-btn" id="mapPinBtn" title="${t('header.pinMap')}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 17v5M9 10.76a2 2 0 01-1.11 1.79l-1.78.9A2 2 0 005 15.24V16a1 1 0 001 1h12a1 1 0 001-1v-.76a2 2 0 00-1.11-1.79l-1.78-.9A2 2 0 0115 10.76V7a1 1 0 011-1 1 1 0 001-1V4a1 1 0 00-1-1H8a1 1 0 00-1 1v1a1 1 0 001 1 1 1 0 011 1v3.76z"/>
                </svg>
              </button>
            </div>
          </div>
          <div class="map-container" id="mapContainer"></div>
          ${SITE_VARIANT === 'happy' ? '<button class="tv-exit-btn" id="tvExitBtn">Exit TV Mode</button>' : ''}
          <div class="map-resize-handle" id="mapResizeHandle"></div>
          <div class="map-bottom-grid bottom-grid-hidden" id="mapBottomGrid"></div>
        </div>
        <div class="map-width-resize-handle" id="mapWidthResizeHandle"></div>
        <div class="panels-grid" id="panelsGrid"></div>
      </div>
    `;

    await this.createPanels();

    if (this.ctx.isMobile) {
      this.setupMobileMapToggle();
    }
    this.setupMobileNav();
  }

  private setupMobileMapToggle(): void {
    const mapSection = document.getElementById('mapSection');
    const headerLeft = mapSection?.querySelector('.panel-header-left');
    if (!mapSection || !headerLeft) return;

    const stored = localStorage.getItem('mobile-map-collapsed');
    const collapsed = stored === null || stored === 'true';
    if (collapsed) mapSection.classList.add('collapsed');

    const updateBtn = (btn: HTMLButtonElement, isCollapsed: boolean) => {
      btn.textContent = isCollapsed ? `▶ ${t('components.map.showMap')}` : `▼ ${t('components.map.hideMap')}`;
    };

    const btn = document.createElement('button');
    btn.className = 'map-collapse-btn';
    updateBtn(btn, collapsed);
    headerLeft.after(btn);

    btn.addEventListener('click', () => {
      const isCollapsed = mapSection.classList.toggle('collapsed');
      updateBtn(btn, isCollapsed);
      localStorage.setItem('mobile-map-collapsed', String(isCollapsed));
      if (!isCollapsed) window.dispatchEvent(new Event('resize'));
    });
  }

  private setupMobileNav(): void {
    const header = document.getElementById('mainHeader');
    const hamburgerBtn = document.getElementById('hamburgerBtn') as HTMLButtonElement | null;
    const backdrop = document.getElementById('mobileNavBackdrop');
    if (!header || !hamburgerBtn || !backdrop) return;

    const openMenu = () => {
      header.classList.add('mobile-nav-open');
      backdrop.classList.add('active');
      hamburgerBtn.setAttribute('aria-expanded', 'true');
    };
    const closeMenu = () => {
      header.classList.remove('mobile-nav-open');
      backdrop.classList.remove('active');
      hamburgerBtn.setAttribute('aria-expanded', 'false');
    };

    const toggleHandler = () => {
      if (header.classList.contains('mobile-nav-open')) closeMenu();
      else openMenu();
    };
    const keydownHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && header.classList.contains('mobile-nav-open')) closeMenu();
    };

    hamburgerBtn.addEventListener('click', toggleHandler);
    backdrop.addEventListener('click', closeMenu);
    document.addEventListener('keydown', keydownHandler);

    const cleanupFns: Array<() => void> = [];
    const closeOnClick = (selector: string) => {
      const el = document.querySelector(selector);
      if (el) {
        el.addEventListener('click', closeMenu);
        cleanupFns.push(() => el.removeEventListener('click', closeMenu));
      }
    };
    closeOnClick('#searchBtn');
    closeOnClick('#headerThemeToggle');
    closeOnClick('#unifiedSettingsMount');
    closeOnClick('#fullscreenBtn');
    closeOnClick('#tvModeBtn');
    closeOnClick('#summarizeViewBtn');
    closeOnClick('.variant-switcher a');

    const regionSelect = document.getElementById('regionSelect');
    if (regionSelect) {
      regionSelect.addEventListener('change', closeMenu);
      cleanupFns.push(() => regionSelect.removeEventListener('change', closeMenu));
    }

    const resizeHandler = () => {
      if (window.innerWidth > 768) closeMenu();
    };
    window.addEventListener('resize', resizeHandler);

    this.mobileNavCleanup = () => {
      hamburgerBtn.removeEventListener('click', toggleHandler);
      backdrop.removeEventListener('click', closeMenu);
      document.removeEventListener('keydown', keydownHandler);
      window.removeEventListener('resize', resizeHandler);
      cleanupFns.forEach((fn) => fn());
    };
  }

  renderCriticalBanner(postures: TheaterPostureSummary[]): void {
    if (this.ctx.isMobile) {
      if (this.criticalBannerEl) {
        this.criticalBannerEl.remove();
        this.criticalBannerEl = null;
      }
      document.body.classList.remove('has-critical-banner');
      return;
    }

    const dismissedAt = sessionStorage.getItem('banner-dismissed');
    if (dismissedAt && Date.now() - parseInt(dismissedAt, 10) < 30 * 60 * 1000) {
      return;
    }

    const critical = postures.filter(
      (p) => p.postureLevel === 'critical' || (p.postureLevel === 'elevated' && p.strikeCapable)
    );

    if (critical.length === 0) {
      if (this.criticalBannerEl) {
        this.criticalBannerEl.remove();
        this.criticalBannerEl = null;
        document.body.classList.remove('has-critical-banner');
      }
      return;
    }

    const top = critical[0]!;
    const isCritical = top.postureLevel === 'critical';

    if (!this.criticalBannerEl) {
      this.criticalBannerEl = document.createElement('div');
      this.criticalBannerEl.className = 'critical-posture-banner';
      const header = document.querySelector('.header');
      if (header) header.insertAdjacentElement('afterend', this.criticalBannerEl);
    }

    document.body.classList.add('has-critical-banner');
    this.criticalBannerEl.className = `critical-posture-banner ${isCritical ? 'severity-critical' : 'severity-elevated'}`;
    this.criticalBannerEl.innerHTML = `
      <div class="banner-content">
        <span class="banner-icon">${isCritical ? '🚨' : '⚠️'}</span>
        <span class="banner-headline">${escapeHtml(top.headline)}</span>
        <span class="banner-stats">${top.totalAircraft} aircraft • ${escapeHtml(top.summary)}</span>
        ${top.strikeCapable ? '<span class="banner-strike">STRIKE CAPABLE</span>' : ''}
      </div>
      <button class="banner-view" data-lat="${top.centerLat}" data-lon="${top.centerLon}">View Region</button>
      <button class="banner-dismiss">×</button>
    `;

    this.criticalBannerEl.querySelector('.banner-view')?.addEventListener('click', () => {
      trackCriticalBannerAction('view', top.theaterId);
      if (typeof top.centerLat === 'number' && typeof top.centerLon === 'number') {
        this.ctx.map?.setCenter(top.centerLat, top.centerLon, 4);
      } else {
        console.error('[Banner] Missing coordinates for', top.theaterId);
      }
    });

    this.criticalBannerEl.querySelector('.banner-dismiss')?.addEventListener('click', () => {
      trackCriticalBannerAction('dismiss', top.theaterId);
      this.criticalBannerEl?.classList.add('dismissed');
      document.body.classList.remove('has-critical-banner');
      sessionStorage.setItem('banner-dismissed', Date.now().toString());
    });
  }

  applyPanelSettings(): void {
    Object.entries(this.ctx.panelSettings).forEach(([key, config]) => {
      if (key === 'map') {
        const mapSection = document.getElementById('mapSection');
        if (mapSection) {
          mapSection.classList.toggle('hidden', !config.enabled);
        }
        return;
      }
      const panel = this.ctx.panels[key];
      if (!panel) return;

      // On desktop, hide panels whose required feature is not available (missing token).
      // On web, all features are available server-side — always respect user's enabled setting.
      if (isDesktopRuntime() && config.requiredFeature && !isFeatureAvailable(config.requiredFeature)) {
        panel.hide();
        return;
      }

      panel.toggle(config.enabled);
    });
  }

  private async createPanels(): Promise<void> {
    const panelsGrid = document.getElementById('panelsGrid')!;

    const mapContainer = document.getElementById('mapContainer') as HTMLElement;
    this.ctx.map = new MapContainer(mapContainer, {
      zoom: this.ctx.isMobile ? 2.5 : 1.0,
      pan: { x: 0, y: 0 },
      view: this.ctx.isMobile ? this.ctx.resolvedLocation : 'global',
      layers: this.ctx.mapLayers,
      timeRange: '7d',
    });

    this.ctx.map.initEscalationGetters();
    this.ctx.currentTimeRange = this.ctx.map.getTimeRange();

    for (const key of NEWS_PANEL_KEYS) {
      const label = DEFAULT_PANELS[key]?.name ?? t(`panels.${key}`);
      const panel = new NewsPanel(key, label);
      this.attachRelatedAssetHandlers(panel);
      this.ctx.newsPanels[key] = panel;
      this.ctx.panels[key] = panel;
    }

    const heatmapPanel = new HeatmapPanel();
    this.ctx.panels['heatmap'] = heatmapPanel;

    const marketsPanel = new MarketPanel();
    this.ctx.panels['markets'] = marketsPanel;

    const monitorPanel = new MonitorPanel(this.ctx.monitors);
    this.ctx.panels['monitors'] = monitorPanel;
    monitorPanel.onChanged((monitors) => {
      this.ctx.monitors = monitors;
      saveToStorage(STORAGE_KEYS.monitors, monitors);
      this.callbacks.updateMonitorResults();
    });

    const commoditiesPanel = new CommoditiesPanel();
    this.ctx.panels['commodities'] = commoditiesPanel;

    const { PredictionPanel } = await import('@/components/PredictionPanel');
    const predictionPanel = new PredictionPanel();
    this.ctx.panels['polymarket'] = predictionPanel;

    const cryptoPanel = new CryptoPanel();
    this.ctx.panels['crypto'] = cryptoPanel;

    const { EconomicPanel } = await import('@/components/EconomicPanel');
    const economicPanel = new EconomicPanel();
    this.ctx.panels['economic'] = economicPanel;

    if (SITE_VARIANT === 'full' || SITE_VARIANT === 'finance') {
      const { TradePolicyPanel } = await import('@/components/TradePolicyPanel');
      const tradePolicyPanel = new TradePolicyPanel();
      this.ctx.panels['trade-policy'] = tradePolicyPanel;

      const { SupplyChainPanel } = await import('@/components/SupplyChainPanel');
      const supplyChainPanel = new SupplyChainPanel();
      this.ctx.panels['supply-chain'] = supplyChainPanel;
    }

    const feeds = getFeeds();
    for (const key of Object.keys(feeds)) {
      if (this.ctx.newsPanels[key]) continue;
      if (!Array.isArray((feeds as Record<string, unknown>)[key])) continue;
      const panelKey = this.ctx.panels[key] && !this.ctx.newsPanels[key] ? `${key}-news` : key;
      if (this.ctx.panels[panelKey]) continue;
      const panelConfig = DEFAULT_PANELS[panelKey] ?? DEFAULT_PANELS[key];
      const label = panelConfig?.name ?? key.charAt(0).toUpperCase() + key.slice(1);
      const panel = new NewsPanel(panelKey, label);
      this.attachRelatedAssetHandlers(panel);
      this.ctx.newsPanels[key] = panel;
      this.ctx.panels[panelKey] = panel;
    }

    if (SITE_VARIANT === 'full') {
      const { GdeltIntelPanel } = await import('@/components/GdeltIntelPanel');
      const gdeltIntelPanel = new GdeltIntelPanel();
      this.ctx.panels['gdelt-intel'] = gdeltIntelPanel;

      if (this.ctx.isDesktopApp) {
        const { DeductionPanel } = await import('@/components/DeductionPanel');
        const deductionPanel = new DeductionPanel(() => this.ctx.allNews);
        this.ctx.panels['deduction'] = deductionPanel;
        const el = deductionPanel.getElement();
        this.makeDraggable(el, 'deduction');
        const grid = document.getElementById('panelsGrid');
        if (grid) {
          const gdeltEl = this.ctx.panels['gdelt-intel']?.getElement();
          if (gdeltEl?.nextSibling) {
            grid.insertBefore(el, gdeltEl.nextSibling);
          } else {
            grid.appendChild(el);
          }
        }
      }

      const { CIIPanel } = await import('@/components/CIIPanel');
      const ciiPanel = new CIIPanel();
      ciiPanel.setShareStoryHandler((code, name) => {
        this.callbacks.openCountryStory(code, name);
      });
      this.ctx.panels['cii'] = ciiPanel;

      const { CascadePanel } = await import('@/components/CascadePanel');
      const cascadePanel = new CascadePanel();
      this.ctx.panels['cascade'] = cascadePanel;

      const { HeadlinesPanel } = await import('@/components/HeadlinesPanel');
      const headlinesPanel = new HeadlinesPanel();
      this.ctx.panels['headlines'] = headlinesPanel;

      const { SatelliteFiresPanel } = await import('@/components/SatelliteFiresPanel');
      const satelliteFiresPanel = new SatelliteFiresPanel();
      this.ctx.panels['satellite-fires'] = satelliteFiresPanel;

      const { StrategicRiskPanel } = await import('@/components/StrategicRiskPanel');
      const strategicRiskPanel = new StrategicRiskPanel();
      strategicRiskPanel.setLocationClickHandler((lat, lon) => {
        this.ctx.map?.setCenter(lat, lon, 4);
      });
      this.ctx.panels['strategic-risk'] = strategicRiskPanel;

      const { StrategicPosturePanel } = await import('@/components/StrategicPosturePanel');
      const strategicPosturePanel = new StrategicPosturePanel(() => this.ctx.allNews);
      strategicPosturePanel.setLocationClickHandler((lat, lon) => {
        this.ctx.map?.setCenter(lat, lon, 4);
      });
      this.ctx.panels['strategic-posture'] = strategicPosturePanel;

      const { UcdpEventsPanel } = await import('@/components/UcdpEventsPanel');
      const ucdpEventsPanel = new UcdpEventsPanel();
      ucdpEventsPanel.setEventClickHandler((lat, lon) => {
        this.ctx.map?.setCenter(lat, lon, 5);
      });
      this.ctx.panels['ucdp-events'] = ucdpEventsPanel;

      const { DisplacementPanel } = await import('@/components/DisplacementPanel');
      const displacementPanel = new DisplacementPanel();
      displacementPanel.setCountryClickHandler((lat, lon) => {
        this.ctx.map?.setCenter(lat, lon, 4);
      });
      this.ctx.panels['displacement'] = displacementPanel;

      const { ClimateAnomalyPanel } = await import('@/components/ClimateAnomalyPanel');
      const climatePanel = new ClimateAnomalyPanel();
      climatePanel.setZoneClickHandler((lat, lon) => {
        this.ctx.map?.setCenter(lat, lon, 4);
      });
      this.ctx.panels['climate'] = climatePanel;

      const { PopulationExposurePanel } = await import('@/components/PopulationExposurePanel');
      const populationExposurePanel = new PopulationExposurePanel();
      this.ctx.panels['population-exposure'] = populationExposurePanel;

      const { SecurityAdvisoriesPanel } = await import('@/components/SecurityAdvisoriesPanel');
      const securityAdvisoriesPanel = new SecurityAdvisoriesPanel();
      securityAdvisoriesPanel.setRefreshHandler(() => {
        void this.callbacks.loadSecurityAdvisories?.();
      });
      this.ctx.panels['security-advisories'] = securityAdvisoriesPanel;

      const { OrefSirensPanel } = await import('@/components/OrefSirensPanel');
      const orefSirensPanel = new OrefSirensPanel();
      this.ctx.panels['oref-sirens'] = orefSirensPanel;

      const { TelegramIntelPanel } = await import('@/components/TelegramIntelPanel');
      const telegramIntelPanel = new TelegramIntelPanel();
      this.ctx.panels['telegram-intel'] = telegramIntelPanel;
    }

    let GulfEconomiesPanel: (typeof import('@/components/GulfEconomiesPanel'))['GulfEconomiesPanel'] | undefined;
    if (SITE_VARIANT !== 'happy') {
      const mod = await import('@/components/GulfEconomiesPanel');
      GulfEconomiesPanel = mod.GulfEconomiesPanel;
    }

    if (SITE_VARIANT === 'finance') {
      const { InvestmentsPanel } = await import('@/components/InvestmentsPanel');
      const investmentsPanel = new InvestmentsPanel((inv) => {
        focusInvestmentOnMap(this.ctx.map, this.ctx.mapLayers, inv.lat, inv.lon);
      });
      this.ctx.panels['gcc-investments'] = investmentsPanel;

      const gulfEconomiesPanel = new GulfEconomiesPanel!();
      this.ctx.panels['gulf-economies'] = gulfEconomiesPanel;
    }

    const { WorldClockPanel } = await import('@/components/WorldClockPanel');
    this.ctx.panels['world-clock'] = new WorldClockPanel();

    if (SITE_VARIANT !== 'happy') {
      if (!this.ctx.panels['gulf-economies']) {
        const gulfEconomiesPanel = new GulfEconomiesPanel!();
        this.ctx.panels['gulf-economies'] = gulfEconomiesPanel;
      }

      const { LiveNewsPanel } = await import('@/components/LiveNewsPanel');
      const liveNewsPanel = new LiveNewsPanel();
      this.ctx.panels['live-news'] = liveNewsPanel;

      const { LiveWebcamsPanel } = await import('@/components/LiveWebcamsPanel');
      const liveWebcamsPanel = new LiveWebcamsPanel();
      this.ctx.panels['live-webcams'] = liveWebcamsPanel;

      const { TechEventsPanel } = await import('@/components/TechEventsPanel');
      this.ctx.panels['events'] = new TechEventsPanel('events', () => this.ctx.allNews);

      const { ServiceStatusPanel } = await import('@/components/ServiceStatusPanel');
      const serviceStatusPanel = new ServiceStatusPanel();
      this.ctx.panels['service-status'] = serviceStatusPanel;

      const { TechReadinessPanel } = await import('@/components/TechReadinessPanel');
      const techReadinessPanel = new TechReadinessPanel();
      this.ctx.panels['tech-readiness'] = techReadinessPanel;

      const { MacroSignalsPanel } = await import('@/components/MacroSignalsPanel');
      this.ctx.panels['macro-signals'] = new MacroSignalsPanel();
      const { ETFFlowsPanel } = await import('@/components/ETFFlowsPanel');
      this.ctx.panels['etf-flows'] = new ETFFlowsPanel();
      const { StablecoinPanel } = await import('@/components/StablecoinPanel');
      this.ctx.panels['stablecoins'] = new StablecoinPanel();
    }

    if (this.ctx.isDesktopApp) {
      const { RuntimeConfigPanel } = await import('@/components/RuntimeConfigPanel');
      const runtimeConfigPanel = new RuntimeConfigPanel({ mode: 'alert' });
      this.ctx.panels['runtime-config'] = runtimeConfigPanel;
    }

    const { InsightsPanel } = await import('@/components/InsightsPanel');
    const insightsPanel = new InsightsPanel();
    this.ctx.panels['insights'] = insightsPanel;

    // Global Giving panel (all variants)
    const { GivingPanel } = await import('@/components/GivingPanel');
    this.ctx.panels['giving'] = new GivingPanel();

    // Happy variant panels
    if (SITE_VARIANT === 'happy') {
      const { PositiveNewsFeedPanel } = await import('@/components/PositiveNewsFeedPanel');
      this.ctx.positivePanel = new PositiveNewsFeedPanel();
      this.ctx.panels['positive-feed'] = this.ctx.positivePanel;

      const { CountersPanel } = await import('@/components/CountersPanel');
      this.ctx.countersPanel = new CountersPanel();
      this.ctx.panels['counters'] = this.ctx.countersPanel;
      this.ctx.countersPanel.startTicking();

      const { ProgressChartsPanel } = await import('@/components/ProgressChartsPanel');
      this.ctx.progressPanel = new ProgressChartsPanel();
      this.ctx.panels['progress'] = this.ctx.progressPanel;

      const { BreakthroughsTickerPanel } = await import('@/components/BreakthroughsTickerPanel');
      this.ctx.breakthroughsPanel = new BreakthroughsTickerPanel();
      this.ctx.panels['breakthroughs'] = this.ctx.breakthroughsPanel;

      const { HeroSpotlightPanel } = await import('@/components/HeroSpotlightPanel');
      this.ctx.heroPanel = new HeroSpotlightPanel();
      this.ctx.panels['spotlight'] = this.ctx.heroPanel;
      this.ctx.heroPanel.onLocationRequest = (lat: number, lon: number) => {
        this.ctx.map?.setCenter(lat, lon, 4);
        this.ctx.map?.flashLocation(lat, lon, 3000);
      };

      const { GoodThingsDigestPanel } = await import('@/components/GoodThingsDigestPanel');
      this.ctx.digestPanel = new GoodThingsDigestPanel();
      this.ctx.panels['digest'] = this.ctx.digestPanel;

      const { SpeciesComebackPanel } = await import('@/components/SpeciesComebackPanel');
      this.ctx.speciesPanel = new SpeciesComebackPanel();
      this.ctx.panels['species'] = this.ctx.speciesPanel;

      const { RenewableEnergyPanel } = await import('@/components/RenewableEnergyPanel');
      this.ctx.renewablePanel = new RenewableEnergyPanel();
      this.ctx.panels['renewable'] = this.ctx.renewablePanel;
    }

    const defaultOrder = Object.keys(DEFAULT_PANELS).filter(k => k !== 'map');
    const savedOrder = this.getSavedPanelOrder();
    const savedBottomOrder = this.getSavedBottomPanelOrder();
    const isUltraWide = window.innerWidth >= 1600;

    let panelOrder = defaultOrder;
    if (savedOrder.length > 0 || savedBottomOrder.length > 0) {
      const allSaved = [...savedOrder, ...savedBottomOrder];
      const missing = defaultOrder.filter(k => !allSaved.includes(k));
      const valid = savedOrder.filter(k => defaultOrder.includes(k));
      const validBottom = isUltraWide ? savedBottomOrder.filter(k => defaultOrder.includes(k)) : [];

      const monitorsIdx = valid.indexOf('monitors');
      if (monitorsIdx !== -1) valid.splice(monitorsIdx, 1);
      const insertIdx = valid.indexOf('politics') + 1 || 0;
      const newPanels = missing.filter(k => k !== 'monitors');
      valid.splice(insertIdx, 0, ...newPanels);
      if (SITE_VARIANT !== 'happy') {
        valid.push('monitors');
      }
      panelOrder = valid;

      // Handle bottom panels
      validBottom.forEach(key => {
        const panel = this.ctx.panels[key];
        if (panel) {
          const el = panel.getElement();
          this.makeDraggable(el, key);
          document.getElementById('mapBottomGrid')?.appendChild(el);
        }
      });
    }

    if (SITE_VARIANT !== 'happy') {
      const liveNewsIdx = panelOrder.indexOf('live-news');
      if (liveNewsIdx > 0) {
        panelOrder.splice(liveNewsIdx, 1);
        panelOrder.unshift('live-news');
      }

      const webcamsIdx = panelOrder.indexOf('live-webcams');
      if (webcamsIdx !== -1 && webcamsIdx !== panelOrder.indexOf('live-news') + 1) {
        panelOrder.splice(webcamsIdx, 1);
        const afterNews = panelOrder.indexOf('live-news') + 1;
        panelOrder.splice(afterNews, 0, 'live-webcams');
      }
    }

    if (this.ctx.isDesktopApp) {
      const runtimeIdx = panelOrder.indexOf('runtime-config');
      if (runtimeIdx > 1) {
        panelOrder.splice(runtimeIdx, 1);
        panelOrder.splice(1, 0, 'runtime-config');
      } else if (runtimeIdx === -1) {
        panelOrder.splice(1, 0, 'runtime-config');
      }
    }

    panelOrder.forEach((key: string) => {
      const panel = this.ctx.panels[key];
      if (panel && !panel.getElement().parentElement) {
        const el = panel.getElement();
        this.makeDraggable(el, key);
        panelsGrid.appendChild(el);
      }
    });

    window.addEventListener('resize', () => this.ensureCorrectZones());

    this.ctx.map.onTimeRangeChanged((range) => {
      this.ctx.currentTimeRange = range;
      this.applyTimeRangeFilterDebounced();
    });

    this.applyPanelSettings();
    this.setupBottomGridToggle();
    this.applyInitialUrlState();
  }

  private applyTimeRangeFilterToNewsPanels(): void {
    Object.entries(this.ctx.newsByCategory).forEach(([category, items]) => {
      const panel = this.ctx.newsPanels[category];
      if (!panel) return;
      const filtered = this.filterItemsByTimeRange(items);
      if (filtered.length === 0 && items.length > 0) {
        panel.renderFilteredEmpty(`No items in ${this.getTimeRangeLabel()}`);
        return;
      }
      panel.renderNews(filtered);
    });
  }

  private filterItemsByTimeRange(items: import('@/types').NewsItem[], range: import('@/components').TimeRange = this.ctx.currentTimeRange): import('@/types').NewsItem[] {
    if (range === 'all') return items;
    const ranges: Record<string, number> = {
      '1h': 60 * 60 * 1000, '6h': 6 * 60 * 60 * 1000,
      '24h': 24 * 60 * 60 * 1000, '48h': 48 * 60 * 60 * 1000,
      '7d': 7 * 24 * 60 * 60 * 1000, 'all': Infinity,
    };
    const cutoff = Date.now() - (ranges[range] ?? Infinity);
    return items.filter((item) => {
      const ts = item.pubDate instanceof Date ? item.pubDate.getTime() : new Date(item.pubDate).getTime();
      return Number.isFinite(ts) ? ts >= cutoff : true;
    });
  }

  private getTimeRangeLabel(): string {
    const labels: Record<string, string> = {
      '1h': 'the last hour', '6h': 'the last 6 hours',
      '24h': 'the last 24 hours', '48h': 'the last 48 hours',
      '7d': 'the last 7 days', 'all': 'all time',
    };
    return labels[this.ctx.currentTimeRange] ?? 'the last 7 days';
  }

  private applyInitialUrlState(): void {
    if (!this.ctx.initialUrlState || !this.ctx.map) return;

    const { view, zoom, lat, lon, timeRange, layers } = this.ctx.initialUrlState;

    if (view) {
      this.ctx.map.setView(view);
    }

    if (timeRange) {
      this.ctx.map.setTimeRange(timeRange);
    }

    if (layers) {
      this.ctx.mapLayers = layers;
      saveToStorage(STORAGE_KEYS.mapLayers, this.ctx.mapLayers);
      this.ctx.map.setLayers(layers);
    }

    if (lat !== undefined && lon !== undefined) {
      const effectiveZoom = zoom ?? this.ctx.map.getState().zoom;
      if (effectiveZoom > 2) this.ctx.map.setCenter(lat, lon, zoom);
    } else if (!view && zoom !== undefined) {
      this.ctx.map.setZoom(zoom);
    }

    const regionSelect = document.getElementById('regionSelect') as HTMLSelectElement;
    const currentView = this.ctx.map.getState().view;
    if (regionSelect && currentView) {
      regionSelect.value = currentView;
    }
  }

  private getSavedPanelOrder(): string[] {
    try {
      const saved = localStorage.getItem(this.ctx.PANEL_ORDER_KEY);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  }

  savePanelOrder(): void {
    const grid = document.getElementById('panelsGrid');
    const bottomGrid = document.getElementById('mapBottomGrid');
    if (!grid || !bottomGrid) return;

    const order = Array.from(grid.children)
      .map((el) => (el as HTMLElement).dataset.panel)
      .filter((key): key is string => !!key);

    const bottomOrder = Array.from(bottomGrid.children)
      .map((el) => (el as HTMLElement).dataset.panel)
      .filter((key): key is string => !!key);

    localStorage.setItem(this.ctx.PANEL_ORDER_KEY, JSON.stringify(order));
    localStorage.setItem(this.ctx.PANEL_ORDER_KEY + '-bottom', JSON.stringify(bottomOrder));
  }

  private getSavedBottomPanelOrder(): string[] {
    try {
      const saved = localStorage.getItem(this.ctx.PANEL_ORDER_KEY + '-bottom');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  }

  private wasUltraWide = window.innerWidth >= 1600;

  public ensureCorrectZones(): void {
    const isUltraWide = window.innerWidth >= 1600;
    const mapSection = document.getElementById('mapSection');
    const mapEnabled = !mapSection?.classList.contains('hidden');
    const effectiveUltraWide = isUltraWide && mapEnabled;

    if (effectiveUltraWide === this.wasUltraWide) return;
    this.wasUltraWide = effectiveUltraWide;

    const grid = document.getElementById('panelsGrid');
    const bottomGrid = document.getElementById('mapBottomGrid');
    if (!grid || !bottomGrid) return;

    if (!effectiveUltraWide) {
      // Move everything from bottom grid back to panels grid in correct order
      const panelsInBottom = Array.from(bottomGrid.querySelectorAll('.panel')) as HTMLElement[];
      const savedOrder = this.getSavedPanelOrder();
      const defaultOrder = Object.keys(DEFAULT_PANELS).filter(k => k !== 'map');

      panelsInBottom.forEach(panelEl => {
        const id = panelEl.dataset.panel;
        if (!id) return;

        // Use saved sidebar order if present, otherwise default order
        const searchOrder = savedOrder.includes(id) ? savedOrder : defaultOrder;
        const pos = searchOrder.indexOf(id);

        if (pos === -1) {
          grid.appendChild(panelEl);
          return;
        }

        // Find the first panel in searchOrder AFTER this one that is currently in the sidebar grid
        let inserted = false;
        for (let i = pos + 1; i < searchOrder.length; i++) {
          const nextId = searchOrder[i];
          const nextEl = grid.querySelector(`[data-panel="${nextId}"]`);
          if (nextEl) {
            grid.insertBefore(panelEl, nextEl);
            inserted = true;
            break;
          }
        }

        if (!inserted) {
          grid.appendChild(panelEl);
        }
      });
    } else {
      // Move panels that belong to bottom zone from sidebar to bottom grid
      const savedBottomOrder = this.getSavedBottomPanelOrder();
      savedBottomOrder.forEach(id => {
        const el = grid.querySelector(`[data-panel="${id}"]`);
        if (el) {
          bottomGrid.appendChild(el);
        }
      });
    }
  }

  private setupBottomGridToggle(): void {
    const toggleBtn = document.getElementById('mapBottomGridToggle');
    const bottomGrid = document.getElementById('mapBottomGrid');
    const panelsGrid = document.getElementById('panelsGrid');
    if (!toggleBtn || !bottomGrid || !panelsGrid) return;

    const isVisible = localStorage.getItem('map-bottom-grid-visible') === 'true';

    const applyState = (visible: boolean) => {
      if (visible) {
        bottomGrid.classList.remove('bottom-grid-hidden');
        toggleBtn.classList.add('bottom-toggle-active');
      } else {
        const panelsInBottom = Array.from(bottomGrid.querySelectorAll('.panel')) as HTMLElement[];
        panelsInBottom.forEach(panelEl => panelsGrid.appendChild(panelEl));
        if (panelsInBottom.length > 0) this.savePanelOrder();

        bottomGrid.classList.add('bottom-grid-hidden');
        toggleBtn.classList.remove('bottom-toggle-active');
      }
      localStorage.setItem('map-bottom-grid-visible', String(visible));
    };

    applyState(isVisible);

    const onClick = () => {
      const currentlyVisible = !bottomGrid.classList.contains('bottom-grid-hidden');
      applyState(!currentlyVisible);
    };
    toggleBtn.addEventListener('click', onClick);
    this.bottomGridToggleCleanup = () => toggleBtn.removeEventListener('click', onClick);
  }

  private attachRelatedAssetHandlers(panel: NewsPanel): void {
    panel.setRelatedAssetHandlers({
      onRelatedAssetClick: (asset) => this.handleRelatedAssetClick(asset),
      onRelatedAssetsFocus: (assets) => this.ctx.map?.highlightAssets(assets),
      onRelatedAssetsClear: () => this.ctx.map?.highlightAssets(null),
    });
  }

  private handleRelatedAssetClick(asset: RelatedAsset): void {
    if (!this.ctx.map) return;

    switch (asset.type) {
      case 'pipeline':
        this.ctx.map.enableLayer('pipelines');
        this.ctx.mapLayers.pipelines = true;
        saveToStorage(STORAGE_KEYS.mapLayers, this.ctx.mapLayers);
        this.ctx.map.triggerPipelineClick(asset.id);
        break;
      case 'cable':
        this.ctx.map.enableLayer('cables');
        this.ctx.mapLayers.cables = true;
        saveToStorage(STORAGE_KEYS.mapLayers, this.ctx.mapLayers);
        this.ctx.map.triggerCableClick(asset.id);
        break;
      case 'datacenter':
        this.ctx.map.enableLayer('datacenters');
        this.ctx.mapLayers.datacenters = true;
        saveToStorage(STORAGE_KEYS.mapLayers, this.ctx.mapLayers);
        this.ctx.map.triggerDatacenterClick(asset.id);
        break;
      case 'base':
        this.ctx.map.enableLayer('bases');
        this.ctx.mapLayers.bases = true;
        saveToStorage(STORAGE_KEYS.mapLayers, this.ctx.mapLayers);
        this.ctx.map.triggerBaseClick(asset.id);
        break;
      case 'nuclear':
        this.ctx.map.enableLayer('nuclear');
        this.ctx.mapLayers.nuclear = true;
        saveToStorage(STORAGE_KEYS.mapLayers, this.ctx.mapLayers);
        this.ctx.map.triggerNuclearClick(asset.id);
        break;
    }
  }

  private makeDraggable(el: HTMLElement, key: string): void {
    el.dataset.panel = key;
    let isDragging = false;
    let dragStarted = false;
    let startX = 0;
    let startY = 0;
    let rafId = 0;
    const DRAG_THRESHOLD = 8;

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (el.dataset.resizing === 'true') return;
      if (
        target.classList?.contains('panel-resize-handle') ||
        target.closest?.('.panel-resize-handle') ||
        target.classList?.contains('panel-col-resize-handle') ||
        target.closest?.('.panel-col-resize-handle')
      ) return;
      if (target.closest('button, a, input, select, textarea, .panel-content')) return;

      isDragging = true;
      dragStarted = false;
      startX = e.clientX;
      startY = e.clientY;
      e.preventDefault();
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      if (!dragStarted) {
        const dx = Math.abs(e.clientX - startX);
        const dy = Math.abs(e.clientY - startY);
        if (dx < DRAG_THRESHOLD && dy < DRAG_THRESHOLD) return;
        dragStarted = true;
        el.classList.add('dragging');
        const bg = document.getElementById('mapBottomGrid');
        if (bg?.classList.contains('bottom-grid-hidden')) {
          bg.classList.remove('bottom-grid-hidden');
          bg.dataset.autoShown = 'true';
        }
      }
      const cx = e.clientX;
      const cy = e.clientY;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        this.handlePanelDragMove(el, cx, cy);
        rafId = 0;
      });
    };

    const onMouseUp = () => {
      if (!isDragging) return;
      isDragging = false;
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      if (dragStarted) {
        el.classList.remove('dragging');
        this.savePanelOrder();
        const bg = document.getElementById('mapBottomGrid');
        if (bg?.dataset.autoShown === 'true') {
          delete bg.dataset.autoShown;
          if (bg.querySelectorAll('.panel').length === 0) {
            bg.classList.add('bottom-grid-hidden');
          } else {
            localStorage.setItem('map-bottom-grid-visible', 'true');
            document.getElementById('mapBottomGridToggle')?.classList.add('bottom-toggle-active');
          }
        }
      }
      dragStarted = false;
    };

    el.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);

    this.panelDragCleanupHandlers.push(() => {
      el.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      isDragging = false;
      dragStarted = false;
      el.classList.remove('dragging');
    });
  }

  private handlePanelDragMove(dragging: HTMLElement, clientX: number, clientY: number): void {
    const grid = document.getElementById('panelsGrid');
    const bottomGrid = document.getElementById('mapBottomGrid');
    if (!grid || !bottomGrid) return;

    dragging.style.pointerEvents = 'none';
    const target = document.elementFromPoint(clientX, clientY);
    dragging.style.pointerEvents = '';

    if (!target) return;

    // Check if we are over a grid or a panel inside a grid
    const targetGrid = (target.closest('.panels-grid') || target.closest('.map-bottom-grid')) as HTMLElement | null;
    const targetPanel = target.closest('.panel') as HTMLElement | null;

    if (!targetGrid && !targetPanel) return;

    const currentTargetGrid = targetGrid || (targetPanel ? targetPanel.parentElement as HTMLElement : null);
    if (!currentTargetGrid || (currentTargetGrid !== grid && currentTargetGrid !== bottomGrid)) return;

    if (targetPanel && targetPanel !== dragging && !targetPanel.classList.contains('hidden')) {
      const targetRect = targetPanel.getBoundingClientRect();
      const draggingRect = dragging.getBoundingClientRect();

      const children = Array.from(currentTargetGrid.children);
      const dragIdx = children.indexOf(dragging);
      const targetIdx = children.indexOf(targetPanel);

      const sameRow = Math.abs(draggingRect.top - targetRect.top) < 30;
      const targetMid = sameRow
        ? targetRect.left + targetRect.width / 2
        : targetRect.top + targetRect.height / 2;
      const cursorPos = sameRow ? clientX : clientY;

      if (dragIdx === -1) {
        // Moving from one grid to another
        if (cursorPos < targetMid) {
          currentTargetGrid.insertBefore(dragging, targetPanel);
        } else {
          currentTargetGrid.insertBefore(dragging, targetPanel.nextSibling);
        }
      } else {
        // Reordering within same grid
        if (dragIdx < targetIdx) {
          if (cursorPos > targetMid) {
            currentTargetGrid.insertBefore(dragging, targetPanel.nextSibling);
          }
        } else {
          if (cursorPos < targetMid) {
            currentTargetGrid.insertBefore(dragging, targetPanel);
          }
        }
      }
    } else if (currentTargetGrid !== dragging.parentElement) {
      // Dragging over an empty or near-empty grid zone
      currentTargetGrid.appendChild(dragging);
    }
  }

  getLocalizedPanelName(panelKey: string, fallback: string): string {
    if (panelKey === 'runtime-config') {
      return t('modals.runtimeConfig.title');
    }
    const key = panelKey.replace(/-([a-z])/g, (_match, group: string) => group.toUpperCase());
    const lookup = `panels.${key}`;
    const localized = t(lookup);
    return localized === lookup ? fallback : localized;
  }

  getAllSourceNames(): string[] {
    const sources = new Set<string>();
    Object.values(getFeeds()).forEach(feeds => {
      if (feeds) feeds.forEach(f => sources.add(f.name));
    });
    getIntelSources().forEach(f => sources.add(f.name));
    return Array.from(sources).sort((a, b) => a.localeCompare(b));
  }
}
