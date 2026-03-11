/**
 * Intelligence domain loader — loadIntelligenceSignals, loadIranEvents, loadProtests,
 * loadMilitary, loadCachedPosturesForBanner, loadSecurityAdvisories, loadTelegramIntel.
 */

import type { DataLoaderBridge } from './loader-bridge';
import type { SocialUnrestEvent } from '@/types';
import { intelStore } from '@/stores/intel-store';
import {
  fetchInternetOutages,
  fetchMilitaryFlights,
  fetchMilitaryVessels,
  fetchUSNIFleetReport,
  initMilitaryVesselStream,
  addToSignalHistory,
  getProtestStatus,
} from '@/services';
import { isMilitaryVesselTrackingConfigured } from '@/services';
import { ingestOutagesForCII, ingestMilitaryForCII, ingestUcdpForCII, ingestHapiForCII, ingestDisplacementForCII, ingestClimateForCII, ingestAdvisoriesForCII, ingestGpsJammingForCII, isInLearningMode } from '@/services/country-instability';
import { signalAggregator } from '@/services/signal-aggregator';
import { analyzeFlightsForSurge, surgeAlertToSignal, detectForeignMilitaryPresence, foreignPresenceToSignal } from '@/services/military-surge';
import { fetchCachedTheaterPosture } from '@/services/cached-theater-posture';
import { fetchGpsInterference } from '@/services/gps-interference';
import { fetchUcdpClassifications, fetchAllHapiSummaries, fetchUcdpEvents, deduplicateAgainstAcled } from '@/services/conflict';
import { fetchUnhcrPopulation } from '@/services/displacement';
import { fetchClimateAnomalies } from '@/services/climate';
import { fetchSecurityAdvisories } from '@/services/security-advisories';
import { enrichEventsWithExposure } from '@/services/population-exposure';
import { dataFreshness } from '@/services/data-freshness';
import type { OrefAlertsResponse } from '@/services/oref-alerts';
import type { CIIPanel } from '@/components/CIIPanel';
import type { UcdpEventsPanel } from '@/components/UcdpEventsPanel';
import type { DisplacementPanel } from '@/components/DisplacementPanel';
import type { ClimateAnomalyPanel } from '@/components/ClimateAnomalyPanel';
import type { PopulationExposurePanel } from '@/components/PopulationExposurePanel';
import type { SecurityAdvisoriesPanel } from '@/components/SecurityAdvisoriesPanel';
import type { StrategicPosturePanel } from '@/components/StrategicPosturePanel';
import type { InsightsPanel } from '@/components/InsightsPanel';
import { ingestFlights, ingestVessels } from '@/services/geo-convergence';

async function loadCachedPosturesForBanner(bridge: DataLoaderBridge): Promise<void> {
  try {
    const data = await fetchCachedTheaterPosture();
    if (data?.postures.length) {
      bridge.renderCriticalBanner(data.postures);
      (bridge.ctx.panels['strategic-posture'] as StrategicPosturePanel | undefined)?.updatePostures(data);
    }
  } catch (error) {
    console.warn('[App] Failed to load cached postures for banner:', error);
  }
}

