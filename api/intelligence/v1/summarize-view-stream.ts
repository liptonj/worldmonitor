export const config = { runtime: 'edge' };

import { getActiveLlmProvider, getLlmPrompt, buildPrompt } from '../../../server/_shared/llm';
import { CHROME_UA } from '../../../server/_shared/constants';
import { getCorsHeaders, isDisallowedOrigin } from '../../../server/cors';
// @ts-expect-error — JS module, no declaration file
import { validateApiKey } from '../../_api-key.js';

const MIN_PANEL_LENGTH = 20;
const MAX_PANEL_LENGTH = 80_000;

function jsonResponse(body: Record<string, unknown>, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

export default async function handler(req: Request): Promise<Response> {
  if (isDisallowedOrigin(req)) {
    return new Response('Origin not allowed', { status: 403 });
  }

  const cors = getCorsHeaders(req, 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  const keyCheck = await validateApiKey(req);
  if (keyCheck.required && !keyCheck.valid) {
    return jsonResponse({ error: keyCheck.error }, 401, cors);
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, cors);
  }

  let body: { panelSnapshots?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400, cors);
  }

  const snapshots = (body.panelSnapshots ?? '').trim();
  if (snapshots.length < MIN_PANEL_LENGTH) {
    return jsonResponse({ event: 'done', summary: '', model: '', provider: 'skipped' }, 200, cors);
  }
  if (snapshots.length > MAX_PANEL_LENGTH) {
    return jsonResponse({ event: 'error', errorCode: 'upstream_http_error' }, 200, cors);
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const sse = (data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      sse({ event: 'status', text: 'Resolving AI provider…' });

      const provider = await getActiveLlmProvider();
      if (!provider) {
        sse({ event: 'error', errorCode: 'provider_missing' });
        controller.close();
        return;
      }

      sse({ event: 'status', text: 'Loading prompt template…' });

      const now = new Date().toISOString();
      const dateStr = now.slice(0, 10);
      const dbPrompt = await getLlmPrompt('view_summary', null, null, provider.model);
      if (!dbPrompt) {
        sse({ event: 'error', errorCode: 'prompt_missing' });
        controller.close();
        return;
      }

      const systemPrompt = buildPrompt(dbPrompt.systemPrompt, { date: dateStr });
      const userPrompt = buildPrompt(dbPrompt.userPrompt ?? '', { date: dateStr, panelData: snapshots });

      sse({ event: 'status', text: 'Connecting to AI model…' });
      sse({ event: 'meta', model: provider.model, provider: provider.name });

      let upstreamResp: Response;
      try {
        upstreamResp = await fetch(provider.apiUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${provider.apiKey}`,
            'Content-Type': 'application/json',
            'User-Agent': CHROME_UA,
            ...provider.extraHeaders,
          },
          body: JSON.stringify({
            model: provider.model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            temperature: 0.4,
            max_tokens: 1500,
            stream: true,
          }),
        });
      } catch (err) {
        console.error('[SummarizeViewStream] fetch failed:', err);
        sse({ event: 'error', errorCode: 'upstream_http_error' });
        controller.close();
        return;
      }

      if (!upstreamResp.ok) {
        console.error('[SummarizeViewStream] upstream HTTP %d', upstreamResp.status);
        sse({ event: 'error', errorCode: 'upstream_http_error' });
        controller.close();
        return;
      }

      if (!upstreamResp.body) {
        sse({ event: 'error', errorCode: 'upstream_http_error' });
        controller.close();
        return;
      }

      sse({ event: 'status', text: 'Generating summary…' });

      const decoder = new TextDecoder();
      const reader = upstreamResp.body.getReader();
      let buffer = '';
      let fullContent = '';
      let inThinkBlock = false;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const payload = line.slice(6).trim();
            if (payload === '[DONE]') continue;

            try {
              const chunk = JSON.parse(payload) as {
                choices?: Array<{ delta?: { content?: string; reasoning?: string } }>;
              };
              const delta = chunk.choices?.[0]?.delta;
              let text = delta?.content ?? delta?.reasoning ?? '';

              if (text.includes('<think>')) inThinkBlock = true;
              if (inThinkBlock) {
                const endIdx = text.indexOf('</think>');
                if (endIdx >= 0) {
                  text = text.slice(endIdx + 8);
                  inThinkBlock = false;
                } else {
                  text = '';
                }
              }

              if (text) {
                fullContent += text;
                sse({ event: 'chunk', text });
              }
            } catch { /* skip malformed SSE lines */ }
          }
        }
      } catch (err) {
        console.error('[SummarizeViewStream] stream read error:', err);
        sse({ event: 'error', errorCode: 'upstream_http_error' });
      }

      const cleaned = fullContent.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*/gi, '').trim();
      sse({
        event: 'done',
        summary: cleaned,
        model: provider.model,
        provider: provider.name,
        generatedAt: new Date().toISOString(),
      });
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive',
      ...cors,
    },
  });
}
