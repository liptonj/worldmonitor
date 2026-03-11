/**
 * Channel Registry — Single source of truth for relay channels.
 *
 * Replaces the "4 registries" problem: RELAY_CHANNELS, PHASE4_CHANNEL_KEYS,
 * setupRelayPush wiring, and DEFAULT_PANELS channel declarations.
 *
 * When adding a new channel:
 * 1. Add entry to CHANNEL_REGISTRY below.
 * 2. If DataLoader handles it: set applyMethod to the apply* method name (e.g. 'applyMarkets').
 * 3. If panel/config/AI handles it: omit applyMethod; App.getPushHandler has the logic.
 *
 * @see docs/plans/2026-03-09-frontend-refactor.md
 */

import type { MapLayers } from '@/types';

/** Domain for grouping apply* handlers. news reserved for future channels (e.g. news:full). */
export type DataDomain =
  | 'news'
  | 'markets'
  | 'economic'
  | 'intelligence'
  | 'geo'
  | 'military'
  | 'infrastructure'
  | 'ai'
  | 'config';

export interface ChannelDefinition {
  key: string;
  redisKey: string;
  panels: string[];
  domain: DataDomain;
  staleAfterMs: number;
  timeoutMs: number;
  required: boolean;
  mapLayers?: (keyof MapLayers)[];
  /** DataLoader apply* method name. Omit for panel/config/AI channels (handled in App.getPushHandler). */
  applyMethod?: string;
}

