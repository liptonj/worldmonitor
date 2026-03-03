type LlmProvider = {
  id: string;
  name: string;
  api_url: string;
  default_model: string;
  priority: number;
  enabled: boolean;
};

type LlmPrompt = {
  id: string;
  prompt_key: string;
  variant: string | null;
  mode: string | null;
  system_prompt: string;
  user_prompt: string | null;
  description: string | null;
};

export function renderLlmConfigPage(container: HTMLElement, token: string): void {
  container.innerHTML = `
    <h2 style="margin-bottom:24px">LLM Config & Prompts</h2>
    <div id="llm-providers" style="margin-bottom:32px">Loading providers…</div>
    <h3 style="margin-bottom:16px">Prompts</h3>
    <div id="llm-prompt-tabs" style="display:flex;gap:8px;margin-bottom:16px"></div>
    <div id="llm-prompts">Loading prompts…</div>
  `;

  async function loadProviders(): Promise<void> {
    const el = container.querySelector<HTMLElement>('#llm-providers')!;
    const res = await fetch('/api/admin/llm-providers', { headers: { Authorization: `Bearer ${token}` } });
    const json = (await res.json()) as { providers?: LlmProvider[] };
    if (!json.providers?.length) {
      el.innerHTML = '<p style="color:var(--text-muted)">No providers.</p>';
      return;
    }
    el.innerHTML = `<h3 style="margin-bottom:12px">Providers</h3>
      <table style="width:100%;border-collapse:collapse">
        <thead><tr style="color:var(--text-muted);font-size:12px;border-bottom:1px solid var(--border)">
          <th style="text-align:left;padding:8px 4px">Name</th>
          <th style="text-align:left;padding:8px 4px">API URL</th>
          <th style="text-align:left;padding:8px 4px">Model</th>
          <th style="text-align:center;padding:8px 4px">Priority</th>
          <th style="text-align:center;padding:8px 4px">Enabled</th>
          <th></th>
        </tr></thead>
        <tbody>${json.providers
          .map(
            p => `<tr style="border-bottom:1px solid var(--border)" data-provider-id="${p.id}">
          <td style="padding:8px 4px;font-weight:600">${p.name}</td>
          <td style="padding:8px 4px"><input type="text" data-field="api_url" value="${p.api_url}" style="width:260px;padding:4px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-size:12px"/></td>
          <td style="padding:8px 4px"><input type="text" data-field="default_model" value="${p.default_model}" style="width:180px;padding:4px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-size:12px"/></td>
          <td style="padding:8px 4px;text-align:center"><input type="number" data-field="priority" value="${p.priority}" style="width:60px;padding:4px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);text-align:center"/></td>
          <td style="padding:8px 4px;text-align:center"><input type="checkbox" data-field="enabled" ${p.enabled ? 'checked' : ''} style="cursor:pointer"/></td>
          <td style="padding:8px 4px"><button data-save-provider="${p.id}" style="padding:4px 10px;background:var(--accent);color:#fff;border:none;border-radius:var(--radius);cursor:pointer;font-size:12px">Save</button></td>
        </tr>`
          )
          .join('')}</tbody>
      </table>`;

    el.querySelectorAll('button[data-save-provider]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = (btn as HTMLElement).dataset['saveProvider']!;
        const row = el.querySelector<HTMLElement>(`tr[data-provider-id="${id}"]`)!;
        const body: Record<string, unknown> = {};
        row.querySelectorAll('input[data-field]').forEach(inp => {
          const input = inp as HTMLInputElement;
          const field = input.dataset['field']!;
          body[field] =
            input.type === 'checkbox'
              ? input.checked
              : input.type === 'number'
                ? Number(input.value)
                : input.value;
        });
        await fetch(`/api/admin/llm-providers?id=${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        });
      });
    });
  }

  async function loadPrompts(): Promise<void> {
    const tabs = container.querySelector<HTMLElement>('#llm-prompt-tabs')!;
    const promptsEl = container.querySelector<HTMLElement>('#llm-prompts')!;
    const res = await fetch('/api/admin/llm-prompts', { headers: { Authorization: `Bearer ${token}` } });
    const json = (await res.json()) as { prompts?: LlmPrompt[] };
    if (!json.prompts?.length) {
      promptsEl.innerHTML = '<p style="color:var(--text-muted)">No prompts.</p>';
      return;
    }

    const prompts = json.prompts;
    const keys = [...new Set(prompts.map(p => p.prompt_key))];
    let activeKey = keys[0]!;

    function renderTabs(): void {
      tabs.innerHTML = keys
        .map(
          k =>
            `<button data-key="${k}" style="padding:6px 16px;background:${k === activeKey ? 'var(--accent)' : 'var(--surface)'};color:${k === activeKey ? '#fff' : 'var(--text-muted)'};border:1px solid var(--border);border-radius:var(--radius);cursor:pointer">${k}</button>`
        )
        .join('');
      tabs.querySelectorAll('button[data-key]').forEach(btn => {
        btn.addEventListener('click', () => {
          activeKey = (btn as HTMLElement).dataset['key']!;
          renderTabs();
          renderPrompts();
        });
      });
    }

    function renderPrompts(): void {
      const rows = prompts.filter(p => p.prompt_key === activeKey);
      promptsEl.innerHTML = rows
        .map(
          p => `
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px;margin-bottom:16px" data-prompt-id="${p.id}">
          <div style="display:flex;gap:16px;margin-bottom:12px">
            <span style="color:var(--text-muted);font-size:12px">Variant: <strong style="color:var(--text)">${p.variant ?? '(any)'}</strong></span>
            <span style="color:var(--text-muted);font-size:12px">Mode: <strong style="color:var(--text)">${p.mode ?? '(any)'}</strong></span>
          </div>
          ${p.description ? `<p style="color:var(--text-muted);font-size:12px;margin-bottom:8px">${p.description}</p>` : ''}
          <p style="color:var(--text-muted);font-size:11px;margin-bottom:4px">Placeholders: {date}, {dateContext}, {headlineText}, {intelSection}, {langInstruction}</p>
          <label style="color:var(--text-muted);font-size:12px">System Prompt</label>
          <textarea data-field="system_prompt" rows="6" style="width:100%;padding:8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-family:monospace;font-size:12px;resize:vertical;margin:4px 0 12px">${p.system_prompt}</textarea>
          ${p.user_prompt !== null ? `
          <label style="color:var(--text-muted);font-size:12px">User Prompt</label>
          <textarea data-field="user_prompt" rows="4" style="width:100%;padding:8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-family:monospace;font-size:12px;resize:vertical;margin:4px 0 12px">${p.user_prompt}</textarea>` : ''}
          <button data-save-prompt="${p.id}" style="padding:6px 16px;background:var(--accent);color:#fff;border:none;border-radius:var(--radius);cursor:pointer">Save</button>
          <span data-prompt-msg="${p.id}" style="margin-left:10px;font-size:12px"></span>
        </div>
      `
        )
        .join('');

      promptsEl.querySelectorAll('button[data-save-prompt]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = (btn as HTMLElement).dataset['savePrompt']!;
          const block = promptsEl.querySelector<HTMLElement>(`[data-prompt-id="${id}"]`)!;
          const body: Record<string, string> = {};
          block.querySelectorAll('textarea[data-field]').forEach(ta => {
            body[(ta as HTMLElement).dataset['field']!] = (ta as HTMLTextAreaElement).value;
          });
          const res = await fetch(`/api/admin/llm-prompts?id=${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify(body),
          });
          const msgEl = promptsEl.querySelector<HTMLElement>(`[data-prompt-msg="${id}"]`)!;
          msgEl.textContent = res.ok ? 'Saved!' : 'Error';
          msgEl.style.color = res.ok ? 'var(--success)' : 'var(--danger)';
        });
      });
    }

    renderTabs();
    renderPrompts();
  }

  loadProviders();
  loadPrompts();
}
