// api/internal/ingest-headlines.ts
import { getRedisClient } from '../../server/_shared/redis';

export const config = { runtime: 'edge' };

function corsHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json' };
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 });

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: corsHeaders(),
    });
  }

  const authHeader = (process.env.RELAY_AUTH_HEADER ?? 'x-relay-key').toLowerCase();
  const appKey = req.headers.get(authHeader);
  const expectedKey = process.env.RELAY_SHARED_SECRET;
  if (!expectedKey || appKey !== expectedKey) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: corsHeaders(),
    });
  }

  let payload: { headlines?: unknown };
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: corsHeaders(),
    });
  }

  if (!Array.isArray(payload?.headlines)) {
    return new Response(JSON.stringify({ error: 'headlines array required' }), {
      status: 400,
      headers: corsHeaders(),
    });
  }

  const redis = getRedisClient();
  if (!redis) {
    return new Response(JSON.stringify({ error: 'Storage unavailable' }), {
      status: 503,
      headers: corsHeaders(),
    });
  }

  let ingested = 0;
  for (const h of payload.headlines as unknown[]) {
    if (!h || typeof h !== 'object') continue;
    const headline = h as Record<string, unknown>;
    const title = typeof headline['title'] === 'string' ? headline['title'].trim() : '';
    const pubDate =
      typeof headline['pubDate'] === 'number' ? headline['pubDate'] : Math.floor(Date.now() / 1000);
    const scopes = Array.isArray(headline['scopes'])
      ? (headline['scopes'] as unknown[]).filter((s) => typeof s === 'string') as string[]
      : ['global'];

    if (!title) continue;

    const item = JSON.stringify({ title, pubDate: Math.floor(pubDate) });
    for (const scope of scopes) {
      if (!scope) continue;
      try {
        const key = `wm:headlines:${scope}`;
        await redis.lpush(key, item);
        await redis.ltrim(key, 0, 99);
      } catch {
        // non-fatal: continue with other scopes
      }
    }
    ingested++;
  }

  return new Response(JSON.stringify({ ingested }), {
    status: 200,
    headers: corsHeaders(),
  });
}
