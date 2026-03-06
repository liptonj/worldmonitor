// src/services/feed-client.ts
import type { Feed } from '@/types';
import { getHydratedNewsSources } from '@/services/bootstrap';
import { relayRssUrl, RELAY_HTTP_BASE } from '@/services/relay-http';

// Static structural config — region keys to label keys and feed category keys
export const SOURCE_REGION_MAP: Record<string, { labelKey: string; feedKeys: string[] }> = {
  // Full (geopolitical) variant regions
  worldwide: { labelKey: 'header.sourceRegionWorldwide', feedKeys: ['politics', 'crisis'] },
  us: { labelKey: 'header.sourceRegionUS', feedKeys: ['us', 'gov'] },
  europe: { labelKey: 'header.sourceRegionEurope', feedKeys: ['europe'] },
  middleeast: { labelKey: 'header.sourceRegionMiddleEast', feedKeys: ['middleeast'] },
  africa: { labelKey: 'header.sourceRegionAfrica', feedKeys: ['africa'] },
  latam: { labelKey: 'header.sourceRegionLatAm', feedKeys: ['latam'] },
  asia: { labelKey: 'header.sourceRegionAsiaPacific', feedKeys: ['asia'] },
  topical: { labelKey: 'header.sourceRegionTopical', feedKeys: ['energy', 'tech', 'ai', 'finance', 'layoffs', 'thinktanks'] },
  intel: { labelKey: 'header.sourceRegionIntel', feedKeys: [] },

  // Tech variant regions
  techNews: { labelKey: 'header.sourceRegionTechNews', feedKeys: ['tech', 'hardware'] },
  aiMl: { labelKey: 'header.sourceRegionAiMl', feedKeys: ['ai'] },
  startupsVc: { labelKey: 'header.sourceRegionStartupsVc', feedKeys: ['startups', 'vcblogs', 'funding', 'unicorns', 'accelerators', 'ipo'] },
  regionalTech: { labelKey: 'header.sourceRegionRegionalTech', feedKeys: ['regionalStartups'] },
  developer: { labelKey: 'header.sourceRegionDeveloper', feedKeys: ['github', 'cloud', 'dev', 'producthunt', 'outages'] },
  cybersecurity: { labelKey: 'header.sourceRegionCybersecurity', feedKeys: ['security'] },
  techPolicy: { labelKey: 'header.sourceRegionTechPolicy', feedKeys: ['policy', 'thinktanks'] },
  techMedia: { labelKey: 'header.sourceRegionTechMedia', feedKeys: ['podcasts', 'layoffs', 'finance'] },

  // Finance variant regions
  marketsAnalysis: { labelKey: 'header.sourceRegionMarkets', feedKeys: ['markets', 'analysis', 'ipo'] },
  fixedIncomeFx: { labelKey: 'header.sourceRegionFixedIncomeFx', feedKeys: ['forex', 'bonds'] },
  commoditiesRegion: { labelKey: 'header.sourceRegionCommodities', feedKeys: ['commodities'] },
  cryptoDigital: { labelKey: 'header.sourceRegionCryptoDigital', feedKeys: ['crypto', 'fintech'] },
  centralBanksEcon: { labelKey: 'header.sourceRegionCentralBanks', feedKeys: ['centralbanks', 'economic'] },
  dealsCorpFin: { labelKey: 'header.sourceRegionDeals', feedKeys: ['institutional', 'derivatives'] },
  finRegulation: { labelKey: 'header.sourceRegionFinRegulation', feedKeys: ['regulation'] },
  gulfMena: { labelKey: 'header.sourceRegionGulfMena', feedKeys: ['gccNews'] },
};

// Keywords that trigger alert status - must be specific to avoid false positives
export const ALERT_KEYWORDS = [
  'war', 'invasion', 'military', 'nuclear', 'sanctions', 'missile',
  'airstrike', 'drone strike', 'troops deployed', 'armed conflict', 'bombing', 'casualties',
  'ceasefire', 'peace treaty', 'nato', 'coup', 'martial law',
  'assassination', 'terrorist', 'terror attack', 'cyber attack', 'hostage', 'evacuation order',
];

// Patterns that indicate non-alert content (lifestyle, entertainment, etc.)
export const ALERT_EXCLUSIONS = [
  'protein', 'couples', 'relationship', 'dating', 'diet', 'fitness',
  'recipe', 'cooking', 'shopping', 'fashion', 'celebrity', 'movie',
  'tv show', 'sports', 'game', 'concert', 'festival', 'wedding',
  'vacation', 'travel tips', 'life hack', 'self-care', 'wellness',
];

