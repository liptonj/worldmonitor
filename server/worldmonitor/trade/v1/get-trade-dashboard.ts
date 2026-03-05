/**
 * RPC: getTradeDashboard -- batch fetch all trade dashboard data in parallel.
 * Uses default parameters matching what data-loader.ts currently uses.
 */

import type {
  ServerContext,
  GetTradeDashboardRequest,
  GetTradeDashboardResponse,
  GetTradeRestrictionsResponse,
  GetTariffTrendsResponse,
  GetTradeFlowsResponse,
  GetTradeBarriersResponse,
} from '../../../../src/generated/server/worldmonitor/trade/v1/service_server';

import { getTradeRestrictions } from './get-trade-restrictions';
import { getTariffTrends } from './get-tariff-trends';
import { getTradeFlows } from './get-trade-flows';
import { getTradeBarriers } from './get-trade-barriers';

const emptyRestrictions: GetTradeRestrictionsResponse = { restrictions: [], fetchedAt: '', upstreamUnavailable: false };
const emptyTariffs: GetTariffTrendsResponse = { datapoints: [], fetchedAt: '', upstreamUnavailable: false };
const emptyFlows: GetTradeFlowsResponse = { flows: [], fetchedAt: '', upstreamUnavailable: false };
const emptyBarriers: GetTradeBarriersResponse = { barriers: [], fetchedAt: '', upstreamUnavailable: false };

export async function getTradeDashboard(
  ctx: ServerContext,
  _req: GetTradeDashboardRequest,
): Promise<GetTradeDashboardResponse> {
  const [restrictionsResult, tariffsResult, flowsResult, barriersResult] = await Promise.allSettled([
    getTradeRestrictions(ctx, { countries: [], limit: 50 }),
    getTariffTrends(ctx, { reportingCountry: '840', partnerCountry: '156', productSector: '', years: 10 }),
    getTradeFlows(ctx, { reportingCountry: '840', partnerCountry: '156', years: 10 }),
    getTradeBarriers(ctx, { countries: [], measureType: '', limit: 50 }),
  ]);

  return {
    restrictions: restrictionsResult.status === 'fulfilled' ? restrictionsResult.value : emptyRestrictions,
    tariffs: tariffsResult.status === 'fulfilled' ? tariffsResult.value : emptyTariffs,
    flows: flowsResult.status === 'fulfilled' ? flowsResult.value : emptyFlows,
    barriers: barriersResult.status === 'fulfilled' ? barriersResult.value : emptyBarriers,
  };
}
