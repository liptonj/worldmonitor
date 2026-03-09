/**
 * Intelligence domain handler — intelligence, conflict, ucdp-events, telegram, oref, iran-events, strategic-posture, strategic-risk.
 */

import type { AppContext } from '@/app/app-context';
import type { SocialUnrestEvent } from '@/types';
import { intelStore } from '@/stores/intel-store';
import { mapConflictPayload, mapUcdpPayload } from '@/services/conflict';
import { dataFreshness } from '@/services/data-freshness';
import { ingestConflictsForCII, ingestProtestsForCII, ingestOrefForCII, ingestStrikesForCII } from '@/services/country-instability';
import { ingestProtests } from '@/services/geo-convergence';
import { signalAggregator } from '@/services/signal-aggregator';
import { getProtestStatus } from '@/services/unrest';
import type { OrefAlertsResponse } from '@/services/oref-alerts';
import { dispatchOrefBreakingAlert } from '@/services/breaking-news-alerts';
import { parsePizzintResponse } from '@/services';
import type { GetGlobalIntelDigestResponse } from '@/generated/client/worldmonitor/intelligence/v1/service_client';
import type { CIIPanel } from '@/components/CIIPanel';
import type { GlobalDigestPanel } from '@/components/GlobalDigestPanel';
import type { OrefSirensPanel } from '@/components/OrefSirensPanel';
import type { TelegramIntelPanel } from '@/components/TelegramIntelPanel';
import type { UcdpEventsPanel } from '@/components/UcdpEventsPanel';
import type { ChannelHandler } from './types';

