import type {
  ServerContext,
  GetMarketDashboardRequest,
  GetMarketDashboardResponse,
  MarketQuote,
  CommodityQuote,
  SectorPerformance,
  CryptoQuote,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { getAllMarketSymbols, type SymbolEntry } from '../../../_shared/market-symbols';
import { getSecret } from '../../../_shared/secrets';
import {
  isYahooOnlySymbol,
  fetchFinnhubQuote,
  fetchYahooQuotesBatch,
  fetchCoinGeckoMarkets,
  CRYPTO_META,
} from './_shared';
import { cachedFetchJson } from '../../../_shared/redis';

const REDIS_KEY = 'market:dashboard:v1';
const REDIS_TTL = 480;

let memCache: { data: GetMarketDashboardResponse; ts: number } | null = null;
const CACHE_TTL_MS = 480_000;

function buildMetaMap(entries: SymbolEntry[]): Map<string, SymbolEntry> {
  return new Map(entries.map((e) => [e.symbol, e]));
}

export async function getMarketDashboard(
  _ctx: ServerContext,
  _req: GetMarketDashboardRequest,
): Promise<GetMarketDashboardResponse> {
  if (memCache && Date.now() - memCache.ts < CACHE_TTL_MS) {
    return memCache.data;
  }

  try {
    const result = await cachedFetchJson<GetMarketDashboardResponse>(REDIS_KEY, REDIS_TTL, async () => {
      const config = await getAllMarketSymbols();
      if (!config) {
        return {
          stocks: [], commodities: [], sectors: [], crypto: [],
          finnhubSkipped: true, skipReason: 'Symbol config unavailable', rateLimited: false,
        };
      }

      const stockSymbols = config.stock.map((s) => s.symbol);
      const commoditySymbols = config.commodity.map((s) => s.symbol);
      const sectorSymbols = config.sector.map((s) => s.symbol);
      const cryptoIds = config.crypto.map((s) => s.symbol);

      const stockMeta = buildMetaMap(config.stock);
      const commodityMeta = buildMetaMap(config.commodity);
      const sectorMeta = buildMetaMap(config.sector);

      const apiKey = await getSecret('FINNHUB_API_KEY');

      const finnhubSymbols = stockSymbols.filter((s) => !isYahooOnlySymbol(s));
      const allYahooSymbols = [
        ...stockSymbols.filter((s) => isYahooOnlySymbol(s)),
        ...commoditySymbols,
        ...sectorSymbols,
        ...(!apiKey ? finnhubSymbols : []),
      ];

      const [finnhubResults, yahooResults, cryptoResults] = await Promise.allSettled([
        apiKey
          ? Promise.all(finnhubSymbols.map((s) => fetchFinnhubQuote(s, apiKey).then((r) => r ? { symbol: s, ...r } : null)))
          : Promise.resolve([]),
        allYahooSymbols.length > 0 ? fetchYahooQuotesBatch(allYahooSymbols) : Promise.resolve({ results: new Map(), rateLimited: false }),
        cryptoIds.length > 0 ? fetchCoinGeckoMarkets(cryptoIds) : Promise.resolve([]),
      ]);

      const finnhubData = finnhubResults.status === 'fulfilled' ? finnhubResults.value : [];
      const yahooData = yahooResults.status === 'fulfilled' ? yahooResults.value : { results: new Map<string, { price: number; change: number; sparkline: number[] }>(), rateLimited: false };
      const cryptoData = cryptoResults.status === 'fulfilled' ? cryptoResults.value : [];

      const stocks: MarketQuote[] = [];
      const finnhubHits = new Set<string>();

      for (const r of finnhubData) {
        if (r) {
          finnhubHits.add(r.symbol);
          const meta = stockMeta.get(r.symbol);
          stocks.push({
            symbol: r.symbol,
            name: meta?.name ?? r.symbol,
            display: meta?.display ?? r.symbol,
            price: r.price,
            change: r.changePercent,
            sparkline: [],
          });
        }
      }

      const missedFinnhub = apiKey
        ? finnhubSymbols.filter((s) => !finnhubHits.has(s))
        : finnhubSymbols;

      for (const s of [...stockSymbols.filter((sym) => isYahooOnlySymbol(sym)), ...missedFinnhub]) {
        if (finnhubHits.has(s)) continue;
        const yahoo = yahooData.results.get(s);
        if (yahoo) {
          const meta = stockMeta.get(s);
          stocks.push({
            symbol: s,
            name: meta?.name ?? s,
            display: meta?.display ?? s,
            price: yahoo.price,
            change: yahoo.change,
            sparkline: yahoo.sparkline,
          });
        }
      }

      const stockOrder = new Map(stockSymbols.map((s, i) => [s, i]));
      stocks.sort((a, b) => (stockOrder.get(a.symbol) ?? 999) - (stockOrder.get(b.symbol) ?? 999));

      const commodities: CommodityQuote[] = [];
      for (const s of commoditySymbols) {
        const yahoo = yahooData.results.get(s);
        if (yahoo) {
          const meta = commodityMeta.get(s);
          commodities.push({
            symbol: s,
            name: meta?.name ?? s,
            display: meta?.display ?? s,
            price: yahoo.price,
            change: yahoo.change,
            sparkline: yahoo.sparkline,
          });
        }
      }

      const sectors: SectorPerformance[] = [];
      for (const s of sectorSymbols) {
        const yahoo = yahooData.results.get(s);
        if (yahoo) {
          const meta = sectorMeta.get(s);
          sectors.push({
            symbol: s,
            name: meta?.name ?? s,
            change: yahoo.change,
          });
        }
      }

      const crypto: CryptoQuote[] = cryptoData.map((coin) => {
        const configEntry = config.crypto.find((c) => c.symbol === coin.id);
        const meta = CRYPTO_META[coin.id];
        return {
          name: configEntry?.name ?? meta?.name ?? coin.id,
          symbol: configEntry?.display ?? meta?.symbol ?? coin.id.toUpperCase(),
          price: coin.current_price ?? 0,
          change: coin.price_change_percentage_24h ?? 0,
          sparkline: coin.sparkline_in_7d?.price ?? [],
        };
      });

      const hasData = stocks.length > 0 || commodities.length > 0 || sectors.length > 0 || crypto.length > 0;
      if (!hasData) return null;

      const coveredByYahoo = finnhubSymbols.every((s) => stocks.some((q) => q.symbol === s));
      const skipped = !apiKey && !coveredByYahoo;

      return {
        stocks,
        commodities,
        sectors,
        crypto,
        finnhubSkipped: skipped,
        skipReason: skipped ? 'FINNHUB_API_KEY not configured' : '',
        rateLimited: yahooData.rateLimited,
      };
    });

    if (result) {
      memCache = { data: result, ts: Date.now() };
    }

    return result ?? memCache?.data ?? {
      stocks: [], commodities: [], sectors: [], crypto: [],
      finnhubSkipped: false, skipReason: '', rateLimited: false,
    };
  } catch (err) {
    console.warn('[getMarketDashboard] error:', err instanceof Error ? err.message : String(err));
    return memCache?.data ?? {
      stocks: [], commodities: [], sectors: [], crypto: [],
      finnhubSkipped: false, skipReason: '', rateLimited: false,
    };
  }
}
