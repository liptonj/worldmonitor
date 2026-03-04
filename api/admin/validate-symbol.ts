import { requireAdmin, errorResponse, corsHeaders } from './_auth';

export const config = { runtime: 'edge' };

const UPSTREAM_TIMEOUT_MS = 10_000;
const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

async function validateYahoo(symbol: string): Promise<{ valid: boolean; name?: string; price?: number }> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!resp.ok) return { valid: false };
    const data = await resp.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta || meta.regularMarketPrice === 0) return { valid: false };
    return { valid: true, name: meta.shortName || meta.symbol || symbol, price: meta.regularMarketPrice };
  } catch {
    return { valid: false };
  }
}

async function validateCrypto(coinId: string): Promise<{ valid: boolean; name?: string; symbol?: string; price?: number }> {
  try {
    const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(coinId)}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false`;
    const resp = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!resp.ok) return { valid: false };
    const data = await resp.json();
    if (!data?.id) return { valid: false };
    return {
      valid: true,
      name: data.name,
      symbol: (data.symbol || '').toUpperCase(),
      price: data.market_data?.current_price?.usd ?? 0,
    };
  } catch {
    return { valid: false };
  }
}

export default async function handler(req: Request): Promise<Response> {
  const headers = corsHeaders();
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });

  try { await requireAdmin(req); } catch (err) { return errorResponse(err); }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
  }

  let body: { category?: string; symbol?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers });
  }

  if (!body.category || !body.symbol) {
    return new Response(JSON.stringify({ error: 'category and symbol required' }), { status: 400, headers });
  }

  const symbol = body.symbol.trim();
  if (symbol.length > 64) {
    return new Response(JSON.stringify({ error: 'Symbol too long (max 64 characters)' }), { status: 400, headers });
  }

  const { category } = body;

  if (category === 'crypto') {
    const result = await validateCrypto(symbol.toLowerCase());
    return new Response(JSON.stringify(result), { status: 200, headers });
  }

  if (['stock', 'commodity', 'sector'].includes(category)) {
    const result = await validateYahoo(symbol);
    return new Response(JSON.stringify(result), { status: 200, headers });
  }

  return new Response(JSON.stringify({ error: 'Invalid category' }), { status: 400, headers });
}
