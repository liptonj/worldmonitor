import {
  SupplyChainServiceClient,
  type GetShippingRatesResponse,
  type GetChokepointStatusResponse,
  type GetCriticalMineralsResponse,
  type GetSupplyChainDashboardResponse,
  type ShippingIndex,
  type ChokepointInfo,
  type CriticalMineral,
  type MineralProducer,
  type ShippingRatePoint,
} from '@/generated/client/worldmonitor/supply_chain/v1/service_client';
import { createCircuitBreaker } from '@/utils';
import { getHydratedData } from '@/services/bootstrap';

export type {
  GetShippingRatesResponse,
  GetChokepointStatusResponse,
  GetCriticalMineralsResponse,
  ShippingIndex,
  ChokepointInfo,
  CriticalMineral,
  MineralProducer,
  ShippingRatePoint,
};

const client = new SupplyChainServiceClient('', { fetch: (...args) => globalThis.fetch(...args) });

const shippingBreaker = createCircuitBreaker<GetShippingRatesResponse>({ name: 'Shipping Rates', cacheTtlMs: 15 * 60 * 1000, persistCache: true });
const chokepointBreaker = createCircuitBreaker<GetChokepointStatusResponse>({ name: 'Chokepoint Status', cacheTtlMs: 20 * 60 * 1000, persistCache: true });
const mineralsBreaker = createCircuitBreaker<GetCriticalMineralsResponse>({ name: 'Critical Minerals', cacheTtlMs: 60 * 60 * 1000, persistCache: true });
const supplyChainDashboardBreaker = createCircuitBreaker<GetSupplyChainDashboardResponse>({
  name: 'Supply Chain Dashboard',
  cacheTtlMs: 30 * 60 * 1000,
  persistCache: true,
});

const emptyShipping: GetShippingRatesResponse = { indices: [], fetchedAt: '', upstreamUnavailable: false };
const emptyChokepoints: GetChokepointStatusResponse = { chokepoints: [], fetchedAt: '', upstreamUnavailable: false };
const emptyMinerals: GetCriticalMineralsResponse = { minerals: [], fetchedAt: '', upstreamUnavailable: false };
const emptySupplyChainDashboard: GetSupplyChainDashboardResponse = { shipping: undefined, chokepoints: undefined, minerals: undefined };

export async function fetchSupplyChainDashboard(): Promise<GetSupplyChainDashboardResponse> {
  const hShipping = getHydratedData('shippingRates') as GetShippingRatesResponse | undefined;
  const hChokepoints = getHydratedData('supply-chain') as GetChokepointStatusResponse | undefined;
  const hMinerals = getHydratedData('minerals') as GetCriticalMineralsResponse | undefined;
  if (hShipping != null && hChokepoints != null && hMinerals != null) {
    return { shipping: hShipping, chokepoints: hChokepoints, minerals: hMinerals };
  }

  try {
    return await supplyChainDashboardBreaker.execute(async () => {
      return client.getSupplyChainDashboard({});
    }, emptySupplyChainDashboard);
  } catch {
    return emptySupplyChainDashboard;
  }
}

export async function fetchShippingRates(): Promise<GetShippingRatesResponse> {
  const hydrated = getHydratedData('shippingRates') as GetShippingRatesResponse | undefined;
  if (hydrated) return hydrated;

  try {
    return await shippingBreaker.execute(async () => {
      return client.getShippingRates({});
    }, emptyShipping);
  } catch {
    return emptyShipping;
  }
}

export async function fetchChokepointStatus(): Promise<GetChokepointStatusResponse> {
  const hydrated = getHydratedData('supply-chain') as GetChokepointStatusResponse | undefined;
  if (hydrated) return hydrated;

  try {
    return await chokepointBreaker.execute(async () => {
      return client.getChokepointStatus({});
    }, emptyChokepoints);
  } catch {
    return emptyChokepoints;
  }
}

export async function fetchCriticalMinerals(): Promise<GetCriticalMineralsResponse> {
  const hydrated = getHydratedData('minerals') as GetCriticalMineralsResponse | undefined;
  if (hydrated) return hydrated;

  try {
    return await mineralsBreaker.execute(async () => {
      return client.getCriticalMinerals({});
    }, emptyMinerals);
  } catch {
    return emptyMinerals;
  }
}
