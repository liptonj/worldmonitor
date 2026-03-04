import { requireAdmin, errorResponse, corsHeaders } from './_auth';

export const config = { runtime: 'edge' };

const REDIS_CACHE_KEYS = [
  'market:symbols:v1',
  'market:quotes:v1',
  'market:crypto:v1',
  'market:commodities:v1',
  'market:sectors:v1',
];

async function invalidateRedisCache(): Promise<void> {
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!redisUrl || !redisToken) return;

  try {
    const path = ['del', ...REDIS_CACHE_KEYS.map((k) => encodeURIComponent(k))].join('/');
    const res = await fetch(`${redisUrl}/${path}`, {
      headers: { Authorization: `Bearer ${redisToken}` },
    });
    if (!res.ok) {
      console.warn('[market-symbols] Redis cache invalidation failed:', res.status);
    }
  } catch (err) {
    console.warn('[market-symbols] Redis cache invalidation error:', err);
  }
}

export default async function handler(req: Request): Promise<Response> {
  const headers = corsHeaders();
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });

  let admin;
  try {
    admin = await requireAdmin(req);
  } catch (err) {
    return errorResponse(err);
  }

  const { client } = admin;

  if (req.method === 'GET') {
    const { data, error } = await client.rpc('get_market_symbols');
    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    }
    return new Response(JSON.stringify(data), { status: 200, headers });
  }

  if (req.method === 'PUT') {
    type PutBody = {
      category?: string;
      symbols?: Array<{ symbol: string; name: string; display?: string }>;
    };
    let body: PutBody;
    try {
      body = (await req.json()) as PutBody;
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers });
    }

    if (!body.category || !Array.isArray(body.symbols)) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: category and symbols' }),
        { status: 400, headers }
      );
    }

    const { error } = await client.rpc('admin_update_market_symbols', {
      p_category: body.category,
      p_symbols: body.symbols,
    });
    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    }

    await invalidateRedisCache();

    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
}
