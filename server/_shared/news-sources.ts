// server/_shared/news-sources.ts
import { getRedisClient } from './redis';
import { createServiceClient } from './supabase';

export interface DynamicFeed {
  name: string;
  url: string;
  lang: string;
  category: string;
  tier: number;
}

const CACHE_TTL = 900; // 15 minutes

/**
 * Fetch news sources for a given variant and language.
 * Resolution: Redis → Supabase → empty array (no hardcoded fallback).
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
      const cached = await redis.get<Record<string, DynamicFeed[]>>(cacheKey);
      if (cached) return cached;
    } catch { /* non-fatal */ }
  }

  // 2. Supabase
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return {};
  }

  try {
    const supabase = createServiceClient();
    const { data, error } = await supabase
      .schema('wm_admin')
      .from('news_sources')
      .select('name, url, lang, category, tier')
      .eq('enabled', true)
      .contains('variants', [variant]);

    if (error || !data) return {};

    const feeds: DynamicFeed[] = data.map(row => ({
      name: row.name,
      url: typeof row.url === 'string' ? row.url : (row.url[lang] ?? row.url['en'] ?? Object.values(row.url)[0]),
      lang: row.lang,
      category: row.category,
      tier: row.tier,
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
 * Fetch intel sources (variant='full', source_type IS NOT NULL).
 */
export async function getIntelSources(lang: string): Promise<DynamicFeed[]> {
  const cacheKey = `wm:feeds:intel:v1:${lang}`;
  const redis = getRedisClient();

  if (redis) {
    try {
      const cached = await redis.get<DynamicFeed[]>(cacheKey);
      if (cached) return cached;
    } catch { /* non-fatal */ }
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return [];

  try {
    const supabase = createServiceClient();
    const { data, error } = await supabase
      .schema('wm_admin')
      .from('news_sources')
      .select('name, url, lang, category, tier')
      .eq('enabled', true)
      .eq('category', 'intel')
      .not('source_type', 'is', null);

    if (error || !data) return [];

    const feeds: DynamicFeed[] = data
      .filter(row => !row.lang || row.lang === lang || row.lang === 'en')
      .map(row => ({
        name: row.name,
        url: typeof row.url === 'string' ? row.url : (row.url[lang] ?? row.url['en'] ?? Object.values(row.url)[0]),
        lang: row.lang,
        category: 'intel',
        tier: row.tier,
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
  // Delete known cache key patterns; others expire naturally after 15 min
  const variants = ['full', 'tech', 'finance', 'happy'];
  const langs = ['en', 'de', 'fr', 'es', 'ar'];
  const keys: string[] = [];
  for (const v of variants) for (const l of langs) keys.push(`wm:feeds:v1:${v}:${l}`);
  for (const l of langs) keys.push(`wm:feeds:intel:v1:${l}`);
  try { await redis.del(...keys); } catch { /* non-fatal */ }
}
