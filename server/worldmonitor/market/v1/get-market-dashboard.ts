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
import { cachedFetchJson, setCachedJson } from '../../../_shared/redis';
import { BOOTSTRAP_CACHE_KEYS } from '../../../_shared/cache-keys';

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
      // Sector ETFs (XLK, XLF, etc.) are regular tickers — route through Finnhub like stocks
      const allFinnhubSymbols = apiKey ? [...finnhubSymbols, ...sectorSymbols] : [];
      // Separate Yahoo batches so rate limiting on indices doesn't cut off commodities
      const yahooStockSymbols = [
        ...stockSymbols.filter((s) => isYahooOnlySymbol(s)),
        ...(!apiKey ? finnhubSymbols : []),
      ];
      const yahooSectorFallback = !apiKey ? sectorSymbols : [];

      const [finnhubResults, yahooCommodityResults, yahooStockResults, yahooSectorResults, cryptoResults] = await Promise.allSettled([
        allFinnhubSymbols.length > 0
          ? Promise.all(allFinnhubSymbols.map((s) => fetchFinnhubQuote(s, apiKey!).then((r) => r ? { ...r, symbol: s } : null)))
          : Promise.resolve([]),
        commoditySymbols.length > 0 ? fetchYahooQuotesBatch(commoditySymbols) : Promise.resolve({ results: new Map(), rateLimited: false }),
        yahooStockSymbols.length > 0 ? fetchYahooQuotesBatch(yahooStockSymbols) : Promise.resolve({ results: new Map(), rateLimited: false }),
        yahooSectorFallback.length > 0 ? fetchYahooQuotesBatch(yahooSectorFallback) : Promise.resolve({ results: new Map(), rateLimited: false }),
        cryptoIds.length > 0 ? fetchCoinGeckoMarkets(cryptoIds) : Promise.resolve([]),
      ]);

      const finnhubData = finnhubResults.status === 'fulfilled' ? finnhubResults.value : [];
      const emptyYahoo = { results: new Map<string, { price: number; change: number; sparkline: number[] }>(), rateLimited: false };
      const yahooCommodity = yahooCommodityResults.status === 'fulfilled' ? yahooCommodityResults.value : emptyYahoo;
      const yahooStock = yahooStockResults.status === 'fulfilled' ? yahooStockResults.value : emptyYahoo;
      const yahooSector = yahooSectorResults.status === 'fulfilled' ? yahooSectorResults.value : emptyYahoo;
      // Merge all Yahoo results into one map for unified lookup
      const yahooData = {
        results: new Map([...yahooCommodity.results, ...yahooStock.results, ...yahooSector.results]),
        rateLimited: yahooCommodity.rateLimited || yahooStock.rateLimited || yahooSector.rateLimited,
      };
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
      if (commodities.length > 0) {
        setCachedJson(BOOTSTRAP_CACHE_KEYS.commodities ?? 'market:commodities:v1', { quotes: commodities }, 600).catch(() => {});
      }

      // Sectors: prefer Finnhub data, fall back to Yahoo (matches getSectorSummary)
      const sectorFinnhubHits = new Set<string>();
      const sectors: SectorPerformance[] = [];
      for (const r of finnhubData) {
        if (r && sectorSymbols.includes(r.symbol)) {
          sectorFinnhubHits.add(r.symbol);
          const meta = sectorMeta.get(r.symbol);
          sectors.push({
            symbol: r.symbol,
            name: meta?.name ?? r.symbol,
            change: r.changePercent,
          });
        }
      }
      // Yahoo fallback for sectors missed by Finnhub
      for (const s of sectorSymbols) {
        if (sectorFinnhubHits.has(s)) continue;
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

      const crypto: CryptoQuote[] = [];
      const cryptoById = new Map(cryptoData.map((c) => [c.id, c]));
      for (const id of cryptoIds) {
        const coin = cryptoById.get(id);
        if (!coin) continue;
        const configEntry = config.crypto.find((c) => c.symbol === id);
        const meta = CRYPTO_META[id];
        const prices = coin.sparkline_in_7d?.price;
        const sparkline = prices && prices.length > 24 ? prices.slice(-48) : (prices || []);
        crypto.push({
          name: configEntry?.name ?? meta?.name ?? id,
          symbol: configEntry?.display ?? meta?.symbol ?? id.toUpperCase(),
          price: coin.current_price ?? 0,
          change: coin.price_change_percentage_24h ?? 0,
          sparkline,
        });
      }

      if (crypto.length > 0 && crypto.every((q) => q.price === 0)) {
        console.warn('[getMarketDashboard] CoinGecko returned all-zero prices');
      }

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
