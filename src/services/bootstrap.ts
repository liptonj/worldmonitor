import { RELAY_CHANNELS } from '@/config/channel-registry';
import type { NewsSourceRow } from '@/services/feed-client';
import { getPersistentCache, setPersistentCache } from '@/services/persistent-cache';
import { RELAY_HTTP_BASE, getRelayFetchHeaders } from '@/services/relay-http';
import { setChannelState } from '@/services/channel-state';

const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

/** Re-export for consumers (e.g. App.ts). Source of truth: channel-registry. */
export { RELAY_CHANNELS };

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
  const bootstrapChannels = [...RELAY_CHANNELS, `news:${variant}`];
  for (const ch of bootstrapChannels) {
    setChannelState(ch, 'loading', 'bootstrap');
  }

  try {
    const channelsParam = bootstrapChannels.join(',');
    const url = `${RELAY_HTTP_BASE}/bootstrap?variant=${encodeURIComponent(variant)}&channels=${encodeURIComponent(channelsParam)}`;
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(5_000),
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
    // Relay returns { channel: data }; Vercel returns { data: Record }. Support both.
    const data = (json.data as Record<string, unknown>) ?? json;
    const channelsWithData = new Set<string>();
    for (const [k, v] of Object.entries(data)) {
      if (v !== null && v !== undefined) {
        hydrationCache.set(k, v);
        channelsWithData.add(k);
      }
    }
    // Save for next visit (fire-and-forget)
    void setPersistentCache(cacheKey, data).catch(() => {});

    // Only mark channels as ready if they received data. Channels with no data
    // stay loading until WebSocket push or timeout (Task 3.3).
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
    // If server fetch failed but we had stale data, panels will use that
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
