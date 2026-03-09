import type { MarketData } from '@/types';
import type { PredictionMarket } from '@/services/prediction';

export const marketsStore = {
  latestMarkets: [] as MarketData[],
  latestPredictions: [] as PredictionMarket[],
};
