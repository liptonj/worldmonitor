/**
 * Infrastructure domain handler — cables, cyber, flights, ais, opensky, service-status, tech-events.
 * tech-events: CHANNEL_REGISTRY domain 'infrastructure'; kept for loadTechEvents/relay push.
 */

import type { AppContext } from '@/app/app-context';
import type { MilitaryFlight, MilitaryFlightCluster } from '@/types';
import { t } from '@/services/i18n';
import { intelStore } from '@/stores/intel-store';
import { SITE_VARIANT } from '@/config';
import { adaptCyberThreatsResponse } from '@/services';
import { getAisStatus } from '@/services/maritime';
import { parseCableHealthPayload, setCableHealthCache } from '@/services/cable-health';
import { parseFlightDelaysPayload } from '@/services/aviation';
import { dataFreshness } from '@/services/data-freshness';
import { signalAggregator } from '@/services/signal-aggregator';
import { updateAndCheck } from '@/services/temporal-baseline';
import { ingestCyberThreatsForCII, ingestAviationForCII, ingestAisDisruptionsForCII, ingestTemporalAnomaliesForCII } from '@/services/country-instability';
import type { ListCyberThreatsResponse } from '@/generated/client/worldmonitor/cyber/v1/service_client';
import type { CIIPanel } from '@/components/CIIPanel';
import type { TechEventsPanel } from '@/components/TechEventsPanel';

