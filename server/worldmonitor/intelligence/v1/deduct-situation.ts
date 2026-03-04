import type {
    ServerContext,
    DeductSituationRequest,
    DeductSituationResponse,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { getActiveLlmProvider, getLlmPrompt, buildPrompt } from '../../../_shared/llm';
import { cachedFetchJson } from '../../../_shared/redis';
import { hashString } from './_shared';
import { CHROME_UA } from '../../../_shared/constants';

const DEDUCT_TIMEOUT_MS = 120_000;
const DEDUCT_CACHE_TTL = 3600;

export async function deductSituation(
    _ctx: ServerContext,
    req: DeductSituationRequest,
): Promise<DeductSituationResponse> {
    const provider = await getActiveLlmProvider();
    if (!provider) {
        return { analysis: '', model: '', provider: 'skipped' };
    }
    const { apiKey, apiUrl, model, extraHeaders } = provider;

    const MAX_QUERY_LEN = 500;
    const MAX_GEO_LEN = 2000;

    const query = typeof req.query === 'string' ? req.query.slice(0, MAX_QUERY_LEN).trim() : '';
    const geoContext = typeof req.geoContext === 'string' ? req.geoContext.slice(0, MAX_GEO_LEN).trim() : '';

    if (!query) return { analysis: '', model: '', provider: 'skipped' };

    const cacheKey = `deduct:situation:v1:${hashString(query.toLowerCase() + '|' + geoContext.toLowerCase())}`;

    const cached = await cachedFetchJson<{ analysis: string; model: string; provider: string }>(
        cacheKey,
        DEDUCT_CACHE_TTL,
        async () => {
            try {
                const dbPrompt = await getLlmPrompt('deduction', null, null, model);
                if (!dbPrompt) return null;

                const dateStr = new Date().toISOString().split('T')[0];
                const systemPrompt = buildPrompt(dbPrompt.systemPrompt, { date: dateStr });
                const userPromptFromDb = buildPrompt(dbPrompt.userPrompt ?? '{query}', {
                    query,
                    geoContext,
                    recentHeadlines: '',
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
                            { role: 'user', content: userPromptFromDb },
                        ],
                        temperature: 0.3,
                        max_tokens: 1500,
                    }),
                    signal: AbortSignal.timeout(DEDUCT_TIMEOUT_MS),
                });

                if (!resp.ok) return null;
                const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
                const firstChoice = data.choices?.[0];

                const content = firstChoice?.message?.content?.trim();
                const reasoning = (firstChoice?.message as any)?.reasoning?.trim();

                let raw = content || reasoning;
                if (!raw) return null;

                raw = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

                return { analysis: raw, model, provider: provider.name };
            } catch (err) {
                console.error('[DeductSituation] Error calling LLM:', err);
                return null;
            }
        }
    );

    if (!cached?.analysis) {
        return { analysis: '', model: '', provider: 'error' };
    }

    return {
        analysis: cached.analysis,
        model: cached.model,
        provider: cached.provider,
    };
}
