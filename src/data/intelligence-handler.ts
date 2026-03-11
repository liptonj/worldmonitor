/**
 * Intelligence domain handler — intelligence, conflict, ucdp-events, telegram, oref, iran-events, strategic-posture, strategic-risk.
 */

import type { AppContext } from '@/app/app-context';
import type { SocialUnrestEvent } from '@/types';
import { t } from '@/services/i18n';
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
      if (!panel?.applyPush) {
        console.warn(`[wm:${channel}] panel not mounted or missing applyPush`);
        return;
      }
      panel.applyPush(payload);
    };
  }

  return {
    intelligence: (payload: unknown) => {
      if (!payload || typeof payload !== 'object') { console.warn('[wm:intelligence] skipped — invalid payload type:', typeof payload); return; }
      const raw = payload as Record<string, unknown>;
      if (raw.error && raw.data === null) {
        console.error('[wm:intelligence] upstream error — digest temporarily unavailable', raw.error);
        (ctx.panels['global-digest'] as GlobalDigestPanel | undefined)?.showError(
          t('common.digestTemporarilyUnavailable'),
        );
        return;
      }
      const data = payload as GetGlobalIntelDigestResponse;
      if (!data.digest && !data.generatedAt) {
        console.warn('[wm:intelligence] no digest or generatedAt in payload');
        (ctx.panels['global-digest'] as GlobalDigestPanel | undefined)?.showUnavailable(
          t('common.digestNotYetAvailable'),
        );
        return;
      }
      renderIntelligence(data);
    },
    conflict: (payload: unknown) => {
      if (!payload || typeof payload !== 'object') { console.warn('[wm:conflict] skipped — invalid payload type:', typeof payload); return; }
      const resp = payload as import('@/generated/client/worldmonitor/conflict/v1/service_client').ListAcledEventsResponse;
      if (!Array.isArray(resp.events)) {
        console.error('[wm:conflict] malformed payload — events is not an array');
        (ctx.panels['cii'] as CIIPanel | undefined)?.refresh();
        return;
      }
      const data = mapConflictPayload(resp);
      if (data.count === 0) {
        console.warn('[wm:conflict] 0 conflict events received');
        (ctx.panels['cii'] as CIIPanel | undefined)?.refresh();
        return;
      }
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
      if (!result || !result.success) {
        console.error('[wm:ucdp-events] payload parse failed or success=false');
        (ctx.panels['ucdp-events'] as UcdpEventsPanel | undefined)?.setEvents([]);
        return;
      }
      if (result.data.length === 0) {
        (ctx.panels['ucdp-events'] as UcdpEventsPanel | undefined)?.setEvents([]);
        return;
      }
      (ctx.panels['ucdp-events'] as UcdpEventsPanel)?.setEvents(result.data);
      if (ctx.mapLayers.ucdpEvents) ctx.map?.setUcdpEvents(result.data);
      dataFreshness.recordUpdate('ucdp_events', result.count);
    },
    telegram: (payload: unknown) => {
      if (!payload) { console.warn('[wm:telegram] skipped — empty payload'); return; }
      // Accept legacy array payloads and object payloads (root or nested in data).
      if (Array.isArray(payload)) {
        const rawNow = new Date().toISOString();
        const items = payload.map((msg: unknown) => {
          const m = msg as Record<string, unknown>;
          return {
            id: String(m.id ?? ''),
            source: 'telegram' as const,
            channel: String(m.channel ?? ''),
            channelTitle: String(m.label ?? m.channelTitle ?? m.channel ?? ''),
            url: String(m.url ?? ''),
            ts: m.ts ? String(m.ts) : typeof m.date === 'number' ? new Date(m.date).toISOString() : rawNow,
            text: String(m.text ?? ''),
            topic: String(m.topic ?? 'unknown'),
            tags: Array.isArray(m.tags) ? (m.tags as string[]) : [],
            earlySignal: Boolean(m.earlySignal ?? (typeof m.tier === 'number' && m.tier <= 1)),
          };
        });
        (ctx.panels['telegram-intel'] as TelegramIntelPanel)?.setData({
          source: 'telegram',
          earlySignal: items.some(i => i.earlySignal),
          enabled: true,
          count: items.length,
          updatedAt: rawNow,
          items,
        });
        return;
      }
      if (typeof payload !== 'object') { console.warn('[wm:telegram] skipped — invalid payload type:', typeof payload); return; }
      // ingest-telegram may send { data: { messages: [...] } } or raw { messages: [...], count, timestamp }
      const raw = ('data' in (payload as Record<string, unknown>)
        && (payload as Record<string, unknown>).data !== null
        && typeof (payload as Record<string, unknown>).data === 'object')
        ? (payload as Record<string, unknown>).data as Record<string, unknown>
        : payload as Record<string, unknown>;
      if (import.meta.env.DEV) {
        console.debug('[wm:telegram] payload shape:', {
          keys: Object.keys(raw),
          itemCount: Array.isArray(raw.items) ? (raw.items as unknown[]).length : 0,
          msgCount: Array.isArray(raw.messages) ? (raw.messages as unknown[]).length : 0,
        });
      }
      const messages: unknown[] = Array.isArray(raw.items)
        ? raw.items
        : Array.isArray(raw.messages)
          ? raw.messages
          : [];
      if (messages.length === 0) {
        (ctx.panels['telegram-intel'] as TelegramIntelPanel | undefined)?.setData({
          source: 'telegram' as const,
          earlySignal: false,
          enabled: true,
          count: 0,
          updatedAt: String(raw.timestamp ?? new Date().toISOString()),
          items: [],
        });
        return;
      }

      const items = messages.map((msg: unknown) => {
        const m = msg as Record<string, unknown>;
        return {
        id: String(m.id ?? ''),
        source: 'telegram' as const,
        channel: String(m.channel ?? ''),
        channelTitle: String(m.label ?? m.channelTitle ?? m.channel ?? ''),
        url: String(m.url ?? ''),
        ts: m.ts ? String(m.ts) : typeof m.date === 'number' ? new Date(m.date).toISOString() : new Date().toISOString(),
        text: String(m.text ?? ''),
        topic: String(m.topic ?? 'unknown'),
        tags: Array.isArray(m.tags) ? m.tags as string[] : [],
        earlySignal: Boolean(m.earlySignal ?? (typeof m.tier === 'number' && m.tier <= 1)),
      };
      });

      const adapted: import('@/services/telegram-intel').TelegramFeedResponse = {
        source: 'telegram',
        earlySignal: items.some(i => i.earlySignal),
        enabled: true,
        count: items.length,
        updatedAt: String(raw.timestamp ?? new Date().toISOString()),
        items,
      };
      (ctx.panels['telegram-intel'] as TelegramIntelPanel)?.setData(adapted);
    },
    oref: (payload: unknown) => {
      if (!payload || typeof payload !== 'object') { console.warn('[wm:oref] skipped — invalid payload type:', typeof payload); return; }
      let data = payload as OrefAlertsResponse;
      if (!('configured' in data) && !('alerts' in data)) {
        const raw = payload as Record<string, unknown>;
        if ('error' in raw || raw.data === null || raw.data === undefined) {
          const errorMsg = typeof raw.error === 'string' ? raw.error : 'service unavailable';
          console.debug(`[wm:oref] error envelope received: ${errorMsg}`);
          renderOrefAlerts({ configured: false, alerts: [], historyCount24h: 0, timestamp: new Date().toISOString() });
          return;
        }
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
          console.warn('[wm:oref] unrecognized payload shape', { keys: Object.keys(raw).slice(0, 8) });
          renderOrefAlerts({ configured: false, alerts: [], historyCount24h: 0, timestamp: new Date().toISOString() });
          return;
        }
      }
      renderOrefAlerts(data);
    },
    'iran-events': (payload: unknown) => {
      if (!payload || typeof payload !== 'object') { console.warn('[wm:iran-events] skipped — invalid payload type:', typeof payload); return; }
      const resp = payload as { events?: import('@/generated/client/worldmonitor/conflict/v1/service_client').IranEvent[] };
      if (!Array.isArray(resp.events)) {
        console.warn('[wm:iran-events] malformed payload — events is not an array');
        renderIranEvents([]);
        return;
      }
      renderIranEvents(resp.events);
    },
    'strategic-posture': forwardToPanel('strategic-posture'),
    'strategic-risk': forwardToPanel('strategic-risk'),
    gdelt: (payload: unknown) => {
      if (!payload || typeof payload !== 'object') { console.warn('[wm:gdelt] skipped — invalid payload type:', typeof payload); return; }
      const gdeltPanel = ctx.panels['gdelt-intel'] as {
        refresh?: () => void;
        applyRelayData?: (data: unknown) => void;
      } | undefined;
      if (gdeltPanel?.applyRelayData) {
        gdeltPanel.applyRelayData(payload);
      } else if (gdeltPanel?.refresh) {
        console.warn('[wm:gdelt] panel missing applyRelayData — falling back to refresh()');
        gdeltPanel.refresh();
      } else {
        console.warn('[wm:gdelt] panel not mounted');
      }
    },
    pizzint: (payload: unknown) => {
      if (!payload || typeof payload !== 'object') { console.warn('[wm:pizzint] skipped — invalid payload type:', typeof payload); return; }
      const resp = payload as import('@/generated/client/worldmonitor/intelligence/v1/service_client').GetPizzintStatusResponse;
      if (!resp.pizzint && !(Array.isArray(resp.tensionPairs) && resp.tensionPairs.length > 0)) {
        console.warn('[wm:pizzint] no pizzint status or tension pairs — hiding indicator');
        ctx.pizzintIndicator?.hide();
        return;
      }
      const { status, tensions } = parsePizzintResponse(resp);
      renderPizzInt(status, tensions);
    },
  };
}
