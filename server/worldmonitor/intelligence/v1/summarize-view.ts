import type { ServerContext } from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import { getActiveLlmProvider, getLlmPrompt, buildPrompt } from '../../../_shared/llm';
import { CHROME_UA } from '../../../_shared/constants';

const SUMMARIZE_VIEW_TIMEOUT_MS = 90_000;
const MIN_PANEL_LENGTH = 20;
const MAX_PANEL_LENGTH = 80_000;

interface SummarizeViewRequest {
  panelSnapshots?: string;
}

interface SummarizeViewResponse {
  summary: string;
  model: string;
  provider: string;
  generatedAt: string;
}

export async function summarizeView(
  _ctx: ServerContext,
  req: SummarizeViewRequest,
): Promise<SummarizeViewResponse> {
  const empty: SummarizeViewResponse = {
    summary: '',
    model: '',
    provider: 'skipped',
    generatedAt: new Date().toISOString(),
  };

  const snapshots = (req.panelSnapshots ?? '').trim();
  if (snapshots.length < MIN_PANEL_LENGTH) return empty;
  if (snapshots.length > MAX_PANEL_LENGTH) {
    console.warn('[SummarizeView] panelSnapshots too large, rejecting');
    return { ...empty, provider: 'error' };
  }

  const provider = await getActiveLlmProvider();
  if (!provider) return empty;
  const { apiKey, apiUrl, model, extraHeaders } = provider;

  const dateStr = new Date().toISOString().split('T')[0];

  try {
    const dbPrompt = await getLlmPrompt('view_summary', null, null, model);
    if (!dbPrompt) return { ...empty, provider: 'error' };

    const systemPrompt = buildPrompt(dbPrompt.systemPrompt, { date: dateStr });
    const userPrompt = buildPrompt(dbPrompt.userPrompt ?? '', {
      date: dateStr,
      panelData: snapshots,
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
        max_tokens: 1500,
      }),
      signal: AbortSignal.timeout(SUMMARIZE_VIEW_TIMEOUT_MS),
    });

    if (!resp.ok) return { ...empty, provider: 'error' };

    const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const firstChoice = data.choices?.[0];
    const content = firstChoice?.message?.content?.trim();
    const reasoning = (firstChoice?.message as Record<string, unknown>)?.['reasoning'] as string | undefined;

    let raw = content || reasoning?.trim() || '';
    // Strip both closed <think>...</think> and unclosed <think>... (from reasoning models)
    raw = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*/gi, '').trim();

    if (!raw) return { ...empty, provider: 'error' };

    return {
      summary: raw,
      model,
      provider: provider.name,
      generatedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.error('[SummarizeView] Error:', err);
    return { ...empty, provider: 'error' };
  }
}
