import { createAnonClient } from './supabase';
import { cachedFetchJson } from './redis';

interface SymbolEntry {
  symbol: string;
  name: string;
  display: string | null;
  sort_order: number;
}

interface MarketSymbolsConfig {
  stock: SymbolEntry[];
  commodity: SymbolEntry[];
  crypto: SymbolEntry[];
  sector: SymbolEntry[];
}

const REDIS_KEY = 'market:symbols:v1';
const REDIS_TTL = 300; // 5 min — symbol config changes are infrequent

let inMemoryFallback: MarketSymbolsConfig | null = null;

async function fetchFromSupabase(): Promise<MarketSymbolsConfig | null> {
  try {
    const client = createAnonClient();
    const { data, error } = await client.rpc('get_market_symbols');
    if (error || !data) return null;
    return data as MarketSymbolsConfig;
  } catch {
    return null;
  }
}

export async function getAllMarketSymbols(): Promise<MarketSymbolsConfig | null> {
  try {
    const result = await cachedFetchJson<MarketSymbolsConfig>(REDIS_KEY, REDIS_TTL, fetchFromSupabase);
    if (result) {
      inMemoryFallback = result;
      return result;
    }
  } catch {
    // Redis/Supabase failure — fall through
  }
  return inMemoryFallback;
}

export async function getConfiguredSymbols(
  category: 'stock' | 'commodity' | 'crypto' | 'sector',
): Promise<SymbolEntry[] | null> {
  const all = await getAllMarketSymbols();
  return all?.[category] ?? null;
}

export type { SymbolEntry, MarketSymbolsConfig };
