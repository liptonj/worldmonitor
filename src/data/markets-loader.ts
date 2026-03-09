/**
 * Markets domain loader — loadMarkets.
 */

import type { DataLoaderBridge } from './loader-bridge';
import { fetchMarketDashboard } from '@/services';
import type { CommoditiesPanel } from '@/components/MarketPanel';

export const marketsLoader = {
  async loadMarkets(bridge: DataLoaderBridge): Promise<void> {
    const ctx = bridge.ctx;
    const commoditiesPanel = ctx.panels['commodities'] as CommoditiesPanel;

    try {
      const dashboard = await fetchMarketDashboard();
      bridge.getHandler('markets')?.(dashboard);
    } catch {
      ctx.statusPanel?.updateApi('Finnhub', { status: 'error' });
      ctx.statusPanel?.updateApi('CoinGecko', { status: 'error' });
      const lastCommodityData = bridge.getLastCommodityData();
      if (lastCommodityData.length > 0) {
        commoditiesPanel.renderCommodities(lastCommodityData, true);
      }
    }
  },
};
