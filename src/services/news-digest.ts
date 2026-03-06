/**
 * News digest fetch — relay is the primary source (cached in Redis, broadcast via WS).
 * Falls back to Vercel only if relay is unavailable.
 */
import type { ListFeedDigestResponse } from '@/generated/client/worldmonitor/news/v1/service_client';
import { SITE_VARIANT } from '@/config';
import { getCurrentLanguage } from '@/services/i18n';
import { RELAY_HTTP_BASE } from '@/services/relay-http';

export async function fetchNewsDigest(
  timeoutMs: number,
): Promise<ListFeedDigestResponse | null> {
  const variant = SITE_VARIANT || 'full';
  const lang = getCurrentLanguage();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const httpGet = globalThis.fetch;

  try {
    // Primary: relay Redis cache (fastest, no Vercel cold start)
    const relayResp = await httpGet(`${RELAY_HTTP_BASE}/panel/news:${variant}`, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${import.meta.env.VITE_WS_RELAY_TOKEN ?? ''}` },
    });
    clearTimeout(timeoutId);
    if (relayResp.ok) {
      const data = (await relayResp.json()) as ListFeedDigestResponse;
      if (Object.keys(data.categories ?? {}).length > 0) return data;
    }
  } catch {
    clearTimeout(timeoutId);
    // Relay unavailable — fall through to Vercel
  }

  // Fallback: Vercel (relay cold or offline)
  const fallbackController = new AbortController();
  const fallbackTimeout = setTimeout(() => fallbackController.abort(), timeoutMs);
  try {
    const resp = await httpGet(
      `/api/news/v1/list-feed-digest?variant=${variant}&lang=${lang}`,
      { signal: fallbackController.signal },
    );
    clearTimeout(fallbackTimeout);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return (await resp.json()) as ListFeedDigestResponse;
  } catch (e) {
    clearTimeout(fallbackTimeout);
    throw e;
  }
}
