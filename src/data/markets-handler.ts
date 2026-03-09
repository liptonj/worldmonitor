/**
 * Markets domain handler — markets, predictions, stablecoins, etf-flows, macro-signals, gulf-quotes.
 */

import type { AppContext } from '@/app/app-context';
import { dataFreshness } from '@/services/data-freshness';
import type { GetMarketDashboardResponse } from '@/generated/client/worldmonitor/market/v1/service_client';
import type { ListPredictionMarketsResponse } from '@/generated/client/worldmonitor/prediction/v1/service_client';
import type { ListGulfQuotesResponse } from '@/generated/client/worldmonitor/market/v1/service_client';
import type { MarketPanel, HeatmapPanel, CommoditiesPanel, CryptoPanel } from '@/components/MarketPanel';
import type { PredictionPanel } from '@/components/PredictionPanel';
import type { GulfEconomiesPanel } from '@/components/GulfEconomiesPanel';
import type { ChannelHandler } from './types';
import type { HandlerCallbacks } from './types';

export function createMarketsHandlers(
  ctx: AppContext,
  callbacks?: HandlerCallbacks
): Record<string, ChannelHandler> {
  let lastCommodityData: Array<{ display: string; price: number | null; change: number | null; sparkline?: number[] }> = [];

  function renderMarketDashboard(dashboard: GetMarketDashboardResponse): void {
    const commoditiesPanel = ctx.panels['commodities'] as CommoditiesPanel;

    const stockData = dashboard.stocks.map((q) => ({
      symbol: q.symbol,
      name: q.name,
      display: q.display || q.symbol,
      price: q.price != null ? q.price : null,
      change: q.change ?? null,
      sparkline: q.sparkline.length > 0 ? q.sparkline : undefined,
    }));
    ctx.latestMarkets = stockData;
    (ctx.panels['markets'] as MarketPanel).renderMarkets(stockData, dashboard.rateLimited);

    if (dashboard.finnhubSkipped) {
      ctx.statusPanel?.updateApi('Finnhub', { status: 'error' });
    } else {
      ctx.statusPanel?.updateApi('Finnhub', { status: stockData.length > 0 ? 'ok' : 'error' });
    }

    if (dashboard.sectors.length > 0) {
      (ctx.panels['heatmap'] as HeatmapPanel).renderHeatmap(
        dashboard.sectors.map((s) => ({ name: s.name, change: s.change })),
      );
    }

    const commodityData = dashboard.commodities.map((q) => ({
      display: q.display || q.symbol,
      price: q.price != null ? q.price : null,
      change: q.change ?? null,
      sparkline: (q.sparkline?.length ?? 0) > 0 ? (q.sparkline ?? []) : undefined,
    }));
    if (commodityData.length > 0 && commodityData.some((d) => d.price !== null)) {
      lastCommodityData = commodityData;
      commoditiesPanel.renderCommodities(commodityData);
    } else if (lastCommodityData.length > 0) {
      commoditiesPanel.renderCommodities(lastCommodityData, true);
    } else {
      commoditiesPanel.renderCommodities([]);
    }

    const cryptoData = dashboard.crypto.map((q) => ({
      name: q.name,
      symbol: q.symbol,
      price: q.price,
      change: q.change,
      sparkline: q.sparkline.length > 0 ? q.sparkline : undefined,
    }));
    (ctx.panels['crypto'] as CryptoPanel).renderCrypto(cryptoData);
    ctx.statusPanel?.updateApi('CoinGecko', { status: cryptoData.length > 0 ? 'ok' : 'error' });
  }

  function renderPredictions(predictions: import('@/services/prediction').PredictionMarket[]): void {
    ctx.latestPredictions = predictions;
    (ctx.panels['polymarket'] as PredictionPanel).renderPredictions(predictions);
    ctx.statusPanel?.updateFeed('Polymarket', { status: 'ok', itemCount: predictions.length });
    ctx.statusPanel?.updateApi('Polymarket', { status: 'ok' });
    dataFreshness.recordUpdate('polymarket', predictions.length);
    dataFreshness.recordUpdate('predictions', predictions.length);
    void callbacks?.onPredictionsRendered?.();
  }

  function forwardToPanel(channel: string): ChannelHandler {
    return (payload: unknown) => {
      const panel = ctx.panels[channel] as { applyPush?: (p: unknown) => void } | undefined;
      panel?.applyPush?.(payload);
    };
  }

  return {
    markets: (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return;
      const dashboard = payload as GetMarketDashboardResponse;
      if (!Array.isArray(dashboard.stocks)) return;
      renderMarketDashboard(dashboard);
    },
    predictions: (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return;
      const resp = (Array.isArray(payload) ? { markets: payload } : payload) as ListPredictionMarketsResponse;
      if (!Array.isArray(resp.markets)) return;
      const predictions = resp.markets.map(m => ({
        title: m.title,
        yesPrice: (m.yesPrice ?? 0.5) * 100,
        volume: m.volume,
        url: m.url,
        endDate: m.closesAt ? new Date(m.closesAt).toISOString() : undefined,
      }));
      renderPredictions(predictions);
    },
    'gulf-quotes': (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return;
      const data = payload as ListGulfQuotesResponse;
      if (!Array.isArray(data.quotes)) return;
      (ctx.panels['gulf-economies'] as GulfEconomiesPanel)?.setData(data);
    },
    stablecoins: forwardToPanel('stablecoins'),
    'etf-flows': forwardToPanel('etf-flows'),
    'macro-signals': forwardToPanel('macro-signals'),
  };
}
