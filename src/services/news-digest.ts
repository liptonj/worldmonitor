/**
 * News digest — bootstrap hydration only. WS push (news:{variant} channel) handles live updates.
 * No HTTP fetch. If bootstrap has no digest, caller falls back to persisted IndexedDB copy.
 */
import type { ListFeedDigestResponse } from '@/generated/client/worldmonitor/news/v1/service_client';
import { SITE_VARIANT } from '@/config';
import { getHydratedData } from '@/services/bootstrap';

export function fetchNewsDigest(_timeoutMs: number): ListFeedDigestResponse | null {
  const variant = SITE_VARIANT || 'full';
  const data = getHydratedData(`news:${variant}`) as ListFeedDigestResponse | undefined;
  if (!data || Object.keys(data.categories ?? {}).length === 0) return null;
  return data;
}
