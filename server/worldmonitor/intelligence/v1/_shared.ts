/**
 * Shared constants, types, and helpers used by multiple intelligence RPCs.
 */

import { getRedisClient } from '../../../_shared/redis';

// ========================================================================
// Constants
// ========================================================================

export const UPSTREAM_TIMEOUT_MS = 30_000;
export const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
export const GROQ_MODEL = 'llama-3.1-8b-instant';

// ========================================================================
// Tier-1 country definitions (used by risk-scores + country-intel-brief)
// ========================================================================

export const TIER1_COUNTRIES: Record<string, string> = {
  US: 'United States', RU: 'Russia', CN: 'China', UA: 'Ukraine', IR: 'Iran',
  IL: 'Israel', TW: 'Taiwan', KP: 'North Korea', SA: 'Saudi Arabia', TR: 'Turkey',
  PL: 'Poland', DE: 'Germany', FR: 'France', GB: 'United Kingdom', IN: 'India',
  PK: 'Pakistan', SY: 'Syria', YE: 'Yemen', MM: 'Myanmar', VE: 'Venezuela',
};

// ========================================================================
// Helpers
// ========================================================================

export { hashString } from '../../../_shared/hash';

/**
 * Fetch recent headlines from Redis lists (wm:headlines:{scope}), deduplicate by title,
 * sort by pubDate descending, take top N, and format as numbered list.
 */
export async function fetchRecentHeadlines(
  scopes: string[],
  maxCount: number,
): Promise<string> {
  const redis = getRedisClient();
  const allHeadlines: Array<{ title: string; pubDate: number }> = [];

  if (redis) {
    for (const scope of scopes) {
      try {
        const items = await redis.lrange(`wm:headlines:${scope}`, 0, maxCount - 1);
        for (const item of items) {
          try {
            const parsed = JSON.parse(item) as { title?: string; pubDate?: number };
            if (parsed.title) {
              allHeadlines.push({ title: parsed.title, pubDate: parsed.pubDate ?? 0 });
            }
          } catch {
            /* skip malformed */
          }
        }
      } catch {
        /* non-fatal */
      }
    }
  }

  const seen = new Set<string>();
  const headlines = allHeadlines
    .filter((h) => {
      if (seen.has(h.title)) return false;
      seen.add(h.title);
      return true;
    })
    .sort((a, b) => b.pubDate - a.pubDate)
    .slice(0, maxCount);

  return headlines.length > 0
    ? headlines.map((h, i) => `${i + 1}. ${h.title}`).join('\n')
    : 'No recent headlines available';
}
