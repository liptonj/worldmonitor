/**
 * Geo domain loader — loadNatural, loadTechEvents, loadWeatherAlerts, loadFirmsData, loadPositiveEvents.
 */

import type { DataLoaderBridge } from './loader-bridge';
import { intelStore } from '@/stores/intel-store';
import { SITE_VARIANT } from '@/config';
import { fetchEarthquakes } from '@/services';
import { dataFreshness } from '@/services/data-freshness';
import { ingestEarthquakes } from '@/services/geo-convergence';
import { fetchTechEvents } from '@/services/research';
import { fetchPositiveGeoEvents, geocodePositiveNewsItems } from '@/services/positive-events-geo';
import { mergeAndRenderNaturalEvents } from './geo-handler';

export const geoLoader = {
  async loadNatural(bridge: DataLoaderBridge): Promise<void> {
    const ctx = bridge.ctx;
    const hasCachedNatural = (intelStore.intelligenceCache.eonetEvents?.length ?? 0) > 0 || (intelStore.intelligenceCache.gdacsEvents?.length ?? 0) > 0;
    const hasCachedEarthquakes = (intelStore.intelligenceCache.earthquakes?.length ?? 0) > 0;

    if (hasCachedNatural) mergeAndRenderNaturalEvents(ctx);
    if (hasCachedEarthquakes && intelStore.intelligenceCache.earthquakes) {
      ctx.map?.setEarthquakes(intelStore.intelligenceCache.earthquakes);
      ctx.statusPanel?.updateApi('USGS', { status: 'ok' });
    }
    if (hasCachedNatural || hasCachedEarthquakes) {
      const mergedCount = (intelStore.intelligenceCache.eonetEvents?.length ?? 0) + (intelStore.intelligenceCache.gdacsEvents?.length ?? 0);
      ctx.map?.setLayerReady('natural', mergedCount > 0 || hasCachedEarthquakes);
      if (hasCachedNatural && hasCachedEarthquakes) return;
    }

    const [earthquakeResult, eonetLoaded, gdacsLoaded] = await Promise.all([
      fetchEarthquakes().then(v => ({ status: 'fulfilled' as const, value: v })).catch(e => ({ status: 'rejected' as const, reason: e })),
      bridge.loadChannelWithFallback('eonet', data => bridge.getHandler('eonet')?.(data)),
      bridge.loadChannelWithFallback('gdacs', data => bridge.getHandler('gdacs')?.(data)),
    ]);

    if (earthquakeResult.status === 'fulfilled') {
      intelStore.intelligenceCache.earthquakes = earthquakeResult.value;
      ctx.map?.setEarthquakes(earthquakeResult.value);
      ingestEarthquakes(earthquakeResult.value);
      ctx.statusPanel?.updateApi('USGS', { status: 'ok' });
      dataFreshness.recordUpdate('usgs', earthquakeResult.value.length);
    } else {
      if (!hasCachedEarthquakes) {
        intelStore.intelligenceCache.earthquakes = [];
        ctx.map?.setEarthquakes([]);
        ctx.statusPanel?.updateApi('USGS', { status: 'error' });
        dataFreshness.recordError('usgs', String(earthquakeResult.reason));
      }
    }

    if (!eonetLoaded && !gdacsLoaded && !hasCachedNatural) {
      ctx.map?.setNaturalEvents([]);
      ctx.statusPanel?.updateFeed('EONET', { status: 'error', errorMessage: 'No data from relay' });
      ctx.statusPanel?.updateApi('NASA EONET', { status: 'error' });
    }

    const hasEarthquakes = earthquakeResult.status === 'fulfilled' && earthquakeResult.value.length > 0;
    const hasEonet = eonetLoaded || gdacsLoaded || hasCachedNatural;
    ctx.map?.setLayerReady('natural', hasEarthquakes || hasEonet);
  },

  async loadTechEvents(bridge: DataLoaderBridge): Promise<void> {
    const ctx = bridge.ctx;
    if (SITE_VARIANT !== 'tech' && !ctx.mapLayers.techEvents) return;

    const loaded = await bridge.loadChannelWithFallback('tech-events', data => bridge.getHandler('tech-events')?.(data));
    if (loaded) return;
    try {
      const data = await fetchTechEvents('conference', true, 90, 50);
      if (!data.success) throw new Error(data.error || 'Unknown error');
      bridge.getHandler('tech-events')?.(data);
    } catch (error) {
      console.error('[App] Failed to load tech events:', error);
      ctx.map?.setTechEvents([]);
      ctx.map?.setLayerReady('techEvents', false);
      ctx.statusPanel?.updateFeed('Tech Events', { status: 'error', errorMessage: String(error) });
    }
  },

  async loadWeatherAlerts(bridge: DataLoaderBridge): Promise<void> {
    const ctx = bridge.ctx;
    if (intelStore.intelligenceCache.weatherAlerts) {
      bridge.getHandler('weather')?.(intelStore.intelligenceCache.weatherAlerts);
      return;
    }
    const loaded = await bridge.loadChannelWithFallback('weather', data => bridge.getHandler('weather')?.(data));
    if (!loaded) {
      ctx.map?.setLayerReady('weather', false);
      dataFreshness.recordError('weather', 'Relay data unavailable');
      ctx.statusPanel?.updateFeed('Weather', { status: 'error' });
    }
  },

  async loadFirmsData(bridge: DataLoaderBridge): Promise<void> {
    const ctx = bridge.ctx;
    const firesCache = bridge.getFiresCache();
    if (firesCache && (firesCache.fireDetections?.length ?? 0) > 0) {
      bridge.getHandler('natural')?.(firesCache);
      return;
    }
    const loaded = await bridge.loadChannelWithFallback('natural', data => bridge.getHandler('natural')?.(data));
    if (!loaded) {
      ctx.statusPanel?.updateApi('FIRMS', { status: 'error' });
    }
  },

  async loadPositiveEvents(ctx: import('@/app/app-context').AppContext): Promise<void> {
    const gdeltEvents = await fetchPositiveGeoEvents();
    const rssEvents = geocodePositiveNewsItems(
      ctx.happyAllItems.map(i => ({ title: i.title, category: i.happyCategory }))
    );
    const seen = new Set<string>();
    const merged = [...gdeltEvents, ...rssEvents].filter(e => {
      if (seen.has(e.name)) return false;
      seen.add(e.name);
      return true;
    });
    ctx.map?.setPositiveEvents(merged);
  },
};
