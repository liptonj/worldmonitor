/**
 * News domain handler — news:*, headlines, insights.
 */

import type { AppContext } from '@/app/app-context';
import type { NewsItem } from '@/types';
import type { TimeRange } from '@/components';
import { getFeeds, getIntelSources, SITE_VARIANT } from '@/config';
import { INTEL_HOTSPOTS, CONFLICT_ZONES } from '@/config/geo';
import { tokenizeForMatch, matchKeyword } from '@/utils/keyword-match';
import { checkBatchForBreakingAlerts } from '@/services/breaking-news-alerts';
import { mlWorker } from '@/services/ml-worker';
import { clusterNewsHybrid } from '@/services/clustering';
import { signalAggregator } from '@/services/signal-aggregator';
import { updateBaseline, calculateDeviation } from '@/services';
import { updateAndCheck } from '@/services/temporal-baseline';
import { ingestTemporalAnomaliesForCII } from '@/services/country-instability';
import { canQueueAiClassification, AI_CLASSIFY_MAX_PER_FEED } from '@/services/ai-classify-queue';
import { classifyWithAI } from '@/services/threat-classifier';
import { ingestHeadlines } from '@/services/trending-keywords';
import { getAiFlowSettings } from '@/services/ai-flow-settings';
import { t } from '@/services/i18n';
import { analysisWorker } from '@/services';
import type { ListFeedDigestResponse } from '@/generated/client/worldmonitor/news/v1/service_client';
import type { InsightsPanel } from '@/components/InsightsPanel';
import type { CIIPanel } from '@/components/CIIPanel';
import type { MonitorPanel } from '@/components/MonitorPanel';
import type { HeadlinesPanel } from '@/components/HeadlinesPanel';
import type { ChannelHandler } from './types';
import type { HandlerCallbacks } from './types';

import type { ThreatLevel as ClientThreatLevel } from '@/services/threat-classifier';
import type { NewsItem as ProtoNewsItem, ThreatLevel as ProtoThreatLevel } from '@/generated/client/worldmonitor/news/v1/service_client';
import { classifyNewsItem } from '@/services/positive-classifier';

const PROTO_TO_CLIENT_LEVEL: Record<ProtoThreatLevel, ClientThreatLevel> = {
  THREAT_LEVEL_UNSPECIFIED: 'info',
  THREAT_LEVEL_LOW: 'low',
  THREAT_LEVEL_MEDIUM: 'medium',
  THREAT_LEVEL_HIGH: 'high',
  THREAT_LEVEL_CRITICAL: 'critical',
};

function protoItemToNewsItem(p: ProtoNewsItem): NewsItem {
  const level = PROTO_TO_CLIENT_LEVEL[p.threat?.level ?? 'THREAT_LEVEL_UNSPECIFIED'];
  return {
    source: p.source,
    title: p.title,
    link: p.link,
    pubDate: new Date(p.publishedAt),
    isAlert: p.isAlert,
    threat: p.threat ? {
      level,
      category: p.threat.category as import('@/services/threat-classifier').EventCategory,
      confidence: p.threat.confidence,
      source: (p.threat.source || 'keyword') as 'keyword' | 'ml' | 'llm',
    } : undefined,
    ...(p.locationName && { locationName: p.locationName }),
    ...(p.location && { lat: p.location.latitude, lon: p.location.longitude }),
  };
}

const MAP_FLASH_COOLDOWN_MS = 10 * 60 * 1000;

function getTimeRangeWindowMs(range: TimeRange): number {
  const ranges: Record<TimeRange, number> = {
    '1h': 60 * 60 * 1000,
    '6h': 6 * 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '48h': 48 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    'all': Infinity,
  };
  return ranges[range];
}

function getTimeRangeLabel(range: TimeRange): string {
  const labels: Record<TimeRange, string> = {
    '1h': 'the last hour',
    '6h': 'the last 6 hours',
    '24h': 'the last 24 hours',
    '48h': 'the last 48 hours',
    '7d': 'the last 7 days',
    'all': 'all time',
  };
  return labels[range];
}

