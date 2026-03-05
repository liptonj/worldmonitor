// ========================================================================
// Constants
// ========================================================================

export const CACHE_TTL_SECONDS = 86400; // 24 hours

// ========================================================================
// Shared cache-key logic (used by both server handler and client GET lookup)
// ========================================================================

export {
  CACHE_VERSION,
  canonicalizeSummaryInputs,
  buildSummaryCacheKey,
  buildSummaryCacheKey as getCacheKey,
} from '../../../../src/utils/summary-cache-key';

// ========================================================================
// Hash utility (unified FNV-1a 52-bit -- H-7 fix)
// ========================================================================

import { hashString } from '../../../_shared/hash';
export { hashString };

// ========================================================================
// Headline deduplication (used by SummarizeArticle)
// ========================================================================

// @ts-ignore -- plain JS module, no .d.mts needed for this pure function
export { deduplicateHeadlines } from './dedup.mjs';

import { buildPrompt } from '../../../_shared/llm';
import { getSecret } from '../../../_shared/secrets';
import { createAnonClient } from '../../../_shared/supabase';

// ========================================================================
// SummarizeArticle: Full prompt builder (ported from _summarize-handler.js)
// ========================================================================

export function buildArticlePrompts(
  _headlines: string[],
  uniqueHeadlines: string[],
  opts: { mode: string; geoContext: string; variant: string; lang: string },
  dbPrompt: { systemPrompt: string; userPrompt: string },
): { systemPrompt: string; userPrompt: string } {
  const headlineText = uniqueHeadlines.map((h, i) => `${i + 1}. ${h}`).join('\n');
  const intelSection = opts.geoContext ? `\n\n${opts.geoContext}` : '';
  const dateContext = `Current date: ${new Date().toISOString().slice(0, 10)}.`;
  const langInstruction = opts.lang && opts.lang !== 'en'
    ? `\nIMPORTANT: Output the summary in ${opts.lang.toUpperCase()} language.`
    : '';

  return {
    systemPrompt: buildPrompt(dbPrompt.systemPrompt, { dateContext, langInstruction }),
    userPrompt: buildPrompt(dbPrompt.userPrompt ?? '', { headlineText, intelSection }),
  };
}

// ========================================================================
// SummarizeArticle: Provider credential resolution
// ========================================================================

export interface ProviderCredentials {
  apiUrl: string;
  model: string;
  headers: Record<string, string>;
  extraBody?: Record<string, unknown>;
  /** When true, use the native Ollama /api/chat format instead of OpenAI-compat */
  useOllamaNativeApi?: boolean;
}

export async function getProviderCredentials(provider: string): Promise<ProviderCredentials | null> {
  if (provider === 'ollama') {
    let apiUrl: string | undefined;
    let model: string | undefined;
    let cfId: string | undefined;
    let cfSecret: string | undefined;
    let maxTokensSummary = 400;

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

    if (supabaseUrl && supabaseAnonKey) {
      try {
        const supabase = createAnonClient();
        const { data, error } = await supabase.rpc('get_ollama_credentials');
        if (!error && Array.isArray(data) && data.length > 0) {
          const row = data[0] as {
            api_url: string | null;
            model: string | null;
            cf_access_client_id: string | null;
            cf_access_client_secret: string | null;
            max_tokens: number | null;
            max_tokens_summary: number | null;
          };
          apiUrl = row.api_url ?? undefined;
          model = row.model ?? undefined;
          cfId = row.cf_access_client_id ?? undefined;
          cfSecret = row.cf_access_client_secret ?? undefined;
          if (row.max_tokens_summary != null) maxTokensSummary = row.max_tokens_summary;
        }
      } catch { /* fall through to env */ }
    }

    // Env fallback for local dev / missing Supabase config
    apiUrl ??= process.env.OLLAMA_API_URL;
    model ??= process.env.OLLAMA_MODEL;
    cfId ??= process.env.OLLAMA_CF_ACCESS_CLIENT_ID;
    cfSecret ??= process.env.OLLAMA_CF_ACCESS_CLIENT_SECRET;

    if (!apiUrl) return null;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const apiKey = await getSecret('OLLAMA_API_KEY');
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    if (cfId) headers['CF-Access-Client-Id'] = cfId;
    if (cfSecret) headers['CF-Access-Client-Secret'] = cfSecret;

    // qwen3 thinking models: use the native Ollama /api/chat endpoint which supports
    // think:false directly. The OpenAI-compat /v1/chat/completions ignores think:false
    // and routes all output to message.reasoning instead of message.content, causing timeouts.
    const resolvedModel = model || 'qwen3:8b';
    const isQwen3 = resolvedModel.startsWith('qwen3');
    if (isQwen3) {
      return {
        apiUrl: new URL('/api/chat', apiUrl).toString(),
        model: resolvedModel,
        headers,
        extraBody: {
          options: { num_predict: maxTokensSummary },
          think: false,
          stream: false,
        },
        useOllamaNativeApi: true,
      };
    }
    return {
      apiUrl: new URL('/v1/chat/completions', apiUrl).toString(),
      model: resolvedModel,
      headers,
      extraBody: {
        max_tokens: maxTokensSummary,
      },
    };
  }

  if (provider === 'groq') {
    const apiKey = await getSecret('GROQ_API_KEY');
    if (!apiKey) return null;
    return {
      apiUrl: 'https://api.groq.com/openai/v1/chat/completions',
      model: 'llama-3.1-8b-instant',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      extraBody: { max_tokens: 1500 },
    };
  }

  if (provider === 'openrouter') {
    const apiKey = await getSecret('OPENROUTER_API_KEY');
    if (!apiKey) return null;
    return {
      apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
      model: 'openrouter/free',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://worldmonitor.app',
        'X-Title': 'WorldMonitor',
      },
    };
  }

  return null;
}
