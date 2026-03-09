import type { NewsItem, ClusteredEvent } from '@/types';

export const newsStore = {
  allNews: [] as NewsItem[],
  newsByCategory: {} as Record<string, NewsItem[]>,
  latestClusters: [] as ClusteredEvent[],
};
