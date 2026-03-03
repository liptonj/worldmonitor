// src/services/feed-client.ts
import type { Feed } from '@/types';
import { SITE_VARIANT } from '@/config/variant';
import { SOURCE_REGION_MAP } from '@/config/feeds';

export type SourceType = 'wire' | 'gov' | 'intel' | 'mainstream' | 'market' | 'tech' | 'other';
export type PropagandaRisk = 'low' | 'medium' | 'high';
export interface SourceRiskProfile {
  risk: PropagandaRisk;
  stateAffiliated?: string;
  note?: string;
}

interface NewsSourceRow {
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

export async function loadNewsSources(): Promise<void> {
  try {
    const variant = SITE_VARIANT || 'full';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(`/api/config/news-sources?variant=${variant}`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return;
    _sources = await res.json();

    // Build grouped feeds
    _feeds = {};
    _intelSources = [];
    for (const src of _sources!) {
      const url =
        typeof src.url === 'string'
          ? `/api/rss-proxy?url=${encodeURIComponent(src.url)}`
          : src.url;
      const feed: Feed = { name: src.name, url };
      if (src.category === 'intel') {
        _intelSources.push(feed);
      } else {
        (_feeds[src.category] ??= []).push(feed);
      }
    }
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

// Re-export static structural config (still lives in feeds until Task 33)
export { SOURCE_REGION_MAP };
