/**
 * Geo domain handler — natural, eonet, gdacs, weather, climate, gps-interference.
 */

import type { AppContext } from '@/app/app-context';
import { intelStore } from '@/stores/intel-store';
import { mapClimatePayload } from '@/services/climate';
import { parseGpsJamPayload } from '@/services/gps-interference';
import { dataFreshness } from '@/services/data-freshness';
import { flattenFires, computeRegionStats, toMapFires } from '@/services/wildfires';
import { ingestClimateForCII, ingestSatelliteFiresForCII, ingestGpsJammingForCII } from '@/services/country-instability';
import { signalAggregator } from '@/services/signal-aggregator';
import { updateAndCheck } from '@/services/temporal-baseline';
import { ingestTemporalAnomaliesForCII } from '@/services/country-instability';
import type { ListFireDetectionsResponse } from '@/generated/client/worldmonitor/wildfire/v1/service_client';
import type { CIIPanel } from '@/components/CIIPanel';
import type { ClimateAnomalyPanel } from '@/components/ClimateAnomalyPanel';
import type { SatelliteFiresPanel } from '@/components/SatelliteFiresPanel';
import type { HandlerCallbacks } from './types';

/** Merges eonet/gdacs events and renders to map. Exported for loadNatural cache path. */
export function mergeAndRenderNaturalEvents(ctx: AppContext): void {
  const eonet = intelStore.intelligenceCache.eonetEvents ?? [];
  const gdacs = intelStore.intelligenceCache.gdacsEvents ?? [];
  const seen = new Set<string>();
  const merged: import('@/types').NaturalEvent[] = [];
  for (const e of [...gdacs, ...eonet]) {
    const key = `${e.lat.toFixed(1)}-${e.lon.toFixed(1)}-${e.category}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(e);
    }
  }
  ctx.map?.setNaturalEvents(merged);
  ctx.statusPanel?.updateFeed('EONET', { status: 'ok', itemCount: merged.length });
  ctx.statusPanel?.updateApi('NASA EONET', { status: 'ok' });
  ctx.map?.setLayerReady('natural', merged.length > 0);
}

export function createGeoHandlers(ctx: AppContext, callbacks?: HandlerCallbacks): Record<string, (payload: unknown) => void> {

  function renderNatural(data: ListFireDetectionsResponse): void {
    const detections = data.fireDetections ?? [];
    if (detections.length > 0) callbacks?.onNaturalApplied?.(data);
    if (detections.length === 0) {
      ingestSatelliteFiresForCII([]);
      (ctx.panels['cii'] as CIIPanel)?.refresh();
      (ctx.panels['satellite-fires'] as SatelliteFiresPanel)?.update([], 0);
      ctx.statusPanel?.updateApi('FIRMS', { status: 'ok' });
      return;
    }
    const regions: Record<string, import('@/services/wildfires').FireDetection[]> = {};
    for (const d of detections) {
      const r = d.region || 'Unknown';
      (regions[r] ??= []).push(d);
    }
    const flat = flattenFires(regions);
    const stats = computeRegionStats(regions);
    const satelliteFires = flat.map(f => ({
      lat: f.location?.latitude ?? 0,
      lon: f.location?.longitude ?? 0,
      brightness: f.brightness,
      frp: f.frp,
      region: f.region,
      acq_date: new Date(f.detectedAt).toISOString().slice(0, 10),
    }));
    signalAggregator.ingestSatelliteFires(satelliteFires);
    ingestSatelliteFiresForCII(satelliteFires);
    (ctx.panels['cii'] as CIIPanel)?.refresh();
    ctx.map?.setFires(toMapFires(flat));
    (ctx.panels['satellite-fires'] as SatelliteFiresPanel)?.update(stats, flat.length);
    dataFreshness.recordUpdate('firms', flat.length);
    updateAndCheck([{ type: 'satellite_fires', region: 'global', count: flat.length }]).then(anomalies => {
      if (anomalies.length > 0) {
        signalAggregator.ingestTemporalAnomalies(anomalies);
        ingestTemporalAnomaliesForCII(anomalies);
        (ctx.panels['cii'] as CIIPanel)?.refresh();
      }
    }).catch(() => { });
    ctx.statusPanel?.updateApi('FIRMS', { status: 'ok' });
  }

  function renderWeatherAlerts(alerts: import('@/services/weather').WeatherAlert[]): void {
    intelStore.intelligenceCache.weatherAlerts = alerts;
    ctx.map?.setWeatherAlerts(alerts);
    ctx.map?.setLayerReady('weather', alerts.length > 0);
    ctx.statusPanel?.updateFeed('Weather', { status: 'ok', itemCount: alerts.length });
    dataFreshness.recordUpdate('weather', alerts.length);
  }

  function renderGpsInterference(data: import('@/services/gps-interference').GpsJamData): void {
    ingestGpsJammingForCII(data.hexes);
    if (ctx.mapLayers.gpsJamming) {
      ctx.map?.setGpsJamming(data.hexes);
      ctx.map?.setLayerReady('gpsJamming', data.hexes.length > 0);
    }
    ctx.statusPanel?.updateFeed('GPS Jam', { status: 'ok', itemCount: data.hexes.length });
    dataFreshness.recordUpdate('gpsjam', data.hexes.length);
  }

  return {
    natural: (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return;
      const data = payload as ListFireDetectionsResponse;
      if (!Array.isArray(data.fireDetections)) return;
      renderNatural(data);
    },
    eonet: (payload: unknown) => {
      if (!payload || !Array.isArray(payload)) return;
      const events = payload as import('@/types').NaturalEvent[];
      const valid = events.filter((e): e is import('@/types').NaturalEvent =>
        e && typeof e === 'object' && typeof e.lat === 'number' && typeof e.lon === 'number' && typeof e.id === 'string');
      intelStore.intelligenceCache.eonetEvents = valid;
      mergeAndRenderNaturalEvents(ctx);
    },
    gdacs: (payload: unknown) => {
      if (!payload || !Array.isArray(payload)) return;
      const raw = payload as unknown[];
      const GDACS_TO_CATEGORY: Record<string, import('@/types').NaturalEventCategory> = {
        EQ: 'earthquakes', FL: 'floods', TC: 'severeStorms', VO: 'volcanoes', WF: 'wildfires', DR: 'drought',
      };
      const events: import('@/types').NaturalEvent[] = [];
      for (const item of raw) {
        const g = item as Record<string, unknown>;
        if (!g || typeof g !== 'object' || !g.id || !g.coordinates || !Array.isArray(g.coordinates)) continue;
        const coords = g.coordinates as [number, number];
        const eventType = String(g.eventType ?? '');
        const category = GDACS_TO_CATEGORY[eventType] || 'manmade';
        events.push({
          id: String(g.id),
          title: `${g.alertLevel === 'Red' ? '🔴 ' : g.alertLevel === 'Orange' ? '🟠 ' : ''}${String(g.name ?? '')}`,
          description: `${String(g.description ?? '')}${g.severity ? ` - ${g.severity}` : ''}`,
          category,
          categoryTitle: String(g.description ?? ''),
          lat: coords[1],
          lon: coords[0],
          date: g.fromDate ? new Date(g.fromDate as string) : new Date(),
          sourceUrl: g.url ? String(g.url) : undefined,
          sourceName: 'GDACS',
          closed: false,
        });
      }
      intelStore.intelligenceCache.gdacsEvents = events;
      mergeAndRenderNaturalEvents(ctx);
    },
    weather: (payload: unknown) => {
      if (!Array.isArray(payload)) return;
      const alerts = payload.map((a: unknown) => {
        const item = a as Record<string, unknown>;
        return {
          id: String(item.id ?? ''),
          event: String(item.event ?? ''),
          severity: (item.severity ?? 'Unknown') as import('@/services/weather').WeatherAlert['severity'],
          headline: String(item.headline ?? ''),
          description: String(item.description ?? ''),
          areaDesc: String(item.areaDesc ?? ''),
          onset: item.onset ? new Date(item.onset as string | number) : new Date(),
          expires: item.expires ? new Date(item.expires as string | number) : new Date(),
          coordinates: (Array.isArray(item.coordinates) ? item.coordinates : []) as [number, number][],
          centroid: Array.isArray(item.centroid) ? (item.centroid as [number, number]) : undefined,
        };
      });
      renderWeatherAlerts(alerts);
    },
    climate: (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return;
      const resp = (Array.isArray(payload) ? { anomalies: payload } : payload) as import('@/generated/client/worldmonitor/climate/v1/service_client').ListClimateAnomaliesResponse;
      if (!Array.isArray(resp.anomalies)) return;
      const anomalies = mapClimatePayload(resp);
      if (anomalies.length === 0) return;
      (ctx.panels['climate'] as ClimateAnomalyPanel)?.setAnomalies(anomalies);
      ingestClimateForCII(anomalies);
      if (ctx.mapLayers.climate) ctx.map?.setClimateAnomalies(anomalies);
      dataFreshness.recordUpdate('climate', anomalies.length);
    },
    'gps-interference': (payload: unknown) => {
      const adapted = Array.isArray(payload) ? { hexes: payload } : payload;
      const data = parseGpsJamPayload(adapted);
      if (!data) return;
      renderGpsInterference(data);
    },
  };
}
