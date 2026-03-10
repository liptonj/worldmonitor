/**
 * Economic domain handler — fred, oil, bis, trade, supply-chain, spending, giving.
 */

import type { AppContext } from '@/app/app-context';
import { fredResponseToClientSeries, energyPricesToOilAnalytics } from '@/services';
import { t } from '@/services/i18n';
import { dataFreshness } from '@/services/data-freshness';
import { protoToGivingSummary } from '@/services/giving';
import type { GetBisPolicyRatesResponse, GetFredDashboardResponse, GetFredSeriesResponse, GetEnergyPricesResponse } from '@/generated/client/worldmonitor/economic/v1/service_client';
import type { GetTradeBarriersResponse, GetTradeDashboardResponse } from '@/generated/client/worldmonitor/trade/v1/service_client';
import type { GetChokepointStatusResponse, GetSupplyChainDashboardResponse } from '@/generated/client/worldmonitor/supply_chain/v1/service_client';
import type { EconomicPanel } from '@/components/EconomicPanel';
import type { TradePolicyPanel } from '@/components/TradePolicyPanel';
import type { SupplyChainPanel } from '@/components/SupplyChainPanel';
import type { GivingPanel } from '@/components/GivingPanel';
import type { BisData } from '@/services';
import type { ChannelHandler } from './types';

