/**
 * News digest fetch — relay Redis cache only. No Vercel fallback.
 */
import type { ListFeedDigestResponse } from '@/generated/client/worldmonitor/news/v1/service_client';
import { SITE_VARIANT } from '@/config';
import { RELAY_HTTP_BASE } from '@/services/relay-http';

export async function fetchNewsDigest(
  timeoutMs: number,
): Promise<ListFeedDigestResponse | null> {
  const variant = SITE_VARIANT || 'full';
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await globalThis.fetch(`${RELAY_HTTP_BASE}/panel/news:${variant}`, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${import.meta.env.VITE_WS_RELAY_TOKEN ?? ''}` },
    });
    clearTimeout(timeoutId);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = (await resp.json()) as ListFeedDigestResponse;
    if (Object.keys(data.categories ?? {}).length === 0) throw new Error('Empty digest');
    return data;
  } catch (e) {
    clearTimeout(timeoutId);
    throw e;
  }
}
