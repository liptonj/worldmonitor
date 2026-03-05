/**
 * @deprecated Migrated to relay direct fetch (Phase 3). This route is no longer called.
 * Kept for reference only.
 * RPC: GetSectorSummary
 * Fetches sector ETF performance from Finnhub.
 */
import type {
  ServerContext,
  GetSectorSummaryRequest,
  GetSectorSummaryResponse,
  SectorPerformance,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { getConfiguredSymbols } from '../../../_shared/market-symbols';
import { fetchFinnhubQuote, fetchYahooQuotesBatch } from './_shared';
import { cachedFetchJson } from '../../../_shared/redis';
import { getSecret } from '../../../_shared/secrets';

const REDIS_CACHE_KEY = 'market:sectors:v1';
const REDIS_CACHE_TTL = 600; // 10 min — Finnhub rate-limited

function redisCacheKey(symbols: string[]): string {
  return `${REDIS_CACHE_KEY}:${[...symbols].sort().join(',')}`;
}

const fallbackSectorCache = new Map<string, { data: GetSectorSummaryResponse; ts: number }>();

const DEFAULT_SECTOR_SYMBOLS = ['XLK', 'XLF', 'XLE', 'XLV', 'XLY', 'XLI', 'XLP', 'XLU', 'XLB', 'XLRE', 'XLC', 'SMH'];

export async function getSectorSummary(
  _ctx: ServerContext,
  _req: GetSectorSummaryRequest,
): Promise<GetSectorSummaryResponse> {
  const dbSectors = await getConfiguredSymbols('sector');
  const sectorSymbols = dbSectors ? dbSectors.map((s) => s.symbol) : DEFAULT_SECTOR_SYMBOLS;

  const key = redisCacheKey(sectorSymbols);
  try {
  const result = await cachedFetchJson<GetSectorSummaryResponse>(key, REDIS_CACHE_TTL, async () => {
    const apiKey = await getSecret('FINNHUB_API_KEY');
    const sectors: SectorPerformance[] = [];

    if (apiKey) {
      const results = await Promise.all(
        sectorSymbols.map((s) => fetchFinnhubQuote(s, apiKey)),
      );
      for (const r of results) {
        if (r) sectors.push({ symbol: r.symbol, name: r.symbol, change: r.changePercent });
      }
    }

    // Fallback to Yahoo Finance when Finnhub key is missing or returned nothing
    if (sectors.length === 0) {
      const batch = await fetchYahooQuotesBatch(sectorSymbols);
      for (const s of sectorSymbols) {
        const yahoo = batch.results.get(s);
        if (yahoo) sectors.push({ symbol: s, name: s, change: yahoo.change });
      }
    }

    return sectors.length > 0 ? { sectors } : null;
  });

  if (result) fallbackSectorCache.set(key, { data: result, ts: Date.now() });
  return result || fallbackSectorCache.get(key)?.data || { sectors: [] };
  } catch {
    return fallbackSectorCache.get(key)?.data || { sectors: [] };
  }
}