export function createEconomicHandlers(ctx: AppContext): Record<string, ChannelHandler> {
  function renderFredData(data: import('@/services/economic').FredSeries[]): void {
    const economicPanel = ctx.panels['economic'] as EconomicPanel;
    economicPanel?.setErrorState(false);
    economicPanel?.update(data);
    ctx.statusPanel?.updateApi('FRED', { status: data.length > 0 ? 'ok' : 'error' });
    if (data.length > 0) dataFreshness.recordUpdate('economic', data.length);
  }

  function renderOilData(data: import('@/services/economic').OilAnalytics): void {
    const economicPanel = ctx.panels['economic'] as EconomicPanel;
    economicPanel?.updateOil(data);
    const hasData = !!(data.wtiPrice || data.brentPrice || data.usProduction || data.usInventory);
    ctx.statusPanel?.updateApi('EIA', { status: hasData ? 'ok' : 'error' });
    if (hasData) {
      const metricCount = [data.wtiPrice, data.brentPrice, data.usProduction, data.usInventory].filter(Boolean).length;
      dataFreshness.recordUpdate('oil', metricCount || 1);
    } else {
      dataFreshness.recordError('oil', 'Oil analytics returned no values');
    }
  }

  function renderBisData(data: BisData): void {
    const economicPanel = ctx.panels['economic'] as EconomicPanel;
    economicPanel?.updateBis(data);
    const hasData = data.policyRates.length > 0;
    ctx.statusPanel?.updateApi('BIS', { status: hasData ? 'ok' : 'error' });
    if (hasData) dataFreshness.recordUpdate('bis', data.policyRates.length);
  }

  function renderTradePolicy(data: GetTradeDashboardResponse | GetTradeBarriersResponse): void {
    const tradePanel = ctx.panels['trade-policy'] as TradePolicyPanel | undefined;
    if (!tradePanel) { ctx.statusPanel?.updateApi('WTO', { status: 'ok' }); return; }

    if ('restrictions' in data || 'tariffs' in data || 'flows' in data) {
      const dashboard = data as GetTradeDashboardResponse;
      const restrictions = dashboard.restrictions ?? { restrictions: [], fetchedAt: '', upstreamUnavailable: false };
      const tariffs = dashboard.tariffs ?? { datapoints: [], fetchedAt: '', upstreamUnavailable: false };
      const flows = dashboard.flows ?? { flows: [], fetchedAt: '', upstreamUnavailable: false };
      const barriers = dashboard.barriers ?? { barriers: [], fetchedAt: '', upstreamUnavailable: false };

      tradePanel.updateRestrictions(restrictions);
      tradePanel.updateTariffs(tariffs);
      tradePanel.updateFlows(flows);
      tradePanel.updateBarriers(barriers);

      const totalItems = restrictions.restrictions.length + tariffs.datapoints.length + flows.flows.length + barriers.barriers.length;
      const anyUnavailable = restrictions.upstreamUnavailable || tariffs.upstreamUnavailable || flows.upstreamUnavailable || barriers.upstreamUnavailable;

      ctx.statusPanel?.updateApi('WTO', { status: anyUnavailable ? 'warning' : totalItems > 0 ? 'ok' : 'error' });

      if (totalItems > 0) {
        dataFreshness.recordUpdate('wto_trade', totalItems);
      } else if (anyUnavailable) {
        dataFreshness.recordError('wto_trade', 'WTO upstream temporarily unavailable');
      }
    } else {
      tradePanel.updateBarriers(data as GetTradeBarriersResponse);
      const barriers = data as GetTradeBarriersResponse;
      const totalItems = barriers.barriers?.length ?? 0;
      const anyUnavailable = barriers.upstreamUnavailable;
      ctx.statusPanel?.updateApi('WTO', { status: anyUnavailable ? 'warning' : totalItems > 0 ? 'ok' : 'error' });
      if (totalItems > 0) dataFreshness.recordUpdate('wto_trade', totalItems);
    }
  }

  function renderSupplyChain(data: GetSupplyChainDashboardResponse | GetChokepointStatusResponse): void {
    const scPanel = ctx.panels['supply-chain'] as SupplyChainPanel | undefined;
    if (!scPanel) { ctx.statusPanel?.updateApi('SupplyChain', { status: 'ok' }); return; }

    if ('shipping' in data || 'minerals' in data) {
      const dashboard = data as GetSupplyChainDashboardResponse;
      const shippingData = dashboard.shipping ?? null;
      const chokepointData = dashboard.chokepoints ?? null;
      const mineralsData = dashboard.minerals ?? null;

      if (shippingData) scPanel.updateShippingRates(shippingData);
      if (chokepointData) scPanel.updateChokepointStatus(chokepointData);
      if (mineralsData) scPanel.updateCriticalMinerals(mineralsData);

      const totalItems = (shippingData?.indices.length || 0) + (chokepointData?.chokepoints.length || 0) + (mineralsData?.minerals.length || 0);
      const anyUnavailable = shippingData?.upstreamUnavailable || chokepointData?.upstreamUnavailable || mineralsData?.upstreamUnavailable;

      ctx.statusPanel?.updateApi('SupplyChain', { status: anyUnavailable ? 'warning' : totalItems > 0 ? 'ok' : 'error' });

      if (totalItems > 0) {
        dataFreshness.recordUpdate('supply_chain', totalItems);
      } else if (anyUnavailable) {
        dataFreshness.recordError('supply_chain', 'Supply chain upstream temporarily unavailable');
      }
    } else {
      const chokepointData = data as GetChokepointStatusResponse;
      scPanel.updateChokepointStatus(chokepointData);
      const totalItems = chokepointData.chokepoints?.length ?? 0;
      const anyUnavailable = chokepointData.upstreamUnavailable;
      ctx.statusPanel?.updateApi('SupplyChain', { status: anyUnavailable ? 'warning' : totalItems > 0 ? 'ok' : 'error' });
      if (totalItems > 0) dataFreshness.recordUpdate('supply_chain', totalItems);
    }
  }

  function renderSpending(data: import('@/services/usa-spending').SpendingSummary): void {
    const economicPanel = ctx.panels['economic'] as EconomicPanel;
    economicPanel?.updateSpending(data);
    ctx.statusPanel?.updateApi('USASpending', { status: data.awards.length > 0 ? 'ok' : 'error' });
    if (data.awards.length > 0) {
      dataFreshness.recordUpdate('spending', data.awards.length);
    } else {
      dataFreshness.recordError('spending', 'No awards returned');
    }
  }

  function renderGiving(data: import('@/services/giving').GivingSummary): void {
    (ctx.panels['giving'] as GivingPanel)?.setData(data);
    dataFreshness.recordUpdate('giving', data.platforms.length);
  }

  return {
    fred: (payload: unknown) => {
      if (!payload || typeof payload !== 'object') { console.warn('[wm:fred] skipped — invalid payload type:', typeof payload); return; }
      const resp = (Array.isArray(payload) ? { series: payload } : payload) as GetFredDashboardResponse | GetFredSeriesResponse;
      if (!('series' in resp)) {
        console.error('[wm:fred] malformed payload — missing series field');
        (ctx.panels['economic'] as EconomicPanel | undefined)?.showError(t('common.failedToLoad'));
        return;
      }
      const data = fredResponseToClientSeries(resp);
      renderFredData(data);
    },
    oil: (payload: unknown) => {
      if (!payload || typeof payload !== 'object') { console.warn('[wm:oil] skipped — invalid payload type:', typeof payload); return; }
      const resp = (Array.isArray(payload) ? { prices: payload } : payload) as GetEnergyPricesResponse;
      if (!Array.isArray(resp.prices)) {
        console.error('[wm:oil] malformed payload — prices is not an array');
        (ctx.panels['economic'] as EconomicPanel | undefined)?.showError(t('common.failedToLoad'));
        return;
      }
      const data = energyPricesToOilAnalytics(resp);
      renderOilData(data);
    },
    bis: (payload: unknown) => {
      if (!payload || typeof payload !== 'object') { console.warn('[wm:bis] skipped — invalid payload type:', typeof payload); return; }
      const resp = (Array.isArray(payload) ? { rates: payload } : payload) as GetBisPolicyRatesResponse;
      if (!Array.isArray(resp.rates)) {
        console.error('[wm:bis] malformed payload — rates is not an array');
        (ctx.panels['economic'] as EconomicPanel | undefined)?.showError(t('common.failedToLoad'));
        return;
      }
      const data: BisData = {
        policyRates: resp.rates,
        exchangeRates: [],
        creditToGdp: [],
        fetchedAt: new Date(),
      };
      renderBisData(data);
    },
    trade: (payload: unknown) => {
      if (!payload || typeof payload !== 'object') { console.warn('[wm:trade] skipped — invalid payload type:', typeof payload); return; }
      let data = payload as GetTradeBarriersResponse;
      if (Array.isArray(payload)) {
        data = { barriers: payload } as unknown as GetTradeBarriersResponse;
      } else if (!('barriers' in data) && 'data' in (payload as Record<string, unknown>)) {
        const inner = (payload as Record<string, unknown>).data;
        if (Array.isArray(inner)) data = { barriers: inner } as unknown as GetTradeBarriersResponse;
        else if (inner && typeof inner === 'object') data = inner as GetTradeBarriersResponse;
      }
      if (!('barriers' in data)) {
        console.error('[wm:trade] malformed payload — missing barriers field');
        (ctx.panels['trade-policy'] as TradePolicyPanel | undefined)?.showError(t('common.failedToLoad'));
        return;
      }
      renderTradePolicy(data);
    },
    'supply-chain': (payload: unknown) => {
      if (!payload || typeof payload !== 'object') { console.warn('[wm:supply-chain] skipped — invalid payload type:', typeof payload); return; }
      const data = (Array.isArray(payload) ? { chokepoints: payload } : payload) as GetChokepointStatusResponse;
      if (!('chokepoints' in data)) {
        console.error('[wm:supply-chain] malformed payload — missing chokepoints field');
        (ctx.panels['supply-chain'] as SupplyChainPanel | undefined)?.showError(t('common.failedToLoad'));
        return;
      }
      renderSupplyChain(data);
    },
    spending: (payload: unknown) => {
      if (!payload || typeof payload !== 'object') { console.warn('[wm:spending] skipped — invalid payload type:', typeof payload); return; }
      let data = payload as import('@/services/usa-spending').SpendingSummary;
      if (Array.isArray(payload)) {
        data = { awards: payload } as import('@/services/usa-spending').SpendingSummary;
      } else if (!('awards' in data) && 'data' in (payload as Record<string, unknown>)) {
        const inner = (payload as Record<string, unknown>).data;
        if (Array.isArray(inner)) data = { ...payload as object, awards: inner } as import('@/services/usa-spending').SpendingSummary;
      }
      if (!Array.isArray(data.awards)) {
        console.error('[wm:spending] malformed payload — awards is not an array');
        (ctx.panels['economic'] as EconomicPanel | undefined)?.showError(t('common.failedToLoad'));
        return;
      }
      renderSpending(data);
    },
    giving: (payload: unknown) => {
      if (!payload || typeof payload !== 'object') { console.warn('[wm:giving] skipped — invalid payload type:', typeof payload); return; }
      if (Array.isArray(payload)) {
        console.warn('[wm:giving] received array — stale Redis data?');
        (ctx.panels['giving'] as GivingPanel | undefined)?.showError(t('common.failedToLoad'));
        return;
      }
      const data = protoToGivingSummary(payload);
      if (!data || !Array.isArray(data.platforms)) {
        const keys = (payload && typeof payload === 'object') ? Object.keys(payload as Record<string, unknown>) : [];
        console.error('[wm:giving] malformed payload — platforms is not an array', { keys, hasSummary: keys.includes('summary') });
        (ctx.panels['giving'] as GivingPanel | undefined)?.showError(t('common.failedToLoad'));
        return;
      }
      renderGiving(data);
    },
  };
}