/** All relay channels with their Redis keys, panel mappings, and metadata. */
export const CHANNEL_REGISTRY: Record<string, ChannelDefinition> = {
  markets: {
    key: 'markets',
    redisKey: 'market:dashboard:v1',
    panels: ['markets', 'heatmap', 'commodities', 'crypto'],
    domain: 'markets',
    staleAfterMs: 5 * 60_000,
    timeoutMs: 30_000,
    required: true,
    applyMethod: 'applyMarkets',
  },
  predictions: {
    key: 'predictions',
    redisKey: 'relay:predictions:v1',
    panels: ['polymarket'],
    domain: 'markets',
    staleAfterMs: 5 * 60_000,
    timeoutMs: 30_000,
    required: false,
    applyMethod: 'applyPredictions',
  },
  fred: {
    key: 'fred',
    redisKey: 'relay:fred:v1',
    panels: ['commodities', 'economic'],
    domain: 'economic',
    staleAfterMs: 15 * 60_000,
    timeoutMs: 30_000,
    required: true,
    applyMethod: 'applyFredData',
  },
  oil: {
    key: 'oil',
    redisKey: 'relay:oil:v1',
    panels: ['commodities', 'economic'],
    domain: 'economic',
    staleAfterMs: 5 * 60_000,
    timeoutMs: 30_000,
    required: true,
    applyMethod: 'applyOilData',
  },
  bis: {
    key: 'bis',
    redisKey: 'relay:bis:v1',
    panels: ['commodities', 'economic'],
    domain: 'economic',
    staleAfterMs: 15 * 60_000,
    timeoutMs: 30_000,
    required: true,
    applyMethod: 'applyBisData',
  },
  flights: {
    key: 'flights',
    redisKey: 'relay:flights:v1',
    panels: ['map'],
    domain: 'infrastructure',
    staleAfterMs: 5 * 60_000,
    timeoutMs: 30_000,
    required: false,
    mapLayers: ['flights'],
    applyMethod: 'applyFlightDelays',
  },
  weather: {
    key: 'weather',
    redisKey: 'relay:weather:v1',
    panels: ['map'],
    domain: 'geo',
    staleAfterMs: 5 * 60_000,
    timeoutMs: 30_000,
    required: false,
    mapLayers: ['weather'],
    applyMethod: 'applyWeatherAlerts',
  },
  natural: {
    key: 'natural',
    redisKey: 'relay:natural:v1',
    panels: ['map', 'satellite-fires'],
    domain: 'geo',
    staleAfterMs: 10 * 60_000,
    timeoutMs: 30_000,
    required: false,
    mapLayers: ['natural'],
    applyMethod: 'applyNatural',
  },
  eonet: {
    key: 'eonet',
    redisKey: 'relay:eonet:v1',
    panels: ['map'],
    domain: 'geo',
    staleAfterMs: 10 * 60_000,
    timeoutMs: 30_000,
    required: false,
    mapLayers: ['natural'],
    applyMethod: 'applyEonet',
  },
  gdacs: {
    key: 'gdacs',
    redisKey: 'relay:gdacs:v1',
    panels: ['map'],
    domain: 'geo',
    staleAfterMs: 10 * 60_000,
    timeoutMs: 30_000,
    required: false,
    mapLayers: ['natural'],
    applyMethod: 'applyGdacs',
  },
  'gps-interference': {
    key: 'gps-interference',
    redisKey: 'relay:gps-interference:v1',
    panels: ['map'],
    domain: 'infrastructure',
    staleAfterMs: 10 * 60_000,
    timeoutMs: 30_000,
    required: false,
    mapLayers: ['gpsJamming'],
    applyMethod: 'applyGpsInterference',
  },
  cables: {
    key: 'cables',
    redisKey: 'relay:cables:v1',
    panels: ['cascade', 'map'],
    domain: 'infrastructure',
    staleAfterMs: 10 * 60_000,
    timeoutMs: 30_000,
    required: false,
    mapLayers: ['cables'],
    applyMethod: 'applyCableHealth',
  },
  cyber: {
    key: 'cyber',
    redisKey: 'relay:cyber:v1',
    panels: ['cascade', 'map'],
    domain: 'infrastructure',
    staleAfterMs: 10 * 60_000,
    timeoutMs: 30_000,
    required: false,
    mapLayers: ['cyberThreats'],
    applyMethod: 'applyCyberThreats',
  },
  climate: {
    key: 'climate',
    redisKey: 'relay:climate:v1',
    panels: ['climate', 'map'],
    domain: 'geo',
    staleAfterMs: 15 * 60_000,
    timeoutMs: 30_000,
    required: false,
    mapLayers: ['climate'],
    applyMethod: 'applyClimate',
  },
  conflict: {
    key: 'conflict',
    redisKey: 'relay:conflict:v1',
    panels: ['cii', 'intel', 'map'],
    domain: 'intelligence',
    staleAfterMs: 10 * 60_000,
    timeoutMs: 30_000,
    required: true,
    mapLayers: ['conflicts'],
    applyMethod: 'applyConflict',
  },
  'ucdp-events': {
    key: 'ucdp-events',
    redisKey: 'conflict:ucdp-events:v1',
    panels: ['ucdp-events', 'map'],
    domain: 'intelligence',
    staleAfterMs: 10 * 60_000,
    timeoutMs: 30_000,
    required: false,
    mapLayers: ['ucdpEvents'],
    applyMethod: 'applyUcdpEvents',
  },
  telegram: {
    key: 'telegram',
    redisKey: 'relay:telegram:v1',
    panels: ['telegram-intel', 'intel'],
    domain: 'intelligence',
    staleAfterMs: 5 * 60_000,
    timeoutMs: 30_000,
    required: false,
    applyMethod: 'applyTelegramIntel',
  },
  oref: {
    key: 'oref',
    redisKey: 'relay:oref:v1',
    panels: ['oref-sirens', 'map'],
    domain: 'intelligence',
    staleAfterMs: 1 * 60_000,
    timeoutMs: 30_000,
    required: false,
    mapLayers: ['conflicts'],
    applyMethod: 'applyOref',
  },
  ais: {
    key: 'ais',
    redisKey: 'relay:ais-snapshot:v1',
    panels: ['map'],
    domain: 'infrastructure',
    staleAfterMs: 5 * 60_000,
    timeoutMs: 30_000,
    required: false,
    mapLayers: ['ais'],
    applyMethod: 'applyAisSignals',
  },
  opensky: {
    key: 'opensky',
    redisKey: 'relay:opensky:v1',
    panels: ['map'],
    domain: 'infrastructure',
    staleAfterMs: 5 * 60_000,
    timeoutMs: 30_000,
    required: false,
    mapLayers: ['flights'],
    applyMethod: 'applyOpenSky',
  },
  gdelt: {
    key: 'gdelt',
    redisKey: 'relay:gdelt:v1',
    panels: ['gdelt-intel'],
    domain: 'intelligence',
    staleAfterMs: 15 * 60_000,
    timeoutMs: 30_000,
    required: false,
    applyMethod: 'applyGdelt',
  },
  /** Backward-compat alias for ai:intel-digest; both share ai:digest:global:v1 (gateway PHASE4_CHANNEL_KEYS). */
  intelligence: {
    key: 'intelligence',
    redisKey: 'ai:digest:global:v1',
    panels: ['intel', 'gdelt-intel', 'global-digest'],
    domain: 'intelligence',
    staleAfterMs: 15 * 60_000,
    timeoutMs: 30_000,
    required: true,
    applyMethod: 'applyIntelligence',
  },
  trade: {
    key: 'trade',
    redisKey: 'relay:trade:v1',
    panels: ['commodities', 'trade-policy'],
    domain: 'economic',
    staleAfterMs: 15 * 60_000,
    timeoutMs: 30_000,
    required: true,
    applyMethod: 'applyTradePolicy',
  },
  'supply-chain': {
    key: 'supply-chain',
    redisKey: 'supply_chain:chokepoints:v1',
    panels: ['commodities', 'supply-chain', 'cascade'],
    domain: 'economic',
    staleAfterMs: 15 * 60_000,
    timeoutMs: 30_000,
    required: true,
    applyMethod: 'applySupplyChain',
  },
  giving: {
    key: 'giving',
    redisKey: 'giving:summary:v1',
    panels: ['giving'],
    domain: 'economic',
    staleAfterMs: 15 * 60_000,
    timeoutMs: 30_000,
    required: false,
    applyMethod: 'applyGiving',
  },
  spending: {
    key: 'spending',
    redisKey: 'relay:spending:v1',
    panels: ['map', 'economic'],
    domain: 'economic',
    staleAfterMs: 15 * 60_000,
    timeoutMs: 30_000,
    required: false,
    mapLayers: ['economic'],
    applyMethod: 'applySpending',
  },
  'gulf-quotes': {
    key: 'gulf-quotes',
    redisKey: 'relay:gulf-quotes:v1',
    panels: ['gulf-economies'],
    domain: 'markets',
    staleAfterMs: 5 * 60_000,
    timeoutMs: 30_000,
    required: false,
    applyMethod: 'applyGulfQuotes',
  },
  'tech-events': {
    key: 'tech-events',
    redisKey: 'relay:tech-events:v1',
    panels: ['events'],
    domain: 'infrastructure',
    staleAfterMs: 10 * 60_000,
    timeoutMs: 30_000,
    required: false,
    mapLayers: ['techEvents'],
    applyMethod: 'applyTechEvents',
  },
  'security-advisories': {
    key: 'security-advisories',
    redisKey: 'relay:security-advisories:v1',
    panels: ['security-advisories'],
    domain: 'infrastructure',
    staleAfterMs: 60 * 60_000,
    timeoutMs: 30_000,
    required: false,
  },
  'strategic-posture': {
    key: 'strategic-posture',
    redisKey: 'theater-posture:sebuf:v1',
    panels: ['strategic-posture'],
    domain: 'intelligence',
    staleAfterMs: 15 * 60_000,
    timeoutMs: 30_000,
    required: true,
  },
  'strategic-risk': {
    key: 'strategic-risk',
    redisKey: 'risk:scores:sebuf:v1',
    panels: ['strategic-risk', 'cii'],
    domain: 'intelligence',
    staleAfterMs: 15 * 60_000,
    timeoutMs: 30_000,
    required: true,
  },
  stablecoins: {
    key: 'stablecoins',
    redisKey: 'relay:stablecoins:v1',
    panels: ['stablecoins'],
    domain: 'markets',
    staleAfterMs: 5 * 60_000,
    timeoutMs: 30_000,
    required: false,
  },
  'etf-flows': {
    key: 'etf-flows',
    redisKey: 'relay:etf-flows:v1',
    panels: ['etf-flows'],
    domain: 'markets',
    staleAfterMs: 5 * 60_000,
    timeoutMs: 30_000,
    required: false,
  },
  'macro-signals': {
    key: 'macro-signals',
    redisKey: 'economic:macro-signals:v1',
    panels: ['macro-signals'],
    domain: 'markets',
    staleAfterMs: 5 * 60_000,
    timeoutMs: 30_000,
    required: false,
  },
  'service-status': {
    key: 'service-status',
    redisKey: 'relay:service-status:v1',
    panels: ['service-status'],
    domain: 'infrastructure',
    staleAfterMs: 2 * 60_000,
    timeoutMs: 30_000,
    required: false,
  },
  'config:news-sources': {
    key: 'config:news-sources',
    redisKey: 'relay:config:news-sources',
    panels: [],
    domain: 'config',
    staleAfterMs: 5 * 60_000,
    timeoutMs: 30_000,
    required: false,
  },
  'config:feature-flags': {
    key: 'config:feature-flags',
    redisKey: 'relay:config:feature-flags',
    panels: [],
    domain: 'config',
    staleAfterMs: 5 * 60_000,
    timeoutMs: 30_000,
    required: false,
  },
  'iran-events': {
    key: 'iran-events',
    redisKey: 'conflict:iran-events:v1',
    panels: ['map'],
    domain: 'intelligence',
    staleAfterMs: 5 * 60_000,
    timeoutMs: 30_000,
    required: false,
    mapLayers: ['iranAttacks'],
    applyMethod: 'applyIranEvents',
  },
  /** Canonical AI digest channel; intelligence is alias. Same Redis key (gateway test: backward-compat). */
  'ai:intel-digest': {
    key: 'ai:intel-digest',
    redisKey: 'ai:digest:global:v1',
    panels: ['global-digest'],
    domain: 'ai',
    staleAfterMs: 15 * 60_000,
    timeoutMs: 30_000,
    required: false,
  },
  'ai:panel-summary': {
    key: 'ai:panel-summary',
    redisKey: 'ai:panel-summary:v1',
    panels: ['insights'],
    domain: 'ai',
    staleAfterMs: 15 * 60_000,
    timeoutMs: 30_000,
    required: false,
  },
  'ai:article-summaries': {
    key: 'ai:article-summaries',
    redisKey: 'ai:article-summaries:v1',
    panels: [],
    domain: 'ai',
    staleAfterMs: 15 * 60_000,
    timeoutMs: 30_000,
    required: false,
  },
  'ai:classifications': {
    key: 'ai:classifications',
    redisKey: 'ai:classifications:v1',
    panels: [],
    domain: 'ai',
    staleAfterMs: 15 * 60_000,
    timeoutMs: 30_000,
    required: false,
  },
  'ai:country-briefs': {
    key: 'ai:country-briefs',
    redisKey: 'ai:country-briefs:v1',
    panels: ['cii'],
    domain: 'ai',
    staleAfterMs: 15 * 60_000,
    timeoutMs: 30_000,
    required: false,
  },
  'ai:posture-analysis': {
    key: 'ai:posture-analysis',
    redisKey: 'ai:posture-analysis:v1',
    panels: ['strategic-posture'],
    domain: 'ai',
    staleAfterMs: 15 * 60_000,
    timeoutMs: 30_000,
    required: false,
  },
  'ai:instability-analysis': {
    key: 'ai:instability-analysis',
    redisKey: 'ai:instability-analysis:v1',
    panels: ['strategic-risk'],
    domain: 'ai',
    staleAfterMs: 15 * 60_000,
    timeoutMs: 30_000,
    required: false,
  },
  'ai:risk-overview': {
    key: 'ai:risk-overview',
    redisKey: 'ai:risk-overview:v1',
    panels: ['strategic-risk'],
    domain: 'ai',
    staleAfterMs: 15 * 60_000,
    timeoutMs: 30_000,
    required: false,
  },
  'ai:telegram-summary': {
    key: 'ai:telegram-summary',
    redisKey: 'ai:telegram-summary:v1',
    panels: ['telegram-summary'],
    domain: 'ai',
    staleAfterMs: 10 * 60_000,
    timeoutMs: 30_000,
    required: false,
  },
  /** News digest channels — variant-specific. Handled by createNewsHandlers. */
  'news:full': {
    key: 'news:full',
    redisKey: 'news:digest:v1:full:en',
    panels: ['live-news', 'headlines'],
    domain: 'news',
    staleAfterMs: 5 * 60_000,
    timeoutMs: 30_000,
    required: false,
  },
  'news:tech': {
    key: 'news:tech',
    redisKey: 'news:digest:v1:tech:en',
    panels: ['live-news', 'headlines'],
    domain: 'news',
    staleAfterMs: 5 * 60_000,
    timeoutMs: 30_000,
    required: false,
  },
  'news:finance': {
    key: 'news:finance',
    redisKey: 'news:digest:v1:finance:en',
    panels: ['live-news', 'headlines'],
    domain: 'news',
    staleAfterMs: 5 * 60_000,
    timeoutMs: 30_000,
    required: false,
  },
  'news:happy': {
    key: 'news:happy',
    redisKey: 'news:digest:v1:happy:en',
    panels: ['live-news', 'headlines'],
    domain: 'news',
    staleAfterMs: 5 * 60_000,
    timeoutMs: 30_000,
    required: false,
  },
  /** PizzINT monitoring — full variant only. Handled by createIntelligenceHandlers. */
  pizzint: {
    key: 'pizzint',
    redisKey: 'intel:pizzint:v1',
    panels: ['intel'],
    domain: 'intelligence',
    staleAfterMs: 10 * 60_000,
    timeoutMs: 30_000,
    required: false,
  },
};

/** Channel keys for bootstrap and WebSocket subscription. Replaces RELAY_CHANNELS. */
export const RELAY_CHANNELS = Object.keys(CHANNEL_REGISTRY);

/** Map channel key → Redis key. Replaces PHASE4_CHANNEL_KEYS. */
export const REDIS_KEY_MAP = Object.fromEntries(
  Object.entries(CHANNEL_REGISTRY).map(([k, v]) => [k, v.redisKey])
);

/**
 * Channel → DataLoader apply* method. Derived from CHANNEL_REGISTRY.
 * Used by DataLoader.getHandler and tests. News and pizzint are handled by domain handlers.
 */
export const DATA_LOADER_CHANNEL_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(CHANNEL_REGISTRY)
    .filter(([, def]) => def.applyMethod != null)
    .map(([k, def]) => [k, def.applyMethod!])
);