export const intelligenceLoader = {
  async loadIntelligenceSignals(bridge: DataLoaderBridge): Promise<void> {
    const ctx = bridge.ctx;
    const tasks: Promise<void>[] = [];

    tasks.push((async () => {
      try {
        const outages = await fetchInternetOutages();
        intelStore.intelligenceCache.outages = outages;
        ingestOutagesForCII(outages);
        signalAggregator.ingestOutages(outages);
        dataFreshness.recordUpdate('outages', outages.length);
        if (ctx.mapLayers.outages) {
          ctx.map?.setOutages(outages);
          ctx.map?.setLayerReady('outages', outages.length > 0);
          ctx.statusPanel?.updateFeed('NetBlocks', { status: 'ok', itemCount: outages.length });
        }
      } catch (error) {
        console.error('[Intelligence] Outages fetch failed:', error);
        dataFreshness.recordError('outages', String(error));
      }
    })());

    const protestsTask = (async (): Promise<SocialUnrestEvent[]> => {
      try {
        await bridge.loadChannelWithFallback('conflict', data => bridge.getHandler('conflict')?.(data));
        return intelStore.intelligenceCache.protests?.events || [];
      } catch {
        return [];
      }
    })();
    tasks.push(protestsTask.then(() => undefined));

    tasks.push((async () => {
      try {
        const classifications = await fetchUcdpClassifications();
        ingestUcdpForCII(classifications);
        if (classifications.size > 0) dataFreshness.recordUpdate('ucdp', classifications.size);
      } catch (error) {
        console.error('[Intelligence] UCDP fetch failed:', error);
        dataFreshness.recordError('ucdp', String(error));
      }
    })());

    tasks.push((async () => {
      try {
        const summaries = await fetchAllHapiSummaries();
        ingestHapiForCII(summaries);
        if (summaries.size > 0) dataFreshness.recordUpdate('hapi', summaries.size);
      } catch (error) {
        console.error('[Intelligence] HAPI fetch failed:', error);
        dataFreshness.recordError('hapi', String(error));
      }
    })());

    tasks.push((async () => {
      try {
        if (isMilitaryVesselTrackingConfigured() && ctx.mapLayers.ais) initMilitaryVesselStream();
        const [flightData, vesselData] = await Promise.all([fetchMilitaryFlights(), fetchMilitaryVessels()]);
        intelStore.intelligenceCache.military = {
          flights: flightData.flights,
          flightClusters: flightData.clusters,
          vessels: vesselData.vessels,
          vesselClusters: vesselData.clusters,
        };
        fetchUSNIFleetReport().then(report => { if (report) intelStore.intelligenceCache.usniFleet = report; }).catch(() => {});
        ingestFlights(flightData.flights);
        ingestVessels(vesselData.vessels);
        ingestMilitaryForCII(flightData.flights, vesselData.vessels);
        signalAggregator.ingestFlights(flightData.flights);
        signalAggregator.ingestVessels(vesselData.vessels);
        dataFreshness.recordUpdate('opensky', flightData.flights.length);
        if (ctx.mapLayers.military) {
          ctx.map?.setMilitaryFlights(flightData.flights, flightData.clusters);
          ctx.map?.setMilitaryVessels(vesselData.vessels, vesselData.clusters);
          ctx.map?.updateMilitaryForEscalation(flightData.flights, vesselData.vessels);
          const militaryCount = flightData.flights.length + vesselData.vessels.length;
          ctx.statusPanel?.updateFeed('Military', { status: militaryCount > 0 ? 'ok' : 'warning', itemCount: militaryCount });
        }
        if (!isInLearningMode()) {
          const surgeAlerts = analyzeFlightsForSurge(flightData.flights);
          if (surgeAlerts.length > 0) {
            const surgeSignals = surgeAlerts.map(surgeAlertToSignal);
            addToSignalHistory(surgeSignals);
            if (bridge.shouldShowIntelligenceNotifications()) ctx.signalModal?.show(surgeSignals);
          }
          const foreignAlerts = detectForeignMilitaryPresence(flightData.flights);
          if (foreignAlerts.length > 0) {
            const foreignSignals = foreignAlerts.map(foreignPresenceToSignal);
            addToSignalHistory(foreignSignals);
            if (bridge.shouldShowIntelligenceNotifications()) ctx.signalModal?.show(foreignSignals);
          }
        }
      } catch (error) {
        console.error('[Intelligence] Military fetch failed:', error);
        dataFreshness.recordError('opensky', String(error));
      }
    })());

    tasks.push((async () => {
      try {
        const protestEvents = await protestsTask;
        let result = await fetchUcdpEvents();
        for (let attempt = 1; attempt < 3 && !result.success; attempt++) {
          await new Promise(r => setTimeout(r, 15_000));
          result = await fetchUcdpEvents();
        }
        if (!result.success) {
          dataFreshness.recordError('ucdp_events', 'UCDP events unavailable (retaining prior event state)');
          return;
        }
        const acledEvents = protestEvents.map(e => ({
          latitude: e.lat,
          longitude: e.lon,
          event_date: e.time.toISOString(),
          fatalities: e.fatalities ?? 0,
        }));
        const events = deduplicateAgainstAcled(result.data, acledEvents);
        (ctx.panels['ucdp-events'] as UcdpEventsPanel)?.setEvents(events);
        if (ctx.mapLayers.ucdpEvents) ctx.map?.setUcdpEvents(events);
        if (events.length > 0) dataFreshness.recordUpdate('ucdp_events', events.length);
      } catch (error) {
        console.error('[Intelligence] UCDP events fetch failed:', error);
        dataFreshness.recordError('ucdp_events', String(error));
      }
    })());

    tasks.push((async () => {
      try {
        const unhcrResult = await fetchUnhcrPopulation();
        if (!unhcrResult.ok) {
          dataFreshness.recordError('unhcr', 'UNHCR displacement unavailable (retaining prior displacement state)');
          return;
        }
        const data = unhcrResult.data;
        (ctx.panels['displacement'] as DisplacementPanel)?.setData(data);
        ingestDisplacementForCII(data.countries);
        if (ctx.mapLayers.displacement && data.topFlows) ctx.map?.setDisplacementFlows(data.topFlows);
        if (data.countries.length > 0) dataFreshness.recordUpdate('unhcr', data.countries.length);
      } catch (error) {
        console.error('[Intelligence] UNHCR displacement fetch failed:', error);
        dataFreshness.recordError('unhcr', String(error));
      }
    })());

    tasks.push((async () => {
      try {
        const climateResult = await fetchClimateAnomalies();
        if (!climateResult.ok) {
          dataFreshness.recordError('climate', 'Climate anomalies unavailable (retaining prior climate state)');
          return;
        }
        const anomalies = climateResult.anomalies;
        (ctx.panels['climate'] as ClimateAnomalyPanel)?.setAnomalies(anomalies);
        ingestClimateForCII(anomalies);
        if (ctx.mapLayers.climate) ctx.map?.setClimateAnomalies(anomalies);
        if (anomalies.length > 0) dataFreshness.recordUpdate('climate', anomalies.length);
      } catch (error) {
        console.error('[Intelligence] Climate anomalies fetch failed:', error);
        dataFreshness.recordError('climate', String(error));
      }
    })());

    tasks.push(intelligenceLoader.loadSecurityAdvisories(ctx));
    tasks.push(intelligenceLoader.loadTelegramIntel(bridge));

    tasks.push((async () => {
      try {
        await bridge.loadChannelWithFallback<OrefAlertsResponse>('oref', data => bridge.getHandler('oref')?.(data));
      } catch (error) {
        console.error('[Intelligence] OREF alerts fetch failed:', error);
      }
    })());

    tasks.push((async () => {
      try {
        await bridge.loadChannelWithFallback('strategic-posture', data => bridge.getHandler('strategic-posture')?.(data));
      } catch (error) {
        console.error('[Intelligence] Strategic posture fetch failed:', error);
      }
    })());

    tasks.push((async () => {
      try {
        const data = await fetchGpsInterference();
        if (!data) {
          ingestGpsJammingForCII([]);
          ctx.map?.setLayerReady('gpsJamming', false);
          return;
        }
        ingestGpsJammingForCII(data.hexes);
        if (ctx.mapLayers.gpsJamming) {
          ctx.map?.setGpsJamming(data.hexes);
          ctx.map?.setLayerReady('gpsJamming', data.hexes.length > 0);
        }
        ctx.statusPanel?.updateFeed('GPS Jam', { status: 'ok', itemCount: data.hexes.length });
        dataFreshness.recordUpdate('gpsjam', data.hexes.length);
      } catch {
        ctx.map?.setLayerReady('gpsJamming', false);
        ctx.statusPanel?.updateFeed('GPS Jam', { status: 'error' });
        dataFreshness.recordError('gpsjam', 'GPS fetch failed');
      }
    })());

    await Promise.allSettled(tasks);

    try {
      const ucdpEvts = (ctx.panels['ucdp-events'] as UcdpEventsPanel)?.getEvents?.() || [];
      const events = [
        ...(intelStore.intelligenceCache.protests?.events || []).slice(0, 10).map(e => ({
          id: e.id, lat: e.lat, lon: e.lon, type: 'conflict' as const, name: e.title || 'Protest',
        })),
        ...ucdpEvts.slice(0, 10).map(e => ({
          id: e.id, lat: e.latitude, lon: e.longitude, type: e.type_of_violence as string, name: `${e.side_a} vs ${e.side_b}`,
        })),
      ];
      if (events.length > 0) {
        const exposures = await enrichEventsWithExposure(events);
        (ctx.panels['population-exposure'] as PopulationExposurePanel)?.setExposures(exposures);
        if (exposures.length > 0) dataFreshness.recordUpdate('worldpop', exposures.length);
      } else {
        (ctx.panels['population-exposure'] as PopulationExposurePanel)?.setExposures([]);
      }
    } catch (error) {
      console.error('[Intelligence] Population exposure fetch failed:', error);
      dataFreshness.recordError('worldpop', String(error));
    }

    (ctx.panels['cii'] as CIIPanel)?.refresh();
  },

  async loadIranEvents(bridge: DataLoaderBridge): Promise<void> {
    const ctx = bridge.ctx;
    if (intelStore.intelligenceCache.iranEvents) {
      bridge.getHandler('iran-events')?.({ events: intelStore.intelligenceCache.iranEvents });
      return;
    }
    const loaded = await bridge.loadChannelWithFallback('iran-events', data => bridge.getHandler('iran-events')?.(data));
    if (!loaded) ctx.map?.setLayerReady('iranAttacks', false);
  },

  async loadProtests(bridge: DataLoaderBridge): Promise<void> {
    const ctx = bridge.ctx;
    if (intelStore.intelligenceCache.protests) {
      const protestData = intelStore.intelligenceCache.protests;
      ctx.map?.setProtests(protestData.events);
      ctx.map?.setLayerReady('protests', protestData.events.length > 0);
      const status = getProtestStatus();
      ctx.statusPanel?.updateFeed('Protests', {
        status: 'ok',
        itemCount: protestData.events.length,
        errorMessage: status.acledConfigured === false ? 'ACLED not configured - using GDELT only' : undefined,
      });
      ctx.statusPanel?.updateApi('ACLED', status.acledConfigured === true ? { status: 'ok' } : status.acledConfigured === null ? { status: 'warning' } : { status: 'error' });
      ctx.statusPanel?.updateApi('GDELT Doc', { status: 'ok' });
      if (protestData.sources.gdelt > 0) dataFreshness.recordUpdate('gdelt_doc', protestData.sources.gdelt);
      return;
    }
    const loaded = await bridge.loadChannelWithFallback('conflict', data => bridge.getHandler('conflict')?.(data));
    if (!loaded) {
      ctx.map?.setLayerReady('protests', false);
      ctx.statusPanel?.updateFeed('Protests', { status: 'error', errorMessage: 'No data from relay' });
      ctx.statusPanel?.updateApi('ACLED', { status: 'error' });
      ctx.statusPanel?.updateApi('GDELT Doc', { status: 'error' });
    }
  },

  async loadMilitary(bridge: DataLoaderBridge): Promise<void> {
    const ctx = bridge.ctx;
    if (intelStore.intelligenceCache.military) {
      const { flights, flightClusters, vessels, vesselClusters } = intelStore.intelligenceCache.military;
      ctx.map?.setMilitaryFlights(flights, flightClusters);
      ctx.map?.setMilitaryVessels(vessels, vesselClusters);
      ctx.map?.updateMilitaryForEscalation(flights, vessels);
      await loadCachedPosturesForBanner(bridge);
      (ctx.panels['insights'] as InsightsPanel | undefined)?.setMilitaryFlights(flights);
      const hasData = flights.length > 0 || vessels.length > 0;
      ctx.map?.setLayerReady('military', hasData);
      const militaryCount = flights.length + vessels.length;
      ctx.statusPanel?.updateFeed('Military', {
        status: militaryCount > 0 ? 'ok' : 'warning',
        itemCount: militaryCount,
        errorMessage: militaryCount === 0 ? 'No military activity in view' : undefined,
      });
      ctx.statusPanel?.updateApi('OpenSky', { status: 'ok' });
      return;
    }
    try {
      if (isMilitaryVesselTrackingConfigured() && ctx.mapLayers.ais) initMilitaryVesselStream();
      const [flightData, vesselData] = await Promise.all([fetchMilitaryFlights(), fetchMilitaryVessels()]);
      intelStore.intelligenceCache.military = {
        flights: flightData.flights,
        flightClusters: flightData.clusters,
        vessels: vesselData.vessels,
        vesselClusters: vesselData.clusters,
      };
      fetchUSNIFleetReport().then(report => { if (report) intelStore.intelligenceCache.usniFleet = report; }).catch(() => {});
      ctx.map?.setMilitaryFlights(flightData.flights, flightData.clusters);
      ctx.map?.setMilitaryVessels(vesselData.vessels, vesselData.clusters);
      ingestFlights(flightData.flights);
      ingestVessels(vesselData.vessels);
      ingestMilitaryForCII(flightData.flights, vesselData.vessels);
      signalAggregator.ingestFlights(flightData.flights);
      signalAggregator.ingestVessels(vesselData.vessels);
      ctx.map?.updateMilitaryForEscalation(flightData.flights, vesselData.vessels);
      (ctx.panels['cii'] as CIIPanel)?.refresh();
      if (!isInLearningMode()) {
        const surgeAlerts = analyzeFlightsForSurge(flightData.flights);
        if (surgeAlerts.length > 0) {
          const surgeSignals = surgeAlerts.map(surgeAlertToSignal);
          addToSignalHistory(surgeSignals);
          if (bridge.shouldShowIntelligenceNotifications()) ctx.signalModal?.show(surgeSignals);
        }
        const foreignAlerts = detectForeignMilitaryPresence(flightData.flights);
        if (foreignAlerts.length > 0) {
          const foreignSignals = foreignAlerts.map(foreignPresenceToSignal);
          addToSignalHistory(foreignSignals);
          if (bridge.shouldShowIntelligenceNotifications()) ctx.signalModal?.show(foreignSignals);
        }
      }
      await loadCachedPosturesForBanner(bridge);
      (ctx.panels['insights'] as InsightsPanel | undefined)?.setMilitaryFlights(flightData.flights);
      const hasData = flightData.flights.length > 0 || vesselData.vessels.length > 0;
      ctx.map?.setLayerReady('military', hasData);
      const militaryCount = flightData.flights.length + vesselData.vessels.length;
      ctx.statusPanel?.updateFeed('Military', {
        status: militaryCount > 0 ? 'ok' : 'warning',
        itemCount: militaryCount,
        errorMessage: militaryCount === 0 ? 'No military activity in view' : undefined,
      });
      ctx.statusPanel?.updateApi('OpenSky', { status: 'ok' });
      dataFreshness.recordUpdate('opensky', flightData.flights.length);
    } catch (error) {
      ctx.map?.setLayerReady('military', false);
      ctx.statusPanel?.updateFeed('Military', { status: 'error', errorMessage: String(error) });
      ctx.statusPanel?.updateApi('OpenSky', { status: 'error' });
      dataFreshness.recordError('opensky', String(error));
    }
  },

  async loadSecurityAdvisories(ctx: import('@/app/app-context').AppContext): Promise<void> {
    try {
      const result = await fetchSecurityAdvisories();
      if (result.ok) {
        (ctx.panels['security-advisories'] as SecurityAdvisoriesPanel)?.setData(result.advisories);
        intelStore.intelligenceCache.advisories = result.advisories;
        ingestAdvisoriesForCII(result.advisories);
      }
    } catch (error) {
      console.error('[App] Security advisories fetch failed:', error);
    }
  },

  async loadTelegramIntel(bridge: DataLoaderBridge): Promise<void> {
    try {
      await bridge.loadChannelWithFallback('telegram', data => bridge.getHandler('telegram')?.(data));
    } catch (error) {
      console.error('[App] Telegram intel fetch failed:', error);
    }
  },
};
