/**
 * Bridge interface for domain loaders. DataLoaderManager implements this
 * and passes it to loaders so they can call loadChannelWithFallback,
 * getHandler, and access shared state.
 */

import type { AppContext } from '@/app/app-context';
import type { CommodityDataItem } from './types';
import type { ListFireDetectionsResponse } from '@/generated/client/worldmonitor/wildfire/v1/service_client';

export interface DataLoaderBridge {
  readonly ctx: AppContext;
  renderCriticalBanner(postures: unknown[]): void;
  loadChannelWithFallback<T>(channel: string, renderFn: (data: T) => void): Promise<boolean>;
  getHandler(channel: string): ((payload: unknown) => void) | undefined;
  getSourcesReady(): Promise<void>;
  runCorrelationAnalysis(): Promise<void>;
  getFiresCache(): ListFireDetectionsResponse | null;
  setFiresCache(data: ListFireDetectionsResponse | null): void;
  getLastCommodityData(): CommodityDataItem[];
  setLastCommodityData(data: CommodityDataItem[]): void;
  shouldShowIntelligenceNotifications(): boolean;
}
