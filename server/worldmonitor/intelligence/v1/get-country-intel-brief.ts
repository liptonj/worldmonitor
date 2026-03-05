import type {
  ServerContext,
  GetCountryIntelBriefRequest,
  GetCountryIntelBriefResponse,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { getActiveLlmProvider, getLlmPrompt, buildPrompt } from '../../../_shared/llm';
import { cachedFetchJson } from '../../../_shared/redis';
import { UPSTREAM_TIMEOUT_MS, TIER1_COUNTRIES, hashString, fetchRecentHeadlines } from './_shared';
import { CHROME_UA } from '../../../_shared/constants';

// ========================================================================
// Constants
// ========================================================================

const INTEL_CACHE_TTL = 7200;

// ========================================================================
// RPC handler
// ========================================================================

export async function getCountryIntelBrief(
  ctx: ServerContext,
  req: GetCountryIntelBriefRequest,
): Promise<GetCountryIntelBriefResponse> {
  const empty: GetCountryIntelBriefResponse = {
    countryCode: req.countryCode,
    countryName: '',
    brief: '',
    model: '',
    generatedAt: Date.now(),
  };

  if (!req.countryCode) return empty;

  const provider = await getActiveLlmProvider();
  if (!provider) return empty;
  const { apiKey, apiUrl, model, extraHeaders } = provider;

  let contextSnapshot = '';
  try {
    const url = new URL(ctx.request.url);
    contextSnapshot = (url.searchParams.get('context') || '').trim().slice(0, 4000);
  } catch {
    contextSnapshot = '';
  }

  const contextHash = contextSnapshot ? hashString(contextSnapshot) : 'base';
  const cacheKey = `ci-sebuf:v2:${req.countryCode}:${contextHash}`;
  const countryName = TIER1_COUNTRIES[req.countryCode] || req.countryCode;

  let result: GetCountryIntelBriefResponse | null = null;
  try {
    result = await cachedFetchJson<GetCountryIntelBriefResponse>(cacheKey, INTEL_CACHE_TTL, async () => {
      try {
        const dateStr = new Date().toISOString().slice(0, 10);
        const dbPrompt = await getLlmPrompt('intel_brief', null, null, model);
        if (!dbPrompt) return null;

        const countryScope = req.countryCode?.toLowerCase() ?? '';
        const headlineScopes = countryScope
          ? [countryScope, 'global', 'conflict']
          : ['global', 'conflict'];
        const recentHeadlinesText = await fetchRecentHeadlines(headlineScopes, 15);

        const systemPrompt = buildPrompt(dbPrompt.systemPrompt, { date: dateStr });
        const userPrompt = buildPrompt(dbPrompt.userPrompt ?? '', {
          countryName,
          countryCode: req.countryCode,
          contextSnapshot,
          recentHeadlines: recentHeadlinesText,
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
            max_tokens: 900,
          }),
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });

        if (!resp.ok) return null;
        const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const brief = (data.choices?.[0]?.message?.content?.trim() || '')
          .replace(/<think>[\s\S]*?<\/think>/gi, '')
          .trim();
        if (!brief) return null;

        return {
          countryCode: req.countryCode,
          countryName,
          brief,
          model,
          generatedAt: Date.now(),
        };
      } catch {
        return null;
      }
    });
  } catch {
    return empty;
  }

  return result || empty;
}
