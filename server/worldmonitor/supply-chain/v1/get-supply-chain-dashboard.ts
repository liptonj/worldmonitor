/**
 * RPC: getSupplyChainDashboard -- batch fetch all supply chain dashboard data.
 */

import type {
  ServerContext,
  GetSupplyChainDashboardRequest,
  GetSupplyChainDashboardResponse,
  GetShippingRatesResponse,
  GetChokepointStatusResponse,
  GetCriticalMineralsResponse,
} from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';

import { getShippingRates } from './get-shipping-rates';
import { getChokepointStatus } from './get-chokepoint-status';
import { getCriticalMinerals } from './get-critical-minerals';

const emptyShipping: GetShippingRatesResponse = { indices: [], fetchedAt: '', upstreamUnavailable: false };
const emptyChokepoints: GetChokepointStatusResponse = { chokepoints: [], fetchedAt: '', upstreamUnavailable: false };
const emptyMinerals: GetCriticalMineralsResponse = { minerals: [], fetchedAt: '', upstreamUnavailable: false };

export async function getSupplyChainDashboard(
  ctx: ServerContext,
  _req: GetSupplyChainDashboardRequest,
): Promise<GetSupplyChainDashboardResponse> {
  const [shippingResult, chokepointResult, mineralsResult] = await Promise.allSettled([
    getShippingRates(ctx, {}),
    getChokepointStatus(ctx, {}),
    getCriticalMinerals(ctx, {}),
  ]);

  return {
    shipping: shippingResult.status === 'fulfilled' ? shippingResult.value : emptyShipping,
    chokepoints: chokepointResult.status === 'fulfilled' ? chokepointResult.value : emptyChokepoints,
    minerals: mineralsResult.status === 'fulfilled' ? mineralsResult.value : emptyMinerals,
  };
}
