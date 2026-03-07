import type { NewsSourceRow } from '@/services/feed-client';
import { getPersistentCache, setPersistentCache } from '@/services/persistent-cache';
import { RELAY_HTTP_BASE, getRelayFetchHeaders } from '@/services/relay-http';

const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

/** All relay channels to request in bootstrap for instant panel hydration. Must match relay PHASE4_CHANNEL_KEYS. */
const RELAY_CHANNELS = [
  'markets',
  'predictions',
  'fred',
  'oil',
  'bis',
  'flights',
  'weather',
  'natural',
  'eonet',
  'gdacs',
  'gps-interference',
  'cables',
  'cyber',
  'climate',
  'conflict',
  'ucdp-events',
  'telegram',
  'oref',
  'ais',
  'intelligence',
  'trade',
  'supply-chain',
  'giving',
  'spending',
  'gulf-quotes',
  'tech-events',
  'strategic-posture',
  'strategic-risk',
  'stablecoins',
  'etf-flows',
  'macro-signals',
  'service-status',
  'config:news-sources',
  'config:feature-flags',
  'iran-events',
  'ai:intel-digest',
  'ai:panel-summary',
  'ai:article-summaries',
  'ai:classifications',
  'ai:country-briefs',
  'ai:posture-analysis',
  'ai:instability-analysis',
  'ai:risk-overview',
] as const;

const hydrationCache = new Map<string, unknown>();

export function getHydratedData(key: string): unknown | undefined {
  const val = hydrationCache.get(key);
  if (val !== undefined) hydrationCache.delete(key);
  return val;
}

export async function fetchBootstrapData(variant: string = 'full'): Promise<void> {
  const cacheKey = `bootstrap:v2:${variant}`;

  // Phase 1: Load stale data from IndexedDB for instant hydration
  try {
    const cached = await getPersistentCache<Record<string, unknown>>(cacheKey);
    if (cached?.data && typeof cached.data === 'object') {
      const age = Date.now() - (cached.updatedAt ?? 0);
      if (age < STALE_THRESHOLD_MS) {
        for (const [k, v] of Object.entries(cached.data)) {
          if (v !== null && v !== undefined) hydrationCache.set(k, v);
        }
      }
    }
  } catch {
    /* IndexedDB unavailable */
  }

  // Phase 2: Fetch fresh data from relay
  try {
    const channelsParam = [...RELAY_CHANNELS, `news:${variant}`].join(',');
    const url = `${RELAY_HTTP_BASE}/bootstrap?variant=${encodeURIComponent(variant)}&channels=${encodeURIComponent(channelsParam)}`;
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(5_000),
      headers: getRelayFetchHeaders(),
    });
    if (!resp.ok) return;
    const json = (await resp.json()) as Record<string, unknown>;
    // Relay returns { channel: data }; Vercel returns { data: Record }. Support both.
    const data = (json.data as Record<string, unknown>) ?? json;
    for (const [k, v] of Object.entries(data)) {
      if (v !== null && v !== undefined) {
        hydrationCache.set(k, v);
      }
    }
    // Save for next visit (fire-and-forget)
    void setPersistentCache(cacheKey, data).catch(() => {});
  } catch {
    // If server fetch failed but we had stale data, panels will use that
  }
}

export function getHydratedNewsSources(): NewsSourceRow[] | null {
  const val = hydrationCache.get('newsSources');
  if (val !== undefined) {
    hydrationCache.delete('newsSources');
    if (!Array.isArray(val)) return null;
    return val as NewsSourceRow[];
  }
  return null;
}

export function getHydratedFeatureFlags(): Record<string, unknown> | null {
  const val = hydrationCache.get('featureFlags');
  if (val !== undefined) {
    hydrationCache.delete('featureFlags');
    if (typeof val !== 'object' || val === null || Array.isArray(val)) return null;
    return val as Record<string, unknown>;
  }
  return null;
}
