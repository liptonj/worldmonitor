/**
 * Infrastructure domain loader — loadOutages, loadCyberThreats, loadAisSignals,
 * waitForAisData, loadCableActivity, loadCableHealth, loadFlightDelays.
 */

import type { DataLoaderBridge } from './loader-bridge';
import { intelStore } from '@/stores/intel-store';
import {
  fetchInternetOutages,
  fetchCableActivity,
  fetchCyberThreats,
  getAisStatus,
} from '@/services';
import { ingestOutagesForCII } from '@/services/country-instability';
import { signalAggregator } from '@/services/signal-aggregator';
import { dataFreshness } from '@/services/data-freshness';

const CYBER_LAYER_ENABLED = import.meta.env.VITE_ENABLE_CYBER_LAYER === 'true';

export const infrastructureLoader = {
  async loadOutages(bridge: DataLoaderBridge): Promise<void> {
    const ctx = bridge.ctx;
    if (intelStore.intelligenceCache.outages) {
      const outages = intelStore.intelligenceCache.outages;
      ctx.map?.setOutages(outages);
      ctx.map?.setLayerReady('outages', outages.length > 0);
      ctx.statusPanel?.updateFeed('NetBlocks', { status: 'ok', itemCount: outages.length });
      return;
    }
    try {
      const outages = await fetchInternetOutages();
      intelStore.intelligenceCache.outages = outages;
      ctx.map?.setOutages(outages);
      ctx.map?.setLayerReady('outages', outages.length > 0);
      ingestOutagesForCII(outages);
      signalAggregator.ingestOutages(outages);
      ctx.statusPanel?.updateFeed('NetBlocks', { status: 'ok', itemCount: outages.length });
      dataFreshness.recordUpdate('outages', outages.length);
    } catch {
      ctx.map?.setLayerReady('outages', false);
      ctx.statusPanel?.updateFeed('NetBlocks', { status: 'error' });
      dataFreshness.recordError('outages', 'Outages fetch failed');
    }
  },

  async loadCyberThreats(bridge: DataLoaderBridge): Promise<void> {
    const ctx = bridge.ctx;
    if (!CYBER_LAYER_ENABLED) {
      ctx.mapLayers.cyberThreats = false;
      ctx.map?.setLayerReady('cyberThreats', false);
      return;
    }
    if (intelStore.cyberThreatsCache) {
      bridge.getHandler('cyber')?.({ threats: intelStore.cyberThreatsCache });
      return;
    }
    const loaded = await bridge.loadChannelWithFallback('cyber', data => bridge.getHandler('cyber')?.(data));
    if (!loaded) {
      const threats = fetchCyberThreats();
      if (threats.length > 0) {
        bridge.getHandler('cyber')?.({ threats });
      } else {
        ctx.map?.setLayerReady('cyberThreats', false);
      }
    }
  },

  async loadAisSignals(bridge: DataLoaderBridge): Promise<void> {
    const ctx = bridge.ctx;
    const loaded = await bridge.loadChannelWithFallback('ais', data => bridge.getHandler('ais')?.(data));
    if (!loaded) {
      ctx.map?.setLayerReady('ais', false);
      ctx.statusPanel?.updateFeed('Shipping', { status: 'error', errorMessage: 'No data from relay' });
      ctx.statusPanel?.updateApi('AISStream', { status: 'error' });
    }
  },

  waitForAisData(bridge: DataLoaderBridge): void {
    const ctx = bridge.ctx;
    const maxAttempts = 30;
    let attempts = 0;

    const checkData = () => {
      if (ctx.isDestroyed) return;
      attempts++;
      const status = getAisStatus();

      if (status.vessels > 0 || status.connected) {
        void infrastructureLoader.loadAisSignals(bridge);
        ctx.map?.setLayerLoading('ais', false);
        return;
      }

      if (attempts >= maxAttempts) {
        ctx.map?.setLayerLoading('ais', false);
        ctx.map?.setLayerReady('ais', false);
        ctx.statusPanel?.updateFeed('Shipping', { status: 'error', errorMessage: 'Connection timeout' });
        return;
      }

      setTimeout(checkData, 1000);
    };

    checkData();
  },

  async loadCableActivity(ctx: import('@/app/app-context').AppContext): Promise<void> {
    try {
      const activity = await fetchCableActivity();
      ctx.map?.setCableActivity(activity.advisories, activity.repairShips);
      const itemCount = activity.advisories.length + activity.repairShips.length;
      ctx.statusPanel?.updateFeed('CableOps', { status: 'ok', itemCount });
    } catch {
      ctx.statusPanel?.updateFeed('CableOps', { status: 'error' });
    }
  },

  async loadCableHealth(bridge: DataLoaderBridge): Promise<void> {
    const ctx = bridge.ctx;
    const loaded = await bridge.loadChannelWithFallback('cables', data => bridge.getHandler('cables')?.(data));
    if (!loaded) {
      ctx.map?.setLayerReady('cables', false);
    }
  },

  async loadFlightDelays(bridge: DataLoaderBridge): Promise<void> {
    const ctx = bridge.ctx;
    if (intelStore.intelligenceCache.flightDelays) {
      bridge.getHandler('flights')?.(intelStore.intelligenceCache.flightDelays);
      return;
    }
    const loaded = await bridge.loadChannelWithFallback('flights', data => bridge.getHandler('flights')?.(data));
    if (!loaded) {
      ctx.map?.setLayerReady('flights', false);
      ctx.statusPanel?.updateFeed('Flights', { status: 'error', errorMessage: 'No data from relay' });
      ctx.statusPanel?.updateApi('FAA', { status: 'error' });
    }
  },
};
