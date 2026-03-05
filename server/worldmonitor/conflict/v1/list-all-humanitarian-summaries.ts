/**
 * @deprecated Migrated to relay direct fetch (Phase 3). This route is no longer called.
 * Kept for reference only.
 * RPC: listAllHumanitarianSummaries -- returns HAPI summaries for all 20 monitored countries.
 *
 * Implementation strategy: calls the existing getHumanitarianSummary handler in parallel for
 * all country codes. Each individual call is Redis-cached at its own key
 * (conflict:humanitarian:v1:<ISO2>) so the parallel fanout hits cache, not the upstream API.
 * This converts 20 browser→server round-trips into 1.
 */

import type {
  ServerContext,
  ListAllHumanitarianSummariesRequest,
  ListAllHumanitarianSummariesResponse,
  HumanitarianCountrySummary,
} from '../../../../src/generated/server/worldmonitor/conflict/v1/service_server';

import { getHumanitarianSummary } from './get-humanitarian-summary';

const MONITORED_COUNTRY_CODES = [
  'US', 'RU', 'CN', 'UA', 'IR', 'IL', 'TW', 'KP', 'SA', 'TR',
  'PL', 'DE', 'FR', 'GB', 'IN', 'PK', 'SY', 'YE', 'MM', 'VE',
];

export async function listAllHumanitarianSummaries(
  ctx: ServerContext,
  _req: ListAllHumanitarianSummariesRequest,
): Promise<ListAllHumanitarianSummariesResponse> {
  const results = await Promise.allSettled(
    MONITORED_COUNTRY_CODES.map(countryCode =>
      getHumanitarianSummary(ctx, { countryCode }),
    ),
  );

  const summaries: HumanitarianCountrySummary[] = results
    .map(r => (r.status === 'fulfilled' ? r.value.summary : undefined))
    .filter((s): s is HumanitarianCountrySummary => s !== undefined);

  return { summaries };
}
