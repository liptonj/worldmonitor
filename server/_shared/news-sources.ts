// server/_shared/news-sources.ts
import { getRedisClient } from './redis';
import { createAnonClient } from './supabase';

export interface DynamicFeed {
  name: string;
  url: string;
  lang: string;
  category: string;
  tier: number;
}

const CACHE_TTL = 900; // 15 minutes

function resolveFeedUrl(url: string | Record<string, string>, lang: string): string {
  return typeof url === 'string' ? url : (url[lang] ?? url['en'] ?? Object.values(url)[0] ?? '');
}

/**
 * Fetch news sources for a given variant and language via public RPC.
 * Resolution: Redis → Supabase RPC (anon) → empty array.
 */
export async function getNewsSources(
  variant: string,
  lang: string,
): Promise<Record<string, DynamicFeed[]>> {
  const cacheKey = `wm:feeds:v1:${variant}:${lang}`;
  const redis = getRedisClient();

  // 1. Redis cache
  if (redis) {
    try {
      const cached = await redis.get<string>(cacheKey);
      if (cached) {
        return JSON.parse(cached) as Record<string, DynamicFeed[]>;
      }
    } catch { /* non-fatal */ }
  }

  // 2. Supabase via public RPC (anon key — no service role needed)
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    return {};
  }

  try {
    const supabase = createAnonClient();
    const { data, error } = await supabase.rpc('get_public_news_sources', { p_variant: variant });

    if (error || !data) return {};

    const feeds: DynamicFeed[] = (data as Array<Record<string, unknown>>).map(row => ({
      name: row.name as string,
      url: resolveFeedUrl(row.url as string | Record<string, string>, lang),
      lang: row.lang as string,
      category: row.category as string,
      tier: row.tier as number,
    }));

    const filtered = feeds.filter(f => !f.lang || f.lang === lang || f.lang === 'en');

    const grouped: Record<string, DynamicFeed[]> = {};
    for (const feed of filtered) {
      (grouped[feed.category] ??= []).push(feed);
    }

    if (redis) {
      try { await redis.setex(cacheKey, CACHE_TTL, JSON.stringify(grouped)); } catch { /* non-fatal */ }
    }
    return grouped;
  } catch { return {}; }
}

/**
 * Fetch intel sources via public RPC, filtered to category='intel'.
 */
export async function getIntelSources(lang: string): Promise<DynamicFeed[]> {
  const cacheKey = `wm:feeds:intel:v1:${lang}`;
  const redis = getRedisClient();

  if (redis) {
    try {
      const cached = await redis.get<string>(cacheKey);
      if (cached) return JSON.parse(cached) as DynamicFeed[];
    } catch { /* non-fatal */ }
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) return [];

  try {
    const supabase = createAnonClient();
    // Use full variant — intel sources are tagged with variant='full'
    const { data, error } = await supabase.rpc('get_public_news_sources', { p_variant: 'full' });

    if (error || !data) return [];

    const feeds: DynamicFeed[] = (data as Array<Record<string, unknown>>)
      .filter(row => row.category === 'intel')
      .filter(row => !row.lang || (row.lang as string) === lang || (row.lang as string) === 'en')
      .map(row => ({
        name: row.name as string,
        url: resolveFeedUrl(row.url as string | Record<string, string>, lang),
        lang: row.lang as string,
        category: 'intel',
        tier: row.tier as number,
      }));

    if (redis) {
      try { await redis.setex(cacheKey, CACHE_TTL, JSON.stringify(feeds)); } catch { /* non-fatal */ }
    }
    return feeds;
  } catch { return []; }
}

export async function invalidateNewsFeedCache(): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  const variants = ['full', 'tech', 'finance', 'happy'];
  const langs = ['en', 'de', 'fr', 'es', 'ar'];
  const keys: string[] = [];
  for (const v of variants) for (const l of langs) keys.push(`wm:feeds:v1:${v}:${l}`);
  for (const l of langs) keys.push(`wm:feeds:intel:v1:${l}`);
  try { await redis.del(...keys); } catch { /* non-fatal */ }
}
