/**
 * News digest — bootstrap hydration only. WS push (news:{variant} channel) handles live updates.
 * No HTTP fetch. If bootstrap has no digest, caller falls back to persisted IndexedDB copy.
 */
import type { ListFeedDigestResponse } from '@/generated/client/worldmonitor/news/v1/service_client';
import { SITE_VARIANT } from '@/config';
import { getHydratedData } from '@/services/bootstrap';

let _pendingRawNewsData: unknown;

export function fetchNewsDigest(_timeoutMs: number): ListFeedDigestResponse | null {
  const variant = SITE_VARIANT || 'full';
  const data = getHydratedData(`news:${variant}`);
  if (!data) return null;

  if (
    typeof data === 'object' &&
    !Array.isArray(data) &&
    Object.keys((data as Record<string, unknown>).categories ?? {}).length > 0
  ) {
    return data as ListFeedDigestResponse;
  }

  // Relay sent a flat array (or envelope with .data) — not a structured digest.
  // Stash it so loadNews can route it through applyNewsDigest instead.
  _pendingRawNewsData = data;
  return null;
}

/**
 * Returns raw bootstrap news data that fetchNewsDigest couldn't parse as a
 * structured digest (typically a flat array from the relay). Single-use: the
 * stash is cleared after the first read.
 */
export function consumePendingRawNewsData(): unknown | undefined {
  const val = _pendingRawNewsData;
  _pendingRawNewsData = undefined;
  return val;
}
