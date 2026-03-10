/**
 * AI domain handler — ai:intel-digest, ai:panel-summary, ai:article-summaries, ai:classifications, ai:country-briefs, ai:posture-analysis, ai:instability-analysis, ai:risk-overview.
 */

import type { AppContext } from '@/app/app-context';

const aiPayloadBuffer = new Map<string, unknown>();

export function getBufferedAiPayload(channel: string): unknown | undefined {
  return aiPayloadBuffer.get(channel);
}

export function createAiHandlers(ctx: AppContext): Record<string, (payload: unknown) => void> {
  return {
    'ai:intel-digest': (payload: unknown) => {
      if (!payload) { console.warn('[wm:ai:intel-digest] null/undefined payload'); return; }
      aiPayloadBuffer.set('ai:intel-digest', payload);
      const digestPanel = ctx.panels['global-digest'] as { applyAiDigest?: (p: unknown) => void } | undefined;
      if (!digestPanel?.applyAiDigest) {
        console.debug('[wm:ai:intel-digest] panel not yet mounted — payload buffered');
        return;
      }
      digestPanel.applyAiDigest(payload);
    },
    'ai:panel-summary': (payload: unknown) => {
      if (!payload) { console.warn('[wm:ai:panel-summary] null/undefined payload'); return; }
      const response = payload as { errorCode?: string; summary?: string } | undefined;
      if (response?.errorCode) {
        console.error(`[wm:ai:panel-summary] errorCode=${response.errorCode}`);
        let errorKey = 'errorRetry';
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
      if (!payload) { console.warn('[wm:ai:article-summaries] null/undefined payload'); return; }
      (ctx as unknown as { articleSummaries?: unknown }).articleSummaries = payload;
      (window as unknown as { __wmArticleSummaries?: unknown }).__wmArticleSummaries = payload;
      document.dispatchEvent(new CustomEvent('wm:article-summaries-updated', { detail: payload }));
    },
    'ai:classifications': (payload: unknown) => {
      if (!payload) { console.warn('[wm:ai:classifications] null/undefined payload'); return; }
      (ctx as unknown as { classifications?: unknown }).classifications = payload;
      (window as unknown as { __wmRelayClassifications?: unknown }).__wmRelayClassifications = payload;
      document.dispatchEvent(new CustomEvent('wm:classifications-updated', { detail: payload }));
    },
    'ai:country-briefs': (payload: unknown) => {
      if (!payload) { console.warn('[wm:ai:country-briefs] null/undefined payload'); return; }
      (ctx as unknown as { countryBriefs?: unknown }).countryBriefs = payload;
    },
    'ai:posture-analysis': (payload: unknown) => {
      if (!payload) { console.warn('[wm:ai:posture-analysis] null/undefined payload'); return; }
      aiPayloadBuffer.set('ai:posture-analysis', payload);
      const posturePanel = ctx.panels['strategic-posture'] as { applyAiAnalysis?: (p: unknown) => void } | undefined;
      if (!posturePanel?.applyAiAnalysis) {
        console.debug('[wm:ai:posture-analysis] panel not yet mounted — payload buffered');
        return;
      }
      posturePanel.applyAiAnalysis(payload);
    },
    'ai:instability-analysis': (payload: unknown) => {
      if (!payload) { console.warn('[wm:ai:instability-analysis] null/undefined payload'); return; }
      aiPayloadBuffer.set('ai:instability-analysis', payload);
      const riskPanel = ctx.panels['strategic-risk'] as { applyInstabilityAnalysis?: (p: unknown) => void } | undefined;
      if (!riskPanel?.applyInstabilityAnalysis) {
        console.debug('[wm:ai:instability-analysis] panel not yet mounted — payload buffered');
        return;
      }
      riskPanel.applyInstabilityAnalysis(payload);
    },
    'ai:risk-overview': (payload: unknown) => {
      if (!payload) { console.warn('[wm:ai:risk-overview] null/undefined payload'); return; }
      aiPayloadBuffer.set('ai:risk-overview', payload);
      const riskPanel = ctx.panels['strategic-risk'] as { applyAiOverview?: (p: unknown) => void } | undefined;
      if (!riskPanel?.applyAiOverview) {
        console.debug('[wm:ai:risk-overview] panel not yet mounted — payload buffered');
        return;
      }
      riskPanel.applyAiOverview(payload);
    },
  };
}
