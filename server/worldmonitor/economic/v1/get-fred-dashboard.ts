/**
 * RPC: getFredDashboard -- batch fetch all 7 FRED dashboard series in parallel.
 * Fans out to the existing getFredSeries handler (with its Redis caching) for each series.
 * Returns all series in a single response.
 */

import type {
  ServerContext,
  GetFredDashboardRequest,
  GetFredDashboardResponse,
  FredSeries,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

import { getFredSeries } from './get-fred-series';

const FRED_DASHBOARD_SERIES = [
  { id: 'WALCL', limit: 120 },
  { id: 'FEDFUNDS', limit: 120 },
  { id: 'T10Y2Y', limit: 120 },
  { id: 'UNRATE', limit: 120 },
  { id: 'CPIAUCSL', limit: 120 },
  { id: 'DGS10', limit: 120 },
  { id: 'VIXCLS', limit: 120 },
];

export async function getFredDashboard(
  ctx: ServerContext,
  _req: GetFredDashboardRequest,
): Promise<GetFredDashboardResponse> {
  const results = await Promise.allSettled(
    FRED_DASHBOARD_SERIES.map(({ id, limit }) =>
      getFredSeries(ctx, { seriesId: id, limit }),
    ),
  );

  const series: FredSeries[] = results
    .map((r) => (r.status === 'fulfilled' ? r.value.series : undefined))
    .filter((s): s is FredSeries => s !== undefined);

  return { series };
}
