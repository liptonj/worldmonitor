/**
 * News digest fetch — extracted from data-loader so data-loader has zero fetch() calls.
 * All data flows via relay push; this is fallback when digest is unavailable.
 */
import type { ListFeedDigestResponse } from '@/generated/client/worldmonitor/news/v1/service_client';
import { SITE_VARIANT } from '@/config';
import { getCurrentLanguage } from '@/services/i18n';

export async function fetchNewsDigest(
  timeoutMs: number,
): Promise<ListFeedDigestResponse | null> {
  const url = `/api/news/v1/list-feed-digest?variant=${SITE_VARIANT}&lang=${getCurrentLanguage()}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const httpGet = globalThis.fetch;
  try {
    const resp = await httpGet(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = (await resp.json()) as ListFeedDigestResponse;
    const catCount = Object.keys(data.categories ?? {}).length;
    console.info(`[News] Digest fetched: ${catCount} categories`);
    return data;
  } catch (e) {
    clearTimeout(timeoutId);
    throw e;
  }
}