function filterItemsByTimeRange(items: NewsItem[], range: TimeRange): NewsItem[] {
  if (range === 'all') return items;
  const cutoff = Date.now() - getTimeRangeWindowMs(range);
  return items.filter((item) => {
    const ts = item.pubDate instanceof Date ? item.pubDate.getTime() : new Date(item.pubDate).getTime();
    return Number.isFinite(ts) ? ts >= cutoff : true;
  });
}

/** Renders news items for a category. Exported for loadNewsCategory and applyTimeRangeFilter. */
export function renderNewsForCategory(ctx: AppContext, category: string, items: NewsItem[]): void {
  ctx.newsByCategory[category] = items;
  const panel = ctx.newsPanels[category];
  if (!panel) return;
  const filteredItems = filterItemsByTimeRange(items, ctx.currentTimeRange);
  if (filteredItems.length === 0 && items.length > 0) {
    panel.renderFilteredEmpty(`No items in ${getTimeRangeLabel(ctx.currentTimeRange)}`);
    return;
  }
  panel.renderNews(filteredItems);
}

export function createNewsHandlers(
  ctx: AppContext,
  callbacks?: HandlerCallbacks
): Record<string, ChannelHandler> {
  const mapFlashCache = new Map<string, number>();

  function findFlashLocation(title: string): { lat: number; lon: number } | null {
    const tokens = tokenizeForMatch(title);
    let bestMatch: { lat: number; lon: number; matches: number } | null = null;

    const countKeywordMatches = (keywords: string[] | undefined): number => {
      if (!keywords) return 0;
      let matches = 0;
      for (const keyword of keywords) {
        const cleaned = keyword.trim().toLowerCase();
        if (cleaned.length >= 3 && matchKeyword(tokens, cleaned)) {
          matches++;
        }
      }
      return matches;
    };

    for (const hotspot of INTEL_HOTSPOTS) {
      const matches = countKeywordMatches(hotspot.keywords);
      if (matches > 0 && (!bestMatch || matches > bestMatch.matches)) {
        bestMatch = { lat: hotspot.lat, lon: hotspot.lon, matches };
      }
    }

    for (const conflict of CONFLICT_ZONES) {
      const matches = countKeywordMatches(conflict.keywords);
      if (matches > 0 && (!bestMatch || matches > bestMatch.matches)) {
        bestMatch = { lat: conflict.center[1], lon: conflict.center[0], matches };
      }
    }

    return bestMatch;
  }

  function flashMapForNews(items: NewsItem[]): void {
    if (!ctx.map || !ctx.initialLoadComplete) return;
    if (!getAiFlowSettings().mapNewsFlash) return;
    const now = Date.now();

    for (const [key, timestamp] of mapFlashCache.entries()) {
      if (now - timestamp > MAP_FLASH_COOLDOWN_MS) {
        mapFlashCache.delete(key);
      }
    }

    for (const item of items) {
      const cacheKey = `${item.source}|${item.link || item.title}`;
      const lastSeen = mapFlashCache.get(cacheKey);
      if (lastSeen && now - lastSeen < MAP_FLASH_COOLDOWN_MS) {
        continue;
      }

      const location = findFlashLocation(item.title);
      if (!location) continue;

      ctx.map!.flashLocation(location.lat, location.lon);
      mapFlashCache.set(cacheKey, now);
    }
  }

  function updateMonitorResults(): void {
    const monitorPanel = ctx.panels['monitors'] as MonitorPanel;
    monitorPanel.renderResults(ctx.allNews);
  }

  function updateHeadlinesPanel(): void {
    const panel = ctx.panels['headlines'];
    if (panel && 'renderItems' in panel) {
      (panel as HeadlinesPanel).renderItems(ctx.allNews);
    }
  }

  function processDigestData(data: ListFeedDigestResponse): void {
    if (!data?.categories || typeof data.categories !== 'object') return;

    const feedsMap = getFeeds();
    const categories = Object.entries(feedsMap)
      .filter((entry): entry is [string, import('@/types').Feed[]] => Array.isArray(entry[1]) && entry[1].length > 0)
      .map(([key, feeds]) => ({ key, feeds }));

    const collectedNews: NewsItem[] = [];

    for (const { key: category, feeds } of categories) {
      if (!(category in data.categories)) continue;

      const enabledFeeds = (feeds ?? []).filter(f => !ctx.disabledSources.has(f.name));
      if (enabledFeeds.length === 0) {
        delete ctx.newsByCategory[category];
        const panel = ctx.newsPanels[category];
        if (panel) panel.showError(t('common.allSourcesDisabled'));
        ctx.statusPanel?.updateFeed(category.charAt(0).toUpperCase() + category.slice(1), {
          status: 'ok',
          itemCount: 0,
        });
        continue;
      }

      const enabledNames = new Set(enabledFeeds.map(f => f.name));
      const items = (data.categories[category]?.items ?? [])
        .map(protoItemToNewsItem)
        .filter(i => enabledNames.has(i.source));

      ingestHeadlines(items.map(i => ({ title: i.title, pubDate: i.pubDate, source: i.source, link: i.link })));

      const aiCandidates = items
        .filter(i => i.threat?.source === 'keyword')
        .sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime())
        .slice(0, AI_CLASSIFY_MAX_PER_FEED);
      for (const item of aiCandidates) {
        if (!canQueueAiClassification(item.title)) continue;
        classifyWithAI(item.title, SITE_VARIANT).then(ai => {
          if (ai && item.threat && ai.confidence > item.threat.confidence) {
            item.threat = ai;
            item.isAlert = ai.level === 'critical' || ai.level === 'high';
          }
        }).catch(() => {});
      }

      checkBatchForBreakingAlerts(items);
      flashMapForNews(items);
      renderNewsForCategory(ctx, category, items);

      ctx.statusPanel?.updateFeed(category.charAt(0).toUpperCase() + category.slice(1), {
        status: 'ok',
        itemCount: items.length,
      });

      const panel = ctx.newsPanels[category];
      if (panel) {
        updateBaseline(`news:${category}`, items.length)
          .then(baseline => {
            const deviation = calculateDeviation(items.length, baseline);
            panel.setDeviation(deviation.zScore, deviation.percentChange, deviation.level);
          })
          .catch(e => { console.warn(`[Baseline] news:${category} write failed:`, e); });
      }

      collectedNews.push(...items);
    }

    if (SITE_VARIANT === 'full' && data.categories && 'intel' in data.categories) {
      const enabledIntelSources = getIntelSources().filter(f => !ctx.disabledSources.has(f.name));
      const enabledIntelNames = new Set(enabledIntelSources.map(f => f.name));
      const intelPanel = ctx.newsPanels['intel'];

      if (enabledIntelSources.length === 0) {
        delete ctx.newsByCategory['intel'];
        if (intelPanel) intelPanel.showError(t('common.allIntelSourcesDisabled'));
        ctx.statusPanel?.updateFeed('Intel', { status: 'ok', itemCount: 0 });
      } else {
        const intel = (data.categories['intel']?.items ?? [])
          .map(protoItemToNewsItem)
          .filter(i => enabledIntelNames.has(i.source));
        checkBatchForBreakingAlerts(intel);
        renderNewsForCategory(ctx, 'intel', intel);
        if (intelPanel) {
          updateBaseline('news:intel', intel.length)
            .then(baseline => {
              const deviation = calculateDeviation(intel.length, baseline);
              intelPanel.setDeviation(deviation.zScore, deviation.percentChange, deviation.level);
            })
            .catch(e => { console.warn('[Baseline] news:intel write failed:', e); });
        }
        ctx.statusPanel?.updateFeed('Intel', { status: 'ok', itemCount: intel.length });
        collectedNews.push(...intel);
        flashMapForNews(intel);
      }
    }

    if (SITE_VARIANT === 'happy') {
      for (const item of collectedNews) {
        item.happyCategory = classifyNewsItem(item.source, item.title);
      }
      ctx.happyAllItems = collectedNews;
    }

    ctx.allNews = collectedNews;
    ctx.initialLoadComplete = true;

    updateAndCheck([
      { type: 'news', region: 'global', count: collectedNews.length },
    ]).then(anomalies => {
      if (anomalies.length > 0) {
        signalAggregator.ingestTemporalAnomalies(anomalies);
        ingestTemporalAnomaliesForCII(anomalies);
        (ctx.panels['cii'] as CIIPanel)?.refresh();
      }
    }).catch(() => { });

    ctx.map?.updateHotspotActivity(ctx.allNews);
    updateMonitorResults();
    updateHeadlinesPanel();

    void (mlWorker.isAvailable
      ? clusterNewsHybrid(ctx.allNews)
      : analysisWorker.clusterNews(ctx.allNews)
    ).then(clusters => {
      if (ctx.isDestroyed) return;
      ctx.latestClusters = clusters;

      if (clusters.length > 0) {
        const insightsPanel = ctx.panels['insights'] as InsightsPanel | undefined;
        insightsPanel?.updateInsights(clusters);
      }

      const geoLocated = clusters
        .filter((c): c is typeof c & { lat: number; lon: number } => c.lat != null && c.lon != null)
        .map(c => ({
          lat: c.lat,
          lon: c.lon,
          title: c.primaryTitle,
          threatLevel: c.threat?.level ?? 'info',
          timestamp: c.lastUpdated,
        }));
      if (geoLocated.length > 0) {
        ctx.map?.setNewsLocations(geoLocated);
      }
    }).catch(error => {
      console.error('[App] Clustering failed, clusters unchanged:', error);
    });

    if (SITE_VARIANT === 'happy' && callbacks?.onNewsDigestProcessed) {
      void callbacks.onNewsDigestProcessed();
    }
  }

  function applyFlatNewsItems(rawItems: Record<string, unknown>[]): void {
    if (rawItems.length === 0) return;

    const feedsMap = getFeeds();
    const sourceToCategory = new Map<string, string>();
    for (const [category, feeds] of Object.entries(feedsMap)) {
      if (!Array.isArray(feeds)) continue;
      for (const feed of feeds) {
        sourceToCategory.set(feed.name, category);
      }
    }

    const categories: Record<string, { items: Array<Record<string, unknown>> }> = {};
    for (const item of rawItems) {
      const src = item.source as string | undefined;
      const category = (src && sourceToCategory.get(src)) || 'general';
      if (!categories[category]) categories[category] = { items: [] };
      if (item.threat && typeof item.threat === 'object') {
        const threat = item.threat as Record<string, unknown>;
        const lvl = threat.level as string | undefined;
        if (lvl && !lvl.startsWith('THREAT_LEVEL_')) {
          threat.level = `THREAT_LEVEL_${lvl.toUpperCase()}`;
        }
      }
      categories[category].items.push(item);
    }

    processDigestData({
      categories,
      feedStatuses: {},
      generatedAt: new Date().toISOString(),
    } as unknown as ListFeedDigestResponse);
  }

  function applyNewsDigest(payload: unknown): void {
    if (!payload) return;

    if (typeof payload === 'object' && !Array.isArray(payload)) {
      const obj = payload as Record<string, unknown>;
      if (obj.categories && typeof obj.categories === 'object') {
        processDigestData(payload as ListFeedDigestResponse);
        return;
      }
      if (Array.isArray(obj.data)) {
        applyFlatNewsItems(obj.data as Record<string, unknown>[]);
        return;
      }
    }

    if (Array.isArray(payload)) {
      applyFlatNewsItems(payload as Record<string, unknown>[]);
    }
  }

  return {
    'news:full': applyNewsDigest,
    'news:tech': applyNewsDigest,
    'news:happy': applyNewsDigest,
  };
}
