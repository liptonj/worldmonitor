import type { NewsSourceRow } from '@/services/feed-client';

const hydrationCache = new Map<string, unknown>();

export function getHydratedData(key: string): unknown | undefined {
  const val = hydrationCache.get(key);
  if (val !== undefined) hydrationCache.delete(key);
  return val;
}

export async function fetchBootstrapData(variant: string = 'full'): Promise<void> {
  try {
    const resp = await fetch(`/api/bootstrap?variant=${encodeURIComponent(variant)}`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!resp.ok) return;
    const { data } = (await resp.json()) as { data: Record<string, unknown> };
    for (const [k, v] of Object.entries(data)) {
      if (v !== null && v !== undefined) {
        hydrationCache.set(k, v);
      }
    }
  } catch {
    // silent — panels fall through to individual calls
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
