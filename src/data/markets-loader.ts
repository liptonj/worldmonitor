/**
 * Markets domain loader — loadMarkets.
 */

import type { DataLoaderBridge } from './loader-bridge';
import { getHydratedData } from '@/services/bootstrap';
import { fetchMarketDashboard } from '@/services';
import type { GetSectorSummaryResponse, SectorPerformance } from '@/generated/client/worldmonitor/market/v1/service_client';
import type { HeatmapPanel, CommoditiesPanel } from '@/components/MarketPanel';

export const marketsLoader = {
  async loadMarkets(bridge: DataLoaderBridge): Promise<void> {
    const ctx = bridge.ctx;
    const commoditiesPanel = ctx.panels['commodities'] as CommoditiesPanel;

    const hydratedCommodities = getHydratedData('commodities') as { quotes: Array<{ display?: string; symbol: string; price?: number; change?: number; sparkline?: number[] }> } | undefined;
    if (hydratedCommodities?.quotes?.length) {
      const mapped = hydratedCommodities.quotes.map(q => ({
        display: q.display || q.symbol,
        price: q.price != null ? q.price : null,
        change: q.change ?? null,
        sparkline: (q.sparkline?.length ?? 0) > 0 ? q.sparkline : undefined,
      }));
      if (mapped.some(d => d.price !== null)) {
        commoditiesPanel.renderCommodities(mapped);
      }
    }

    try {
      const dashboard = await fetchMarketDashboard();
      bridge.getHandler('markets')?.(dashboard);

      const hydratedSectors = getHydratedData('sectors') as GetSectorSummaryResponse | undefined;
      if (hydratedSectors?.sectors?.length) {
        (ctx.panels['heatmap'] as HeatmapPanel).renderHeatmap(
          hydratedSectors.sectors.map((s: SectorPerformance) => ({ name: s.name, change: s.change }))
        );
      }
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
