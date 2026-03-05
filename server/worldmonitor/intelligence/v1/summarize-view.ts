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
  errorCode?: 'provider_missing' | 'prompt_missing' | 'upstream_http_error' | 'empty_model_output' | 'timeout';
}

export async function summarizeView(
  _ctx: ServerContext,
  req: SummarizeViewRequest,
): Promise<SummarizeViewResponse> {
  const now = new Date().toISOString();
  const empty = (errorCode?: SummarizeViewResponse['errorCode']): SummarizeViewResponse => ({
    summary: '',
    model: '',
    provider: errorCode ? 'error' : 'skipped',
    generatedAt: now,
    errorCode,
  });

  const snapshots = (req.panelSnapshots ?? '').trim();
  if (snapshots.length < MIN_PANEL_LENGTH) return empty();
  if (snapshots.length > MAX_PANEL_LENGTH) {
    console.warn('[SummarizeView] panelSnapshots too large (%d bytes), rejecting', snapshots.length);
    return empty('upstream_http_error');
  }

  const provider = await getActiveLlmProvider();
  if (!provider) {
    console.error('[SummarizeView] provider_missing — get_active_llm_provider returned null');
    return empty('provider_missing');
  }

  const { apiKey, apiUrl, model, extraHeaders } = provider;
  const dateStr = now.slice(0, 10);

  try {
    const dbPrompt = await getLlmPrompt('view_summary', null, null, model);
    if (!dbPrompt) {
      console.error('[SummarizeView] prompt_missing — get_llm_prompt("view_summary") returned null for model=%s', model);
      return empty('prompt_missing');
    }

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

    if (!resp.ok) {
      console.error('[SummarizeView] upstream_http_error — LLM returned HTTP %d (provider=%s model=%s)', resp.status, provider.name, model);
      return empty('upstream_http_error');
    }

    const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const firstChoice = data.choices?.[0];
    const content = firstChoice?.message?.content?.trim();
    const reasoning = (firstChoice?.message as Record<string, unknown>)?.['reasoning'] as string | undefined;

    let raw = content || reasoning?.trim() || '';
    raw = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*/gi, '').trim();

    if (!raw) {
      console.error('[SummarizeView] empty_model_output — LLM response had no usable content (provider=%s model=%s)', provider.name, model);
      return empty('empty_model_output');
    }

    return {
      summary: raw,
      model,
      provider: provider.name,
      generatedAt: new Date().toISOString(),
    };
  } catch (err) {
    // AbortSignal.timeout() throws AbortError in Chromium/Node, TimeoutError in Firefox
    const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    if (isTimeout) {
      console.error('[SummarizeView] timeout — LLM request exceeded %dms (provider=%s model=%s)', SUMMARIZE_VIEW_TIMEOUT_MS, provider.name, model);
      return empty('timeout');
    }
    console.error('[SummarizeView] error — %s (provider=%s model=%s)', (err instanceof Error ? err.message : String(err)), provider.name, model);
    return empty('upstream_http_error');
  }
}
