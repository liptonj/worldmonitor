/**
 * Correlation analysis pipeline — clustering, CII ingestion, signal aggregation, notifications.
 * Moved from DataLoaderManager to satisfy "orchestrator only" spec.
 */

import type { AppContext } from '@/app/app-context';
import { newsStore } from '@/stores/news-store';
import { marketsStore } from '@/stores/markets-store';
import { mlWorker } from '@/services/ml-worker';
import { clusterNewsHybrid } from '@/services/clustering';
import { analysisWorker } from '@/services/analysis-worker';
import { ingestNewsForCII, isInLearningMode } from '@/services/country-instability';
import { detectGeoConvergence, geoConvergenceToSignal } from '@/services/geo-convergence';
import { addToSignalHistory, drainTrendingSignals } from '@/services';
import { dataFreshness } from '@/services/data-freshness';
import type { CIIPanel } from '@/components/CIIPanel';

export interface RunCorrelationAnalysisOptions {
  shouldShowNotifications: () => boolean;
}

export async function runCorrelationAnalysis(
  ctx: AppContext,
  options: RunCorrelationAnalysisOptions
): Promise<void> {
  try {
    if (newsStore.latestClusters.length === 0 && newsStore.allNews.length > 0) {
      newsStore.latestClusters = mlWorker.isAvailable
        ? await clusterNewsHybrid(newsStore.allNews)
        : await analysisWorker.clusterNews(newsStore.allNews);
    }
    if (newsStore.latestClusters.length > 0) {
      ingestNewsForCII(newsStore.latestClusters);
      dataFreshness.recordUpdate('gdelt', newsStore.latestClusters.length);
      (ctx.panels['cii'] as CIIPanel)?.refresh();
    }
    const signals = await analysisWorker.analyzeCorrelations(
      newsStore.latestClusters,
      marketsStore.latestPredictions,
      marketsStore.latestMarkets
    );
    let geoSignals: ReturnType<typeof geoConvergenceToSignal>[] = [];
    if (!isInLearningMode()) {
      const geoAlerts = detectGeoConvergence(ctx.seenGeoAlerts);
      geoSignals = geoAlerts.map(geoConvergenceToSignal);
    }
    const keywordSpikeSignals = drainTrendingSignals();
    const allSignals = [...signals, ...geoSignals, ...keywordSpikeSignals];
    if (allSignals.length > 0) {
      addToSignalHistory(allSignals);
      if (options.shouldShowNotifications()) {
        ctx.signalModal?.show(allSignals);
      }
    }
  } catch (error) {
    console.error('[App] Correlation analysis failed:', error);
  }
}
