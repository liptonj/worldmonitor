import type { Monitor, PanelConfig, MapLayers } from '@/types';
import type { MapContainer, Panel, NewsPanel, SignalModal, StatusPanel, SearchModal } from '@/components';
import type { IntelligenceGapBadge } from '@/components';
import type { TimeRange } from '@/components';
import type { CountryBriefPanel } from '@/components/CountryBriefPanel';
import type { CountryTimeline } from '@/components/CountryTimeline';
import type { PlaybackControl } from '@/components';
import type { ExportPanel } from '@/utils';
import type { UnifiedSettings } from '@/components/UnifiedSettings';
import type { MobileWarningModal, PizzIntIndicator } from '@/components';
import type { ParsedMapUrlState } from '@/utils';
import type { PositiveNewsFeedPanel } from '@/components/PositiveNewsFeedPanel';
import type { CountersPanel } from '@/components/CountersPanel';
import type { ProgressChartsPanel } from '@/components/ProgressChartsPanel';
import type { BreakthroughsTickerPanel } from '@/components/BreakthroughsTickerPanel';
import type { HeroSpotlightPanel } from '@/components/HeroSpotlightPanel';
import type { GoodThingsDigestPanel } from '@/components/GoodThingsDigestPanel';
import type { SpeciesComebackPanel } from '@/components/SpeciesComebackPanel';
import type { RenewableEnergyPanel } from '@/components/RenewableEnergyPanel';
import type { TvModeController } from '@/services/tv-mode';
import type { BreakingNewsBanner } from '@/components/BreakingNewsBanner';

export interface CountryBriefSignals {
  criticalNews: number;
  protests: number;
  militaryFlights: number;
  militaryVessels: number;
  outages: number;
  aisDisruptions: number;
  satelliteFires: number;
  temporalAnomalies: number;
  cyberThreats: number;
  earthquakes: number;
  displacementOutflow: number;
  climateStress: number;
  conflictEvents: number;
  activeStrikes: number;
  orefSirens: number;
  orefHistory24h: number;
  aviationDisruptions: number;
  travelAdvisories: number;
  travelAdvisoryMaxLevel: string | null;
  gpsJammingHexes: number;
  isTier1: boolean;
}

export interface AppModule {
  init(): void | Promise<void>;
  destroy(): void;
}

export interface AppContext {
  map: MapContainer | null;
  readonly isMobile: boolean;
  readonly isDesktopApp: boolean;
  readonly container: HTMLElement;

  panels: Record<string, Panel>;
  newsPanels: Record<string, NewsPanel>;
  panelSettings: Record<string, PanelConfig>;

  mapLayers: MapLayers;

  disabledSources: Set<string>;
  currentTimeRange: TimeRange;

  inFlight: Set<string>;
  seenGeoAlerts: Set<string>;
  monitors: Monitor[];

  signalModal: SignalModal | null;
  statusPanel: StatusPanel | null;
  searchModal: SearchModal | null;
  findingsBadge: IntelligenceGapBadge | null;
  breakingBanner: BreakingNewsBanner | null;
  playbackControl: PlaybackControl | null;
  exportPanel: ExportPanel | null;
  unifiedSettings: UnifiedSettings | null;
  mobileWarningModal: MobileWarningModal | null;
  pizzintIndicator: PizzIntIndicator | null;
  countryBriefPage: CountryBriefPanel | null;
  countryTimeline: CountryTimeline | null;

  // Happy variant state
  positivePanel: PositiveNewsFeedPanel | null;
  countersPanel: CountersPanel | null;
  progressPanel: ProgressChartsPanel | null;
  breakthroughsPanel: BreakthroughsTickerPanel | null;
  heroPanel: HeroSpotlightPanel | null;
  digestPanel: GoodThingsDigestPanel | null;
  speciesPanel: SpeciesComebackPanel | null;
  renewablePanel: RenewableEnergyPanel | null;
  tvMode: TvModeController | null;
  isDestroyed: boolean;
  isPlaybackMode: boolean;
  isIdle: boolean;
  initialLoadComplete: boolean;
  resolvedLocation: 'global' | 'america' | 'mena' | 'eu' | 'asia' | 'latam' | 'africa' | 'oceania';

  initialUrlState: ParsedMapUrlState | null;
  readonly PANEL_ORDER_KEY: string;
  readonly PANEL_SPANS_KEY: string;
}