export function createInfrastructureHandlers(ctx: AppContext): Record<string, (payload: unknown) => void> {
  function renderCyberThreats(threats: import('@/types').CyberThreat[]): void {
    intelStore.cyberThreatsCache = threats;
    ctx.map?.setCyberThreats(threats);
    ctx.map?.setLayerReady('cyberThreats', threats.length > 0);
    ingestCyberThreatsForCII(threats);
    (ctx.panels['cii'] as CIIPanel)?.refresh();
    ctx.statusPanel?.updateFeed('Cyber Threats', { status: 'ok', itemCount: threats.length });
    ctx.statusPanel?.updateApi('Cyber Threats API', { status: 'ok' });
    dataFreshness.recordUpdate('cyber_threats', threats.length);
  }

  function renderFlightDelays(delays: import('@/services/aviation').AirportDelayAlert[]): void {
    ctx.map?.setFlightDelays(delays);
    ctx.map?.setLayerReady('flights', delays.length > 0);
    intelStore.intelligenceCache.flightDelays = delays;
    const severe = delays.filter(d => d.severity === 'major' || d.severity === 'severe' || d.delayType === 'closure');
    if (severe.length > 0) ingestAviationForCII(severe);
    ctx.statusPanel?.updateFeed('Flights', {
      status: 'ok',
      itemCount: delays.length,
    });
    ctx.statusPanel?.updateApi('FAA', { status: 'ok' });
  }

  function renderCableHealth(cables: Record<string, import('@/types').CableHealthRecord>): void {
    ctx.map?.setCableHealth(cables);
    const cableIds = Object.keys(cables);
    const faultCount = cableIds.filter((id) => cables[id]?.status === 'fault').length;
    const degradedCount = cableIds.filter((id) => cables[id]?.status === 'degraded').length;
    ctx.statusPanel?.updateFeed('CableHealth', { status: 'ok', itemCount: faultCount + degradedCount });
  }

  function renderTechEvents(data: import('@/generated/client/worldmonitor/research/v1/service_client').ListTechEventsResponse): void {
    if (!data.success || !Array.isArray(data.events)) return;
    const now = new Date();
    const mapEvents = data.events.map((e: { id: string; title: string; location: string; coords?: { lat: number; lng: number; country: string }; startDate: string; endDate: string; url: string }) => ({
      id: e.id,
      title: e.title,
      location: e.location,
      lat: e.coords?.lat ?? 0,
      lng: e.coords?.lng ?? 0,
      country: e.coords?.country ?? '',
      startDate: e.startDate,
      endDate: e.endDate,
      url: e.url,
      daysUntil: Math.ceil((new Date(e.startDate).getTime() - now.getTime()) / (1000 * 60 * 60 * 24)),
    }));
    ctx.map?.setTechEvents(mapEvents);
    ctx.map?.setLayerReady('techEvents', mapEvents.length > 0);
    (ctx.panels['events'] as TechEventsPanel | undefined)?.setEvents(data.events);
    ctx.statusPanel?.updateFeed('Tech Events', { status: 'ok', itemCount: mapEvents.length });
    if (SITE_VARIANT === 'tech' && ctx.searchModal) {
      ctx.searchModal.registerSource('techevent', mapEvents.map((e: { id: string; title: string; location: string; startDate: string }) => ({
        id: e.id,
        title: e.title,
        subtitle: `${e.location} • ${new Date(e.startDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`,
        data: e,
      })));
    }
  }

  function forwardToPanel(channel: string): (payload: unknown) => void {
    return (payload: unknown) => {
      const panel = ctx.panels[channel] as { applyPush?: (p: unknown) => void } | undefined;
      if (!panel?.applyPush) {
        console.warn(`[wm:${channel}] panel not mounted or missing applyPush`);
        return;
      }
      panel.applyPush(payload);
    };
  }

  function mapOpenSkyStatesToFlights(states: unknown[]): MilitaryFlight[] {
    const now = new Date();
    const flights: MilitaryFlight[] = [];
    for (const state of states) {
      if (!state || typeof state !== 'object') continue;
      const s = state as Record<string, unknown>;
      const lat = typeof s.latitude === 'number' ? s.latitude : null;
      const lon = typeof s.longitude === 'number' ? s.longitude : null;
      if (lat === null || lon === null) continue;
      const icao24 = typeof s.icao24 === 'string' ? s.icao24.toLowerCase() : '';
      const callsign = typeof s.callsign === 'string' ? s.callsign.trim() : '';
      const velocity = typeof s.velocity === 'number' ? s.velocity : 0;
      const altitude = typeof s.baroAltitude === 'number' ? s.baroAltitude : 0;
      flights.push({
        id: `opensky-${icao24 || 'unknown'}`,
        callsign: callsign || `UNKN-${(icao24 || '0000').slice(0, 4).toUpperCase()}`,
        hexCode: (icao24 || 'unknown').toUpperCase(),
        aircraftType: 'unknown',
        operator: 'other',
        operatorCountry: typeof s.originCountry === 'string' ? s.originCountry : '',
        lat,
        lon,
        altitude: altitude ? Math.round(altitude * 3.28084) : 0,
        heading: 0,
        speed: velocity ? Math.round(velocity * 1.94384) : 0,
        onGround: Boolean(s.onGround),
        lastSeen: now,
        confidence: 'low',
      });
    }
    return flights;
  }

  return {
    cables: (payload: unknown) => {
      let adapted = payload;
      if (Array.isArray(payload)) {
        const cables: Record<string, unknown> = {};
        for (const item of payload) {
          const entry = item as Record<string, unknown>;
          if (entry.id) cables[entry.id as string] = entry;
        }
        adapted = { cables, generatedAt: Date.now() };
      }
      const healthData = parseCableHealthPayload(adapted);
      if (!healthData) {
        console.error('[wm:cables] failed to parse cable health payload');
        ctx.statusPanel?.updateFeed('CableHealth', { status: 'error', itemCount: 0 });
        return;
      }
      setCableHealthCache(healthData);
      renderCableHealth(healthData.cables);
    },
    cyber: (payload: unknown) => {
      if (!payload || typeof payload !== 'object') { console.warn('[wm:cyber] skipped — invalid payload type:', typeof payload); return; }
      const resp = payload as ListCyberThreatsResponse;
      if (!Array.isArray(resp.threats)) {
        console.error('[wm:cyber] malformed payload — threats is not an array');
        renderCyberThreats([]);
        ctx.statusPanel?.updateApi('Cyber Threats API', { status: 'error' });
        return;
      }
      // Heuristic: relay may push raw proto (needs adaptCyberThreatsResponse) or pre-adapted
      // client shape. Pre-adapted items have string 'indicator'. If format changes, update here.
      const first = resp.threats[0] as unknown;
      const isPreAdapted = first && typeof first === 'object' && 'indicator' in first && typeof (first as { indicator?: unknown }).indicator === 'string';
      const threats = isPreAdapted ? (resp.threats as unknown as import('@/types').CyberThreat[]) : adaptCyberThreatsResponse(resp);
      renderCyberThreats(threats);
    },
    flights: (payload: unknown) => {
      const adapted = Array.isArray(payload) ? { alerts: payload } : payload;
      const delays = parseFlightDelaysPayload(adapted);
      if (!delays) {
        console.error('[wm:flights] failed to parse flight delays payload');
        ctx.statusPanel?.updateFeed('Flights', { status: 'error', itemCount: 0 });
        ctx.statusPanel?.updateApi('FAA', { status: 'error' });
        return;
      }
      renderFlightDelays(delays);
    },
    ais: (payload: unknown) => {
      if (!payload || typeof payload !== 'object') { console.warn('[wm:ais] skipped — invalid payload type:', typeof payload); return; }
      const snap = payload as { disruptions?: import('@/types').AisDisruptionEvent[]; density?: import('@/types').AisDensityZone[]; vessels?: unknown[] };
      if (!Array.isArray(snap.disruptions) && !Array.isArray(snap.density)) {
        if (Array.isArray(snap.vessels)) {
          console.warn('[wm:ais] received vessels only — no disruptions or density data');
          ctx.map?.setAisVessels(snap.vessels);
        } else {
          console.error('[wm:ais] malformed payload — no disruptions, density, or vessels arrays');
        }
        return;
      }
      if (!Array.isArray(snap.disruptions) || !Array.isArray(snap.density)) {
        console.warn('[wm:ais] partial AIS data — missing disruptions or density');
        if (Array.isArray(snap.disruptions)) {
          ctx.map?.setAisData(snap.disruptions, []);
          ctx.map?.setLayerReady('ais', snap.disruptions.length > 0);
        } else if (Array.isArray(snap.density)) {
          ctx.map?.setAisData([], snap.density);
          ctx.map?.setLayerReady('ais', snap.density.length > 0);
        }
        (ctx.panels['cii'] as CIIPanel)?.refresh();
        return;
      }
      const aisStatus = getAisStatus();
      ctx.map?.setAisData(snap.disruptions, snap.density);
      signalAggregator.ingestAisDisruptions(snap.disruptions);
      ingestAisDisruptionsForCII(snap.disruptions);
      (ctx.panels['cii'] as CIIPanel)?.refresh();
      updateAndCheck([{ type: 'ais_gaps', region: 'global', count: snap.disruptions.length }]).then(anomalies => {
        if (anomalies.length > 0) {
          signalAggregator.ingestTemporalAnomalies(anomalies);
          ingestTemporalAnomaliesForCII(anomalies);
          (ctx.panels['cii'] as CIIPanel)?.refresh();
        }
      }).catch(() => { });

      const hasData = snap.disruptions.length > 0 || snap.density.length > 0;
      ctx.map?.setLayerReady('ais', hasData);

      const shippingCount = snap.disruptions.length + snap.density.length;
      const shippingStatus = shippingCount > 0 ? 'ok' : (aisStatus.connected ? 'warning' : 'error');
      ctx.statusPanel?.updateFeed('Shipping', {
        status: shippingStatus,
        itemCount: shippingCount,
        errorMessage: !aisStatus.connected && shippingCount === 0 ? 'AIS snapshot unavailable' : undefined,
      });
      ctx.statusPanel?.updateApi('AISStream', {
        status: aisStatus.connected ? 'ok' : 'warning',
      });
      if (hasData) {
        dataFreshness.recordUpdate('ais', shippingCount);
      }
    },
    opensky: (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return;
      const p = payload as Record<string, unknown>;
      const data = (p.data as Record<string, unknown>) ?? p;
      let flights: MilitaryFlight[] = Array.isArray(p.flights) ? (p.flights as MilitaryFlight[]) : Array.isArray(data.flights) ? (data.flights as MilitaryFlight[]) : [];
      if (flights.length === 0 && Array.isArray(data.states)) {
        flights = mapOpenSkyStatesToFlights(data.states);
      }
      const clusters: MilitaryFlightCluster[] = Array.isArray(p.clusters) ? (p.clusters as MilitaryFlightCluster[]) : Array.isArray(data.clusters) ? (data.clusters as MilitaryFlightCluster[]) : [];

      const existing = intelStore.intelligenceCache.military;
      const vessels = existing?.vessels ?? [];
      const vesselClusters = existing?.vesselClusters ?? [];

      intelStore.intelligenceCache.military = {
        flights,
        flightClusters: clusters,
        vessels,
        vesselClusters,
      };

      ctx.map?.setMilitaryFlights(flights, clusters);
      ctx.map?.setLayerReady('military', flights.length > 0 || vessels.length > 0);
      dataFreshness.recordUpdate('opensky', flights.length);
      const militaryCount = flights.length + vessels.length;
      ctx.statusPanel?.updateFeed('Military', { status: militaryCount > 0 ? 'ok' : 'warning', itemCount: militaryCount });
      ctx.statusPanel?.updateApi('OpenSky', { status: 'ok' });
    },
    'service-status': forwardToPanel('service-status'),
    'tech-events': (payload: unknown) => {
      if (!payload || typeof payload !== 'object') { console.warn('[wm:tech-events] skipped — invalid payload type:', typeof payload); return; }
      const data = (Array.isArray(payload) ? { events: payload, success: true } : payload) as import('@/generated/client/worldmonitor/research/v1/service_client').ListTechEventsResponse;
      if (!('events' in data) || !Array.isArray(data.events)) {
        console.error('[wm:tech-events] malformed payload — events is not an array');
        (ctx.panels['events'] as TechEventsPanel | undefined)?.showError(t('common.failedToLoad'));
        return;
      }
      renderTechEvents(data);
    },
  };
}