export type SourceType = 'wire' | 'gov' | 'intel' | 'mainstream' | 'market' | 'tech' | 'other';
export type PropagandaRisk = 'low' | 'medium' | 'high';
export interface SourceRiskProfile {
  risk: PropagandaRisk;
  stateAffiliated?: string;
  note?: string;
}

export interface NewsSourceRow {
  name: string;
  url: string | Record<string, string>;
  tier: number;
  variants: string[];
  category: string;
  source_type: string | null;
  lang: string;
  proxy_mode: string;
  propaganda_risk: PropagandaRisk;
  state_affiliated: string | null;
  propaganda_note: string | null;
  default_enabled: boolean;
}

const FETCH_TIMEOUT_MS = 5_000;
let _sources: NewsSourceRow[] | null = null;
let _feeds: Record<string, Feed[]> | null = null;
let _intelSources: Feed[] | null = null;

function buildFeedsFromSources(): void {
  if (!_sources) return;
  _feeds = {};
  _intelSources = [];
  for (const src of _sources) {
    const url =
      typeof src.url === 'string'
        ? relayRssUrl(src.url)
        : src.url;
    const feed: Feed = { name: src.name, url };
    if (src.category === 'intel') {
      _intelSources.push(feed);
    } else {
      (_feeds[src.category] ??= []).push(feed);
    }
  }
}

export async function loadNewsSources(): Promise<void> {
  const hydrated = getHydratedNewsSources();
  if (hydrated) {
    _sources = hydrated;
    buildFeedsFromSources();
    return;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(`${RELAY_HTTP_BASE}/panel/config:news-sources`, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${import.meta.env.VITE_WS_RELAY_TOKEN ?? ''}` },
    });
    clearTimeout(timer);
    if (!res.ok) return;
    _sources = await res.json();
    buildFeedsFromSources();
  } catch {
    /* fetch failed — features degrade */
  }
}

export function getFeeds(): Record<string, Feed[]> {
  return _feeds ?? {};
}

export function getIntelSources(): Feed[] {
  return _intelSources ?? [];
}

export function getSourceTier(sourceName: string): number {
  return _sources?.find((s) => s.name === sourceName)?.tier ?? 3;
}

export function getSourceType(sourceName: string): SourceType {
  const st = _sources?.find((s) => s.name === sourceName)?.source_type;
  return (st as SourceType) ?? 'other';
}

export function getSourcePropagandaRisk(sourceName: string): SourceRiskProfile {
  const src = _sources?.find((s) => s.name === sourceName);
  if (!src) return { risk: 'low' };
  return {
    risk: src.propaganda_risk,
    stateAffiliated: src.state_affiliated ?? undefined,
    note: src.propaganda_note ?? undefined,
  };
}

export function isStateAffiliatedSource(sourceName: string): boolean {
  return !!_sources?.find((s) => s.name === sourceName)?.state_affiliated;
}

export function getSourcePanelId(sourceName: string): string {
  return _sources?.find((s) => s.name === sourceName)?.category ?? 'other';
}

export function getSourceTiersMap(): Record<string, number> {
  if (!_sources) return {};
  const map: Record<string, number> = {};
  for (const s of _sources) map[s.name] = s.tier;
  return map;
}

export function getSourceTypesMap(): Record<string, SourceType> {
  if (!_sources) return {};
  const map: Record<string, SourceType> = {};
  for (const s of _sources) map[s.name] = (s.source_type as SourceType) ?? 'other';
  return map;
}

export function getLocaleBoostedSources(locale: string): Set<string> {
  const lang = (locale.split('-')[0] ?? 'en').toLowerCase();
  const boosted = new Set<string>();
  if (lang === 'en') return boosted;
  if (!_sources) return boosted;
  for (const s of _sources) {
    if (s.lang === lang) boosted.add(s.name);
    if (typeof s.url === 'object' && lang in s.url) boosted.add(s.name);
  }
  return boosted;
}

export function computeDefaultDisabledSources(locale?: string): string[] {
  if (!_sources) return [];
  const enabled = new Set(_sources.filter((s) => s.default_enabled).map((s) => s.name));
  if (locale) {
    for (const name of getLocaleBoostedSources(locale)) enabled.add(name);
  }
  return _sources.filter((s) => !enabled.has(s.name)).map((s) => s.name);
}

export function getTotalFeedCount(): number {
  if (!_feeds) return 0;
  let count = 0;
  for (const feeds of Object.values(_feeds)) count += feeds.length;
  count += _intelSources?.length ?? 0;
  return count;
}

export function areFeedsLoaded(): boolean {
  return _sources !== null;
}
