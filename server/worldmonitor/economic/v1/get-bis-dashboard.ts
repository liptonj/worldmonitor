/**
 * @deprecated Migrated to relay direct fetch (Phase 3). This route is no longer called.
 * Kept for reference only.
 * RPC: getBisDashboard -- batch fetch all BIS dashboard data in parallel.
 * Fans out to the existing BIS handlers (with their Redis caching).
 */

import type {
  ServerContext,
  GetBisDashboardRequest,
  GetBisDashboardResponse,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

import { getBisPolicyRates } from './get-bis-policy-rates';
import { getBisExchangeRates } from './get-bis-exchange-rates';
import { getBisCredit } from './get-bis-credit';

export async function getBisDashboard(
  ctx: ServerContext,
  _req: GetBisDashboardRequest,
): Promise<GetBisDashboardResponse> {
  const [policyResult, eerResult, creditResult] = await Promise.allSettled([
    getBisPolicyRates(ctx, {}),
    getBisExchangeRates(ctx, {}),
    getBisCredit(ctx, {}),
  ]);

  return {
    policyRates: policyResult.status === 'fulfilled' ? policyResult.value.rates : [],
    exchangeRates: eerResult.status === 'fulfilled' ? eerResult.value.rates : [],
    creditGdp: creditResult.status === 'fulfilled' ? creditResult.value.entries : [],
  };
}
