import { getCorsHeaders } from '../../server/cors';
import { getRedisClient } from '../../server/_shared/redis';
import { createAnonClient } from '../../server/_shared/supabase';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  const headers = {
    ...getCorsHeaders(req),
    'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60',
  };

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'GET') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });

  const cacheKey = 'wm:config:flags:v1';
  const redis = getRedisClient();

  // Redis cache
  if (redis) {
    try {
      const cached = await redis.get<string>(cacheKey);
      if (cached) return new Response(cached, { status: 200, headers });
    } catch { /* non-fatal */ }
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    return new Response(JSON.stringify({ error: 'Configuration unavailable' }), { status: 503, headers });
  }

  try {
    const supabase = createAnonClient();
    const { data, error } = await supabase
      .rpc('get_public_feature_flags');

    if (error) return new Response(JSON.stringify({ error: 'Failed to load flags' }), { status: 500, headers });

    const flags: Record<string, unknown> = {};
    for (const row of data ?? []) {
      flags[row.key] = row.value;
    }

    const json = JSON.stringify(flags);
    if (redis) {
      try { await redis.setex(cacheKey, 300, json); } catch { /* non-fatal */ }
    }
    return new Response(json, { status: 200, headers });
  } catch {
    return new Response(JSON.stringify({ error: 'Configuration unavailable' }), { status: 503, headers });
  }
}
