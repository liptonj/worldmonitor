/**
 * @deprecated Migrated to relay-native AI (2026-03-06).
 * AI functions now run on the relay server via Ollama cron jobs.
 * This endpoint is no longer called. Kept for rollback reference.
 */

import type {
  ServerContext,
  ClassifyEventRequest,
  ClassifyEventResponse,
  SeverityLevel,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { getActiveLlmProvider, getLlmPrompt, buildPrompt } from '../../../_shared/llm';
import { cachedFetchJson } from '../../../_shared/redis';
import { markNoCacheResponse } from '../../../_shared/response-headers';
import { UPSTREAM_TIMEOUT_MS, hashString } from './_shared';
import { CHROME_UA } from '../../../_shared/constants';

// ========================================================================
// Constants
// ========================================================================

const CLASSIFY_CACHE_TTL = 86400;
const VALID_LEVELS = ['critical', 'high', 'medium', 'low', 'info'];
const VALID_CATEGORIES = [
  'conflict', 'protest', 'disaster', 'diplomatic', 'economic',
  'terrorism', 'cyber', 'health', 'environmental', 'military',
  'crime', 'infrastructure', 'tech', 'general',
];

// ========================================================================
// Helpers
// ========================================================================

function mapLevelToSeverity(level: string): SeverityLevel {
  if (level === 'critical' || level === 'high') return 'SEVERITY_LEVEL_HIGH';
  if (level === 'medium') return 'SEVERITY_LEVEL_MEDIUM';
  return 'SEVERITY_LEVEL_LOW';
}

// ========================================================================
// RPC handler
// ========================================================================

export async function classifyEvent(
  ctx: ServerContext,
  req: ClassifyEventRequest,
): Promise<ClassifyEventResponse> {
  const provider = await getActiveLlmProvider();
  if (!provider) { markNoCacheResponse(ctx.request); return { classification: undefined }; }
  const { apiKey, apiUrl, model, extraHeaders } = provider;

  // Input sanitization (M-14 fix): limit title length
  const MAX_TITLE_LEN = 500;
  const title = typeof req.title === 'string' ? req.title.slice(0, MAX_TITLE_LEN) : '';
  if (!title) { markNoCacheResponse(ctx.request); return { classification: undefined }; }

  const cacheKey = `classify:sebuf:v1:${hashString(title.toLowerCase())}`;

  let cached: { level: string; category: string; timestamp: number } | null = null;
  try {
    cached = await cachedFetchJson<{ level: string; category: string; timestamp: number }>(
      cacheKey,
      CLASSIFY_CACHE_TTL,
      async () => {
        try {
          const dbPrompt = await getLlmPrompt('classify_event', null, null, model);
          if (!dbPrompt) return null;
          const systemPrompt = buildPrompt(dbPrompt.systemPrompt, {});
          const userPromptText = buildPrompt(dbPrompt.userPrompt ?? '{title}', { title });

          const resp = await fetch(apiUrl, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
              'User-Agent': CHROME_UA,
              ...extraHeaders,
            },
            body: JSON.stringify({
              model,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPromptText },
              ],
              temperature: 0,
              max_tokens: 50,
            }),
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
          });

          if (!resp.ok) return null;
          const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
          const raw = data.choices?.[0]?.message?.content?.trim();
          if (!raw) return null;

          let parsed: { level?: string; category?: string };
          try {
            parsed = JSON.parse(raw);
          } catch {
            return null;
          }

          const level = VALID_LEVELS.includes(parsed.level ?? '') ? parsed.level! : null;
          const category = VALID_CATEGORIES.includes(parsed.category ?? '') ? parsed.category! : null;
          if (!level || !category) return null;

          return { level, category, timestamp: Date.now() };
        } catch {
          return null;
        }
      },
    );
  } catch {
    markNoCacheResponse(ctx.request);
    return { classification: undefined };
  }

  if (!cached?.level || !cached?.category) { markNoCacheResponse(ctx.request); return { classification: undefined }; }

  return {
    classification: {
      category: cached.category,
      subcategory: cached.level,
      severity: mapLevelToSeverity(cached.level),
      confidence: 0.9,
      analysis: '',
      entities: [],
    },
  };
}
