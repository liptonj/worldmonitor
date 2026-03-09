/**
 * AI domain handler — ai:intel-digest, ai:panel-summary, ai:article-summaries, ai:classifications, ai:country-briefs, ai:posture-analysis, ai:instability-analysis, ai:risk-overview.
 */

import type { AppContext } from '@/app/app-context';

export function createAiHandlers(ctx: AppContext): Record<string, (payload: unknown) => void> {
  return {
    'ai:intel-digest': (payload: unknown) => {
      const digestPanel = ctx.panels['global-digest'] as { applyAiDigest?: (p: unknown) => void } | undefined;
      digestPanel?.applyAiDigest?.(payload);
    },
    'ai:panel-summary': (payload: unknown) => {
      // Check for error codes from server (provider_missing, prompt_missing, timeout, etc.)
      const response = payload as { errorCode?: string; summary?: string } | undefined;
      if (response?.errorCode) {
        console.error(`[AI Panel Summary] errorCode=${response.errorCode}`);
        // Error handling via i18n keys: errorProviderMissing, errorPromptMissing, errorTimeout, errorRetry
        let errorKey = 'errorRetry'; // default generic error
        if (response.errorCode === 'provider_missing') errorKey = 'errorProviderMissing';
        else if (response.errorCode === 'prompt_missing') errorKey = 'errorPromptMissing';
        else if (response.errorCode === 'timeout') errorKey = 'errorTimeout';
        (ctx as unknown as { latestPanelSummary?: unknown }).latestPanelSummary = { ...response, errorKey };
        (window as unknown as { __wmLatestPanelSummary?: unknown }).__wmLatestPanelSummary = { ...response, errorKey };
        document.dispatchEvent(new CustomEvent('wm:panel-summary-updated', { detail: { ...response, errorKey } }));
        return;
      }
      (ctx as unknown as { latestPanelSummary?: unknown }).latestPanelSummary = payload;
      (window as unknown as { __wmLatestPanelSummary?: unknown }).__wmLatestPanelSummary = payload;
      document.dispatchEvent(new CustomEvent('wm:panel-summary-updated', { detail: payload }));
    },
    'ai:article-summaries': (payload: unknown) => {
      (ctx as unknown as { articleSummaries?: unknown }).articleSummaries = payload;
      (window as unknown as { __wmArticleSummaries?: unknown }).__wmArticleSummaries = payload;
      document.dispatchEvent(new CustomEvent('wm:article-summaries-updated', { detail: payload }));
    },
    'ai:classifications': (payload: unknown) => {
      (ctx as unknown as { classifications?: unknown }).classifications = payload;
      (window as unknown as { __wmRelayClassifications?: unknown }).__wmRelayClassifications = payload;
      document.dispatchEvent(new CustomEvent('wm:classifications-updated', { detail: payload }));
    },
    'ai:country-briefs': (payload: unknown) => {
      (ctx as unknown as { countryBriefs?: unknown }).countryBriefs = payload;
    },
    'ai:posture-analysis': (payload: unknown) => {
      const posturePanel = ctx.panels['strategic-posture'] as { applyAiAnalysis?: (p: unknown) => void } | undefined;
      posturePanel?.applyAiAnalysis?.(payload);
    },
    'ai:instability-analysis': (payload: unknown) => {
      const riskPanel = ctx.panels['strategic-risk'] as { applyInstabilityAnalysis?: (p: unknown) => void } | undefined;
      riskPanel?.applyInstabilityAnalysis?.(payload);
    },
    'ai:risk-overview': (payload: unknown) => {
      const riskPanel = ctx.panels['strategic-risk'] as { applyAiOverview?: (p: unknown) => void } | undefined;
      riskPanel?.applyAiOverview?.(payload);
    },
  };
}
