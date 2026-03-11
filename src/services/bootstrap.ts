import { RELAY_CHANNELS } from '@/config/channel-registry';
import type { NewsSourceRow } from '@/services/feed-client';
import { getPersistentCache, setPersistentCache } from '@/services/persistent-cache';
import { RELAY_HTTP_BASE, getRelayFetchHeaders } from '@/services/relay-http';
import { setChannelState } from '@/services/channel-state';

const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

/** Re-export for consumers (e.g. App.ts). Source of truth: channel-registry. */
export { RELAY_CHANNELS };

const hydrationCache = new Map<string, unknown>();
const consumedKeys = new Set<string>();

export function getHydratedData(key: string): unknown | undefined {
  if (consumedKeys.has(key)) return undefined;
  const val = hydrationCache.get(key);
  if (val !== undefined) consumedKeys.add(key);
  return val;
}

export async function fetchBootstrapData(variant: string = 'full'): Promise<void> {
  const cacheKey = `bootstrap:v2:${variant}`;

  // Mark all channels loading immediately so panels see state transitions
  // even if the IndexedDB phase below is slow.
  const bootstrapChannels = [...RELAY_CHANNELS, `news:${variant}`];
  for (const ch of bootstrapChannels) {
    setChannelState(ch, 'loading', 'bootstrap');
  }

  // Phase 1: Load stale data from IndexedDB for instant hydration.
  // Guard with a timeout — IndexedDB can hang on some browsers/devices.
  try {
    const cachePromise = getPersistentCache<Record<string, unknown>>(cacheKey);
    const cached = await Promise.race([
      cachePromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 3_000)),
    ]);
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
    const channelsParam = bootstrapChannels.join(',');
    const url = `${RELAY_HTTP_BASE}/bootstrap?variant=${encodeURIComponent(variant)}&channels=${encodeURIComponent(channelsParam)}`;
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      headers: getRelayFetchHeaders(),
    });
    if (!resp.ok) {
      const errMsg = `Bootstrap fetch failed: ${resp.status} ${resp.statusText}`;
      for (const ch of bootstrapChannels) {
        setChannelState(ch, 'error', 'bootstrap', { error: errMsg });
      }
      return;
    }
    const json = (await resp.json()) as Record<string, unknown>;
    const data = (json.data as Record<string, unknown>) ?? json;
    const channelsWithData = new Set<string>();
    for (const [k, v] of Object.entries(data)) {
      if (v !== null && v !== undefined) {
        hydrationCache.set(k, v);
        channelsWithData.add(k);
      }
    }
    void setPersistentCache(cacheKey, data).catch(() => {});

    for (const ch of bootstrapChannels) {
      if (channelsWithData.has(ch)) {
        setChannelState(ch, 'ready', 'bootstrap');
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Bootstrap fetch failed';
    for (const ch of bootstrapChannels) {
      setChannelState(ch, 'error', 'bootstrap', { error: errMsg });
    }
  }
}

export function getHydratedNewsSources(): NewsSourceRow[] | null {
  const val = hydrationCache.get('config:news-sources');
  if (val !== undefined) {
    hydrationCache.delete('config:news-sources');
    if (!Array.isArray(val)) return null;
    return val as NewsSourceRow[];
  }
  return null;
}

export function getHydratedFeatureFlags(): Record<string, unknown> | null {
  const val = hydrationCache.get('config:feature-flags');
  if (val !== undefined) {
    hydrationCache.delete('config:feature-flags');
    if (typeof val !== 'object' || val === null || Array.isArray(val)) return null;
    return val as Record<string, unknown>;
  }
  return null;
}
