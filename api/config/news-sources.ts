import { getCorsHeaders } from '../../server/cors';
import { getRedisClient } from '../../server/_shared/redis';
import { createServiceClient } from '../../server/_shared/supabase';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  const headers = {
    ...getCorsHeaders(req),
    'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60',
  };

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'GET') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });

  const url = new URL(req.url);
  const variant = url.searchParams.get('variant') || 'full';
  const cacheKey = `wm:config:sources:v1:${variant}`;
  const redis = getRedisClient();

  // Redis cache
  if (redis) {
    try {
      const cached = await redis.get<string>(cacheKey);
      if (cached) return new Response(cached, { status: 200, headers });
    } catch { /* non-fatal */ }
  }

  // Supabase
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ error: 'Configuration unavailable' }), { status: 503, headers });
  }

  try {
    const supabase = createServiceClient();
    const { data, error } = await supabase
      .schema('wm_admin')
      .from('news_sources')
      .select('name, url, tier, variants, category, source_type, lang, proxy_mode, propaganda_risk, state_affiliated, propaganda_note, default_enabled')
      .eq('enabled', true)
      .contains('variants', [variant])
      .order('tier', { ascending: true })
      .order('name', { ascending: true });

    if (error) return new Response(JSON.stringify({ error: 'Failed to load sources' }), { status: 500, headers });

    const json = JSON.stringify(data);
    if (redis) {
      try { await redis.setex(cacheKey, 300, json); } catch { /* non-fatal */ }
    }
    return new Response(json, { status: 200, headers });
  } catch {
    return new Response(JSON.stringify({ error: 'Configuration unavailable' }), { status: 503, headers });
  }
}