export function createIntelligenceHandlers(ctx: AppContext): Record<string, ChannelHandler> {
  function renderIntelligence(data: GetGlobalIntelDigestResponse): void {
    (ctx.panels['global-digest'] as GlobalDigestPanel | undefined)?.setDigest(data);
  }

  function renderOrefAlerts(data: OrefAlertsResponse): void {
    (ctx.panels['oref-sirens'] as OrefSirensPanel)?.setData(data);
    const alertCount = data.alerts?.length ?? 0;
    const historyCount24h = data.historyCount24h ?? 0;
    ingestOrefForCII(alertCount, historyCount24h);
    intelStore.intelligenceCache.orefAlerts = { alertCount, historyCount24h };
    if (data.alerts?.length) dispatchOrefBreakingAlert(data.alerts);
  }

  function renderIranEvents(events: import('@/generated/client/worldmonitor/conflict/v1/service_client').IranEvent[]): void {
    intelStore.intelligenceCache.iranEvents = events;
    ctx.map?.setIranEvents(events);
    ctx.map?.setLayerReady('iranAttacks', events.length > 0);
    const coerced = events.map(e => ({ ...e, timestamp: Number(e.timestamp) || 0 }));
    signalAggregator.ingestConflictEvents(coerced);
    ingestStrikesForCII(coerced);
    (ctx.panels['cii'] as CIIPanel)?.refresh();
  }

  function renderPizzInt(status: import('@/types').PizzIntStatus, tensions: import('@/types').GdeltTensionPair[]): void {
    if (status.locationsMonitored === 0) {
      ctx.pizzintIndicator?.hide();
      ctx.statusPanel?.updateApi('PizzINT', { status: 'error' });
      dataFreshness.recordError('pizzint', 'No monitored locations returned');
      return;
    }
    ctx.pizzintIndicator?.show();
    ctx.pizzintIndicator?.updateStatus(status);
    ctx.pizzintIndicator?.updateTensions(tensions);
    ctx.statusPanel?.updateApi('PizzINT', { status: 'ok' });
    dataFreshness.recordUpdate('pizzint', Math.max(status.locationsMonitored, tensions.length));
  }

  function forwardToPanel(channel: string): ChannelHandler {
    return (payload: unknown) => {
      const panel = ctx.panels[channel] as { applyPush?: (p: unknown) => void } | undefined;
      panel?.applyPush?.(payload);
    };
  }

  return {
    intelligence: (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return;
      const data = payload as GetGlobalIntelDigestResponse;
      if (!data.digest && !data.generatedAt) return;
      renderIntelligence(data);
    },
    conflict: (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return;
      const resp = payload as import('@/generated/client/worldmonitor/conflict/v1/service_client').ListAcledEventsResponse;
      if (!Array.isArray(resp.events)) return;
      const data = mapConflictPayload(resp);
      if (data.count === 0) return;
      ingestConflictsForCII(data.events);
      dataFreshness.recordUpdate('acled_conflict', data.count);
      const protestEvents: SocialUnrestEvent[] = data.events.map((e) => ({
        id: e.id,
        title: e.location || e.country,
        eventType: 'civil_unrest' as const,
        country: e.country,
        region: e.region,
        lat: e.lat,
        lon: e.lon,
        time: e.time,
        severity: (e.fatalities > 0 ? 'high' : 'medium') as import('@/types').ProtestSeverity,
        sources: [e.source],
        sourceType: 'acled' as const,
        confidence: 'high' as const,
        validated: false,
      }));
      intelStore.intelligenceCache.protests = { events: protestEvents, sources: { acled: data.count, gdelt: 0 } };
      if (ctx.mapLayers.protests) {
        ctx.map?.setProtests(protestEvents);
        ctx.map?.setLayerReady('protests', protestEvents.length > 0);
      }
      ingestProtests(protestEvents);
      ingestProtestsForCII(protestEvents);
      signalAggregator.ingestProtests(protestEvents);
      const status = getProtestStatus();
      ctx.statusPanel?.updateFeed('Protests', { status: 'ok', itemCount: protestEvents.length, errorMessage: status.acledConfigured === false ? 'ACLED not configured - using GDELT only' : undefined });
      ctx.statusPanel?.updateApi('ACLED', status.acledConfigured === true ? { status: 'ok' } : status.acledConfigured === null ? { status: 'warning' } : { status: 'error' });
      ctx.statusPanel?.updateApi('GDELT Doc', { status: 'ok' });
      (ctx.panels['cii'] as CIIPanel)?.refresh();
    },
    'ucdp-events': (payload: unknown) => {
      let adapted = payload;
      if (payload && typeof payload === 'object' && !Array.isArray(payload) && !('data' in (payload as Record<string, unknown>)) && 'events' in (payload as Record<string, unknown>)) {
        const raw = payload as Record<string, unknown>;
        adapted = { ...raw, data: raw.events, success: true };
      }
      const result = mapUcdpPayload(adapted);
      if (!result || !result.success || result.data.length === 0) return;
      (ctx.panels['ucdp-events'] as UcdpEventsPanel)?.setEvents(result.data);
      if (ctx.mapLayers.ucdpEvents) ctx.map?.setUcdpEvents(result.data);
      dataFreshness.recordUpdate('ucdp_events', result.count);
    },
    telegram: (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return;
      const raw = payload as Record<string, unknown>;
      let adapted: import('@/services/telegram-intel').TelegramFeedResponse;
      if ('items' in raw && Array.isArray(raw.items)) {
        adapted = raw as unknown as import('@/services/telegram-intel').TelegramFeedResponse;
      } else if ('messages' in raw && Array.isArray(raw.messages)) {
        adapted = { ...raw, items: raw.messages } as unknown as import('@/services/telegram-intel').TelegramFeedResponse;
      } else {
        return;
      }
      (ctx.panels['telegram-intel'] as TelegramIntelPanel)?.setData(adapted);
    },
    oref: (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return;
      let data = payload as OrefAlertsResponse;
      if (!('configured' in data) && !('alerts' in data)) {
        const raw = payload as Record<string, unknown>;
        if ('current' in raw || 'history' in raw) {
          const current = raw.current as unknown[] | null;
          const history = raw.history as unknown[] | null;
          data = {
            configured: true,
            alerts: Array.isArray(current) ? current as OrefAlertsResponse['alerts'] : [],
            historyCount24h: Array.isArray(history) ? history.length : 0,
            timestamp: new Date().toISOString(),
          };
        } else {
          return;
        }
      }
      renderOrefAlerts(data);
    },
    'iran-events': (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return;
      const resp = payload as { events?: import('@/generated/client/worldmonitor/conflict/v1/service_client').IranEvent[] };
      if (!Array.isArray(resp.events)) return;
      renderIranEvents(resp.events);
    },
    'strategic-posture': forwardToPanel('strategic-posture'),
    'strategic-risk': forwardToPanel('strategic-risk'),
    pizzint: (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return;
      const resp = payload as import('@/generated/client/worldmonitor/intelligence/v1/service_client').GetPizzintStatusResponse;
      if (!resp.pizzint && !(Array.isArray(resp.tensionPairs) && resp.tensionPairs.length > 0)) return;
      const { status, tensions } = parsePizzintResponse(resp);
      renderPizzInt(status, tensions);
    },
  };
}
