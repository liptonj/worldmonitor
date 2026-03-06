/**
 * @deprecated Migrated to relay-native AI (2026-03-06).
 * AI functions now run on the relay server via Ollama cron jobs.
 * This endpoint is no longer called. Kept for rollback reference.
 */

import type { ServerContext } from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import { getActiveLlmProvider, getLlmPrompt, buildPrompt } from '../../../_shared/llm';
import { getRedisClient } from '../../../_shared/redis';
import { CHROME_UA } from '../../../_shared/constants';

const DIGEST_CACHE_TTL = 14400; // 4 hours
const DIGEST_TIMEOUT_MS = 120_000;

interface GetGlobalIntelDigestRequest {
  forceRefresh?: boolean;
}

interface GetGlobalIntelDigestResponse {
  digest: string;
  model: string;
  provider: string;
  generatedAt: string;
}

export async function getGlobalIntelDigest(
  _ctx: ServerContext,
  req: GetGlobalIntelDigestRequest,
): Promise<GetGlobalIntelDigestResponse> {
  const empty: GetGlobalIntelDigestResponse = {
    digest: '',
    model: '',
    provider: 'skipped',
    generatedAt: new Date().toISOString(),
  };

  const provider = await getActiveLlmProvider();
  if (!provider) return empty;
  const { apiKey, apiUrl, model, extraHeaders } = provider;

  const cacheKey = 'digest:global:v1';

  if (!req.forceRefresh) {
    const redis = getRedisClient();
    if (redis) {
      try {
        const cached = await redis.get<string>(cacheKey);
        if (cached) {
          const parsed = JSON.parse(cached) as GetGlobalIntelDigestResponse;
          return parsed;
        }
      } catch { /* non-fatal */ }
    }
  }

  // Assemble context
  const redis = getRedisClient();
  const headlineScopes = ['global', 'conflict', 'disaster', 'telegram'];
  const allHeadlines: Array<{ title: string; pubDate: number }> = [];

  if (redis) {
    for (const scope of headlineScopes) {
      try {
        const items = await redis.lrange(`wm:headlines:${scope}`, 0, 9);
        for (const item of items) {
          try {
            const parsed = JSON.parse(item) as { title?: string; pubDate?: number };
            if (parsed.title) {
              allHeadlines.push({ title: parsed.title, pubDate: parsed.pubDate ?? 0 });
            }
          } catch { /* skip malformed */ }
        }
      } catch { /* non-fatal */ }
    }
  }

  // Deduplicate and take top 30
  const seen = new Set<string>();
  const headlines = allHeadlines
    .filter(h => { if (seen.has(h.title)) return false; seen.add(h.title); return true; })
    .sort((a, b) => b.pubDate - a.pubDate)
    .slice(0, 30);

  // Build classification summary (simplified - just count available)
  const classificationSummary = `${headlines.length} recent events across monitored scopes`;

  // Country signals (simplified)
  const countrySignals = 'Monitoring active in all TIER1 regions';

  const dateStr = new Date().toISOString().slice(0, 10);
  const recentHeadlinesText = headlines.length > 0
    ? headlines.map((h, i) => `${i + 1}. ${h.title}`).join('\n')
    : 'No recent headlines available';

  try {
    const dbPrompt = await getLlmPrompt('intel_digest', null, null, model);
    if (!dbPrompt) return { ...empty, provider: 'error' };

    const systemPrompt = buildPrompt(dbPrompt.systemPrompt, { date: dateStr });
    const userPrompt = buildPrompt(dbPrompt.userPrompt ?? '', {
      date: dateStr,
      recentHeadlines: recentHeadlinesText,
      classificationSummary,
      countrySignals,
    });

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
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.4,
        max_tokens: 2000,
      }),
      signal: AbortSignal.timeout(DIGEST_TIMEOUT_MS),
    });

    if (!resp.ok) return { ...empty, provider: 'error' };

    const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const firstChoice = data.choices?.[0];
    const content = firstChoice?.message?.content?.trim();
    const reasoning = (firstChoice?.message as Record<string, unknown>)?.['reasoning'] as string | undefined;

    let raw = content || reasoning?.trim() || '';
    raw = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

    if (!raw) return { ...empty, provider: 'error' };

    const result: GetGlobalIntelDigestResponse = {
      digest: raw,
      model,
      provider: provider.name,
      generatedAt: new Date().toISOString(),
    };

    // Cache the result
    if (redis) {
      try {
        await redis.setex(cacheKey, DIGEST_CACHE_TTL, JSON.stringify(result));
      } catch { /* non-fatal */ }
    }

    return result;
  } catch (err) {
    console.error('[GlobalIntelDigest] Error:', err);
    return { ...empty, provider: 'error' };
  }
}
