/**
 * Article Summarization — Relay Cache Only
 *
 * Summaries are pre-computed server-side by the AI engine and pushed
 * via the ai:article-summaries WebSocket channel. This module looks
 * them up from window.__wmArticleSummaries.
 *
 * translateText() still uses the SummarizeArticle RPC for on-demand
 * translation (different use case from pre-computed summaries).
 */

import { isFeatureAvailable, type RuntimeFeatureId } from './runtime-config';
import { trackLLMUsage } from './analytics';
import { NewsServiceClient, type SummarizeArticleResponse } from '@/generated/client/worldmonitor/news/v1/service_client';
import { createCircuitBreaker } from '@/utils';

export type SummarizationProvider = 'ollama' | 'groq' | 'openrouter' | 'browser' | 'cache' | 'pending';

export interface SummarizationResult {
  summary: string;
  provider: SummarizationProvider;
  model: string;
  cached: boolean;
}

export type ProgressCallback = (step: number, total: number, message: string) => void;

export interface SummarizeOptions {
  skipCloudProviders?: boolean;
  skipBrowserFallback?: boolean;
}

function fnv1aHash(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

function lookupRelaySummary(headlines: string[]): SummarizationResult | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cache = (window as any).__wmArticleSummaries as Record<string, { text?: string }> | undefined;
  if (!cache) return null;
  for (const title of headlines) {
    const entry = cache[fnv1aHash(title.toLowerCase())];
    if (entry?.text) return { summary: entry.text, provider: 'cache', model: 'relay', cached: true };
  }
  return null;
}

const PENDING_RESULT: SummarizationResult = {
  summary: '',
  provider: 'pending',
  model: 'relay',
  cached: false,
};

/**
 * Look up a pre-computed summary from the relay cache.
 * Returns a "pending" result (empty summary) if not yet available.
 * Panels should listen for 'wm:article-summaries-updated' to re-check.
 */
export function generateSummary(
  headlines: string[],
  _onProgress?: ProgressCallback,
  _geoContext?: string,
  _lang?: string,
  _options?: SummarizeOptions,
): SummarizationResult | null {
  if (!headlines || headlines.length < 2) return null;

  const relayResult = lookupRelaySummary(headlines);
  if (relayResult) {
    trackLLMUsage(relayResult.provider, relayResult.model, true);
    return relayResult;
  }

  return PENDING_RESULT;
}

// ── Translation (still uses API — on-demand, cannot be pre-computed) ──

interface ApiProviderDef {
  featureId: RuntimeFeatureId;
  provider: SummarizationProvider;
  label: string;
}

const TRANSLATION_PROVIDERS: ApiProviderDef[] = [
  { featureId: 'aiOllama',      provider: 'ollama',     label: 'Ollama' },
  { featureId: 'aiGroq',        provider: 'groq',       label: 'Groq AI' },
  { featureId: 'aiOpenRouter',  provider: 'openrouter', label: 'OpenRouter' },
];

const newsClient = new NewsServiceClient('', { fetch: (...args) => globalThis.fetch(...args) });
const translationBreaker = createCircuitBreaker<SummarizeArticleResponse>({ name: 'Translation', cacheTtlMs: 0 });
const emptyTranslationFallback: SummarizeArticleResponse = { summary: '', provider: '', model: '', cached: false, skipped: false, fallback: true, tokens: 0, reason: '', error: '', errorType: '' };

export async function translateText(
  text: string,
  targetLang: string,
  onProgress?: ProgressCallback,
): Promise<string | null> {
  if (!text) return null;

  const totalSteps = TRANSLATION_PROVIDERS.length;
  for (const [i, providerDef] of TRANSLATION_PROVIDERS.entries()) {
    if (!isFeatureAvailable(providerDef.featureId)) continue;

    onProgress?.(i + 1, totalSteps, `Translating with ${providerDef.label}...`);
    try {
      const resp = await translationBreaker.execute(async () => {
        return newsClient.summarizeArticle({
          provider: providerDef.provider,
          headlines: [text],
          mode: 'translate',
          geoContext: '',
          variant: targetLang,
          lang: '',
        });
      }, emptyTranslationFallback);

      if (resp.fallback || resp.skipped) continue;
      const summary = typeof resp.summary === 'string' ? resp.summary.trim() : '';
      if (summary) return summary;
    } catch (e) {
      console.warn(`${providerDef.label} translation failed`, e);
    }
  }

  return null;
}
