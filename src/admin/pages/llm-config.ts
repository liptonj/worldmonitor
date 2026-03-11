type LlmProvider = {
  id: string;
  name: string;
  api_url: string;
  default_model: string;
  priority: number;
  enabled: boolean;
  api_key_secret_name: string;
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

type LlmFunctionConfig = {
  function_key: string;
  provider_chain: string[];
  timeout_ms: number;
  max_retries: number;
  description: string | null;
};

const PLACEHOLDERS_BY_KEY: Record<string, string[]> = {
  news_summary:   ['{dateContext}', '{langInstruction}', '{headlineText}', '{intelSection}', '{targetLang}'],
  intel_brief:    ['{date}', '{countryName}', '{countryCode}', '{contextSnapshot}', '{recentHeadlines}'],
  deduction:      ['{date}', '{query}', '{geoContext}', '{recentHeadlines}'],
  classify_event: ['{title}'],
  intel_digest:   ['{date}', '{recentHeadlines}', '{classificationSummary}', '{countrySignals}'],
};

const ALL_PLACEHOLDERS = [...new Set(Object.values(PLACEHOLDERS_BY_KEY).flat())];

function getPlaceholders(key: string): string[] {
  return PLACEHOLDERS_BY_KEY[key] ?? ALL_PLACEHOLDERS;
}

function badge(text: string, color = 'var(--text-muted)'): string {
  return `<span style="display:inline-block;padding:2px 8px;border-radius:12px;background:var(--surface);border:1px solid var(--border);color:${color};font-size:11px;font-weight:600">${text}</span>`;
}

function fieldRow(label: string, input: string): string {
  return `<div style="display:grid;grid-template-columns:160px 1fr;align-items:start;gap:8px;margin-bottom:12px">
    <label style="color:var(--text-muted);font-size:12px;padding-top:6px">${label}</label>
    <div>${input}</div>
  </div>`;
}

function textInput(name: string, value: string, placeholder = ''): string {
  return `<input type="text" data-field="${name}" value="${escHtml(value)}" placeholder="${placeholder}"
    style="width:100%;padding:6px 8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-size:13px;box-sizing:border-box"/>`;
}

function numInput(name: string, value: number): string {
  return `<input type="number" data-field="${name}" value="${value}" min="1"
    style="width:80px;padding:6px 8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-size:13px"/>`;
}

function checkInput(name: string, checked: boolean): string {
  return `<label style="display:flex;align-items:center;gap:8px;cursor:pointer">
    <input type="checkbox" data-field="${name}" ${checked ? 'checked' : ''}
      style="width:16px;height:16px;cursor:pointer;accent-color:var(--accent)"/>
    <span style="font-size:13px;color:var(--text)">Enabled</span>
  </label>`;
}

function textArea(name: string, value: string, rows = 6): string {
  return `<textarea data-field="${name}" rows="${rows}"
    style="width:100%;padding:8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-family:monospace;font-size:12px;resize:vertical;box-sizing:border-box;line-height:1.5"
  >${escHtml(value)}</textarea>`;
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function sectionCard(content: string, extra = ''): string {
  return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px;margin-bottom:16px${extra ? ';' + extra : ''}">${content}</div>`;
}

function primaryBtn(text: string, attrs = ''): string {
  return `<button ${attrs} style="padding:7px 18px;background:var(--accent);color:#fff;border:none;border-radius:var(--radius);cursor:pointer;font-size:13px;font-weight:500">${text}</button>`;
}

function ghostBtn(text: string, attrs = ''): string {
  return `<button ${attrs} style="padding:7px 14px;background:transparent;color:var(--text-muted);border:1px solid var(--border);border-radius:var(--radius);cursor:pointer;font-size:13px">${text}</button>`;
}

function dangerBtn(text: string, attrs = ''): string {
  return `<button ${attrs} style="padding:5px 12px;background:transparent;color:var(--danger,#e53e3e);border:1px solid var(--danger,#e53e3e);border-radius:var(--radius);cursor:pointer;font-size:12px">${text}</button>`;
}

export function renderLlmConfigPage(container: HTMLElement, token: string): void {
  container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:28px">
      <h2 style="margin:0;font-size:20px">LLM Configuration</h2>
    </div>

    <section style="margin-bottom:40px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
        <h3 style="margin:0;font-size:15px;font-weight:600">Providers</h3>
        <button id="btn-add-provider" style="padding:6px 14px;background:var(--accent);color:#fff;border:none;border-radius:var(--radius);cursor:pointer;font-size:13px">+ Add Provider</button>
      </div>
      <div id="add-provider-form" style="display:none;margin-bottom:20px"></div>
      <div id="llm-providers">Loading…</div>
    </section>

    <section>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
        <h3 style="margin:0;font-size:15px;font-weight:600">Prompts</h3>
        <button id="btn-add-prompt" style="padding:6px 14px;background:var(--accent);color:#fff;border:none;border-radius:var(--radius);cursor:pointer;font-size:13px">+ Add Prompt</button>
      </div>
      <div id="add-prompt-form" style="display:none;margin-bottom:20px"></div>
      <div id="llm-prompt-tabs" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:20px"></div>
      <div id="llm-prompts">Loading…</div>
    </section>

    <section style="margin-top:40px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
        <div>
          <h3 style="margin:0 0 4px;font-size:15px;font-weight:600">Function Provider Config</h3>
          <p style="margin:0;color:var(--text-muted);font-size:12px">Per-function LLM provider fallback chains, timeouts, and retry settings.</p>
        </div>
      </div>
      <div id="llm-function-configs">Loading…</div>
    </section>
  `;

  let providers: LlmProvider[] = [];
  let prompts: LlmPrompt[] = [];
  let activeKey = '';

  // ─── Add Provider Form ──────────────────────────────────────────────────────
  const addProviderFormEl = container.querySelector<HTMLElement>('#add-provider-form')!;
  const btnAddProvider = container.querySelector<HTMLElement>('#btn-add-provider')!;

  function renderAddProviderForm(): void {
    addProviderFormEl.style.display = 'block';
    addProviderFormEl.innerHTML = sectionCard(`
      <h4 style="margin:0 0 16px;font-size:14px;color:var(--accent)">New LLM Provider</h4>
      ${fieldRow('Name *', textInput('name', '', 'e.g. ollama'))}
      ${fieldRow('API URL *', textInput('api_url', '', 'https://…/v1/chat/completions'))}
      ${fieldRow('Default Model *', textInput('default_model', '', 'e.g. llama-3.1-8b-instant'))}
      ${fieldRow('API Key Secret *', textInput('api_key_secret_name', '', 'e.g. OLLAMA_API_KEY'))}
      ${fieldRow('Priority', numInput('priority', 10))}
      ${fieldRow('', checkInput('enabled', true))}
      <div style="display:flex;gap:8px;margin-top:8px">
        ${primaryBtn('Save Provider', 'id="save-new-provider"')}
        ${ghostBtn('Cancel', 'id="cancel-new-provider"')}
        <span id="add-provider-msg" style="font-size:12px;padding:7px 0"></span>
      </div>
    `, 'border-color:var(--accent)');

    addProviderFormEl.querySelector('#cancel-new-provider')!.addEventListener('click', () => {
      addProviderFormEl.style.display = 'none';
    });

    addProviderFormEl.querySelector('#save-new-provider')!.addEventListener('click', async () => {
      const msgEl = addProviderFormEl.querySelector<HTMLElement>('#add-provider-msg')!;
      const getField = (n: string) =>
        (addProviderFormEl.querySelector(`[data-field="${n}"]`) as HTMLInputElement)?.value?.trim() ?? '';
      const body = {
        name: getField('name'),
        api_url: getField('api_url'),
        default_model: getField('default_model'),
        api_key_secret_name: getField('api_key_secret_name'),
        priority: Number((addProviderFormEl.querySelector('[data-field="priority"]') as HTMLInputElement).value),
        enabled: (addProviderFormEl.querySelector('[data-field="enabled"]') as HTMLInputElement).checked,
      };
      if (!body.name || !body.api_url || !body.default_model || !body.api_key_secret_name) {
        msgEl.textContent = 'All starred fields required';
        msgEl.style.color = 'var(--danger,#e53e3e)';
        return;
      }
      const res = await fetch('/api/admin/llm-providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        addProviderFormEl.style.display = 'none';
        await loadProviders();
      } else {
        const err = (await res.json()) as { error?: string };
        msgEl.textContent = err.error ?? 'Error saving';
        msgEl.style.color = 'var(--danger,#e53e3e)';
      }
    });
  }

  btnAddProvider.addEventListener('click', () => {
    if (addProviderFormEl.style.display === 'none') renderAddProviderForm();
    else addProviderFormEl.style.display = 'none';
  });

  // ─── Providers List ─────────────────────────────────────────────────────────
  async function loadProviders(): Promise<void> {
    const el = container.querySelector<HTMLElement>('#llm-providers')!;
    const res = await fetch('/api/admin/llm-providers', { headers: { Authorization: `Bearer ${token}` } });
    const json = (await res.json()) as { providers?: LlmProvider[] };
    providers = json.providers ?? [];

    if (!providers.length) {
      el.innerHTML = '<p style="color:var(--text-muted);font-size:13px">No providers configured.</p>';
      return;
    }

    el.innerHTML = providers.map(p => `
      <div data-provider-id="${p.id}" style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px;margin-bottom:12px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
          <span style="font-size:15px;font-weight:600">${escHtml(p.name)}</span>
          ${badge(`priority ${p.priority}`)}
          ${p.enabled
            ? badge('enabled', 'var(--success,#38a169)')
            : badge('disabled', 'var(--text-muted)')}
        </div>
        ${fieldRow('API URL', textInput('api_url', p.api_url))}
        ${fieldRow('Default Model', textInput('default_model', p.default_model))}
        ${fieldRow('API Key Secret', textInput('api_key_secret_name', p.api_key_secret_name))}
        ${fieldRow('Priority', numInput('priority', p.priority))}
        ${fieldRow('', checkInput('enabled', p.enabled))}
        <div style="display:flex;gap:8px;margin-top:8px">
          ${primaryBtn('Save', `data-save-provider="${p.id}"`)}
          ${dangerBtn('Delete', `data-delete-provider="${p.id}"`)}
          <span data-provider-msg="${p.id}" style="font-size:12px;padding:7px 0"></span>
        </div>
      </div>
    `).join('');

    el.querySelectorAll('button[data-save-provider]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = (btn as HTMLElement).dataset['saveProvider']!;
        const row = el.querySelector<HTMLElement>(`[data-provider-id="${id}"]`)!;
        const msgEl = el.querySelector<HTMLElement>(`[data-provider-msg="${id}"]`)!;
        const body: Record<string, unknown> = {};
        row.querySelectorAll('input[data-field]').forEach(inp => {
          const input = inp as HTMLInputElement;
          body[input.dataset['field']!] = input.type === 'checkbox' ? input.checked
            : input.type === 'number' ? Number(input.value) : input.value;
        });
        const res = await fetch(`/api/admin/llm-providers?id=${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        });
        msgEl.textContent = res.ok ? 'Saved!' : 'Error';
        msgEl.style.color = res.ok ? 'var(--success,#38a169)' : 'var(--danger,#e53e3e)';
        if (res.ok) setTimeout(() => { msgEl.textContent = ''; }, 2500);
      });
    });

    el.querySelectorAll('button[data-delete-provider]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = (btn as HTMLElement).dataset['deleteProvider']!;
        const p = providers.find(x => x.id === id);
        if (!confirm(`Delete provider "${p?.name ?? id}"? This cannot be undone.`)) return;
        const res = await fetch(`/api/admin/llm-providers?id=${id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) await loadProviders();
      });
    });
  }

  // ─── Add Prompt Form ────────────────────────────────────────────────────────
  const addPromptFormEl = container.querySelector<HTMLElement>('#add-prompt-form')!;
  const btnAddPrompt = container.querySelector<HTMLElement>('#btn-add-prompt')!;

  function renderAddPromptForm(): void {
    addPromptFormEl.style.display = 'block';
    addPromptFormEl.innerHTML = sectionCard(`
      <h4 style="margin:0 0 16px;font-size:14px;color:var(--accent)">New Prompt</h4>
      <p style="color:var(--text-muted);font-size:12px;margin-bottom:16px">
        Available placeholders vary by key. Common: ${ALL_PLACEHOLDERS.map(p => `<code>${escHtml(p)}</code>`).join(', ')}
      </p>
      ${fieldRow('Prompt Key *', textInput('prompt_key', '', 'e.g. news_summary'))}
      ${fieldRow('Variant', textInput('variant', '', 'e.g. tech  (blank = any)'))}
      ${fieldRow('Mode', textInput('mode', '', 'e.g. brief  (blank = any)'))}
      ${fieldRow('Description', textInput('description', '', 'Short description…'))}
      ${fieldRow('System Prompt *', textArea('system_prompt', '', 8))}
      ${fieldRow('User Prompt', textArea('user_prompt', '', 4))}
      <div style="display:flex;gap:8px;margin-top:8px">
        ${primaryBtn('Save Prompt', 'id="save-new-prompt"')}
        ${ghostBtn('Cancel', 'id="cancel-new-prompt"')}
        <span id="add-prompt-msg" style="font-size:12px;padding:7px 0"></span>
      </div>
    `, 'border-color:var(--accent)');

    addPromptFormEl.querySelector('#cancel-new-prompt')!.addEventListener('click', () => {
      addPromptFormEl.style.display = 'none';
    });

    addPromptFormEl.querySelector('#save-new-prompt')!.addEventListener('click', async () => {
      const msgEl = addPromptFormEl.querySelector<HTMLElement>('#add-prompt-msg')!;
      const getField = (n: string) =>
        (addPromptFormEl.querySelector(`[data-field="${n}"]`) as HTMLInputElement | HTMLTextAreaElement)?.value?.trim() ?? '';
      const body = {
        prompt_key: getField('prompt_key'),
        system_prompt: getField('system_prompt'),
        user_prompt: getField('user_prompt') || null,
        variant: getField('variant') || null,
        mode: getField('mode') || null,
        description: getField('description') || null,
      };
      if (!body.prompt_key || !body.system_prompt) {
        msgEl.textContent = 'Prompt Key and System Prompt required';
        msgEl.style.color = 'var(--danger,#e53e3e)';
        return;
      }
      const res = await fetch('/api/admin/llm-prompts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        addPromptFormEl.style.display = 'none';
        await loadPrompts();
      } else {
        const err = (await res.json()) as { error?: string };
        msgEl.textContent = err.error ?? 'Error saving';
        msgEl.style.color = 'var(--danger,#e53e3e)';
      }
    });
  }

  btnAddPrompt.addEventListener('click', () => {
    if (addPromptFormEl.style.display === 'none') renderAddPromptForm();
    else addPromptFormEl.style.display = 'none';
  });

  // ─── Prompts List ───────────────────────────────────────────────────────────
  async function loadPrompts(): Promise<void> {
    const tabs = container.querySelector<HTMLElement>('#llm-prompt-tabs')!;
    const promptsEl = container.querySelector<HTMLElement>('#llm-prompts')!;
    const res = await fetch('/api/admin/llm-prompts', { headers: { Authorization: `Bearer ${token}` } });
    const json = (await res.json()) as { prompts?: LlmPrompt[] };
    prompts = json.prompts ?? [];

    if (!prompts.length) {
      tabs.innerHTML = '';
      promptsEl.innerHTML = '<p style="color:var(--text-muted);font-size:13px">No prompts configured.</p>';
      return;
    }

    const keys = [...new Set(prompts.map(p => p.prompt_key))].sort();
    if (!activeKey || !keys.includes(activeKey)) activeKey = keys[0]!;

    function renderTabs(): void {
      tabs.innerHTML = keys.map(k => `
        <button data-key="${k}" style="
          padding:6px 16px;
          background:${k === activeKey ? 'var(--accent)' : 'var(--surface)'};
          color:${k === activeKey ? '#fff' : 'var(--text-muted)'};
          border:1px solid ${k === activeKey ? 'var(--accent)' : 'var(--border)'};
          border-radius:20px;cursor:pointer;font-size:13px;font-weight:${k === activeKey ? '600' : '400'}
        ">${k}</button>
      `).join('');
      tabs.querySelectorAll('button[data-key]').forEach(btn => {
        btn.addEventListener('click', () => {
          activeKey = (btn as HTMLElement).dataset['key']!;
          renderTabs();
          renderPrompts();
        });
      });
    }

    async function showPromptHistory(promptId: string): Promise<void> {
      const res = await fetch(`/api/admin/llm-prompts?id=${promptId}&history=true`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const history = (await res.json()) as Array<{
        id: string; prompt_id: string; system_prompt: string; user_prompt: string | null;
        changed_by: string | null; changed_at: string;
      }>;

      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:1000';
      const modal = document.createElement('div');
      modal.style.cssText = 'background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:24px;width:min(660px,95vw);max-height:80vh;overflow-y:auto;display:flex;flex-direction:column;gap:12px';
      modal.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
          <h3 style="margin:0;font-size:15px">Prompt History</h3>
          <button id="close-history" style="background:none;border:none;color:var(--text-muted);font-size:20px;cursor:pointer;line-height:1">×</button>
        </div>
      `;
      overlay.appendChild(modal);

      if (!history.length) {
        modal.innerHTML += '<p style="color:var(--text-muted);font-size:13px">No history yet.</p>';
      }

      for (const entry of history) {
        const entryEl = document.createElement('div');
        entryEl.style.cssText = 'border:1px solid var(--border);border-radius:6px;padding:14px';
        const date = new Date(entry.changed_at).toLocaleString();
        const preview = (entry.system_prompt ?? '').slice(0, 120) + ((entry.system_prompt?.length ?? 0) > 120 ? '…' : '');
        entryEl.innerHTML = `
          <div style="color:var(--text-muted);font-size:11px;margin-bottom:6px">${escHtml(date)} — ${escHtml(entry.changed_by ?? 'unknown')}</div>
          <div style="font-size:12px;font-family:monospace;color:var(--text);margin-bottom:10px;white-space:pre-wrap">${escHtml(preview)}</div>
          ${ghostBtn('Revert to this version', `data-revert="${entry.prompt_id}" data-content="${escHtml(entry.system_prompt ?? '')}" data-user-prompt="${escHtml(entry.user_prompt ?? '')}"`)}
        `;
        modal.appendChild(entryEl);
      }

      modal.querySelector('#close-history')?.addEventListener('click', () => overlay.remove());
      modal.querySelectorAll('[data-revert]').forEach(btn => {
        btn.addEventListener('click', () => {
          const pid = (btn as HTMLElement).dataset['revert']!;
          const systemContent = (btn as HTMLElement).dataset['content']!;
          const userContent = (btn as HTMLElement).dataset['userPrompt'] ?? '';
          const block = promptsEl.querySelector<HTMLElement>(`[data-prompt-id="${pid}"]`);
          const sysTa = block?.querySelector<HTMLTextAreaElement>('[data-field="system_prompt"]');
          const userTa = block?.querySelector<HTMLTextAreaElement>('[data-field="user_prompt"]');
          if (sysTa) sysTa.value = systemContent;
          if (userTa) userTa.value = userContent;
          overlay.remove();
        });
      });

      overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
      document.body.appendChild(overlay);
    }

    function renderPrompts(): void {
      const rows = prompts.filter(p => p.prompt_key === activeKey);
      promptsEl.innerHTML = rows.map(p => `
        <div data-prompt-id="${p.id}" style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px;margin-bottom:16px">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:14px">
            ${badge(p.variant ?? 'any variant')}
            ${badge(p.mode ?? 'any mode')}
            ${p.description ? `<span style="font-size:12px;color:var(--text-muted)">${escHtml(p.description)}</span>` : ''}
          </div>
          <p style="color:var(--text-muted);font-size:11px;margin:0 0 10px">
            Placeholders: ${getPlaceholders(activeKey).map(ph => `<code>${escHtml(ph)}</code>`).join(', ')}
          </p>
          <div style="margin-bottom:12px">
            <label style="display:block;color:var(--text-muted);font-size:12px;font-weight:600;margin-bottom:4px">System Prompt</label>
            ${textArea('system_prompt', p.system_prompt, 7)}
          </div>
          ${p.user_prompt !== null ? `
          <div style="margin-bottom:12px">
            <label style="display:block;color:var(--text-muted);font-size:12px;font-weight:600;margin-bottom:4px">User Prompt</label>
            ${textArea('user_prompt', p.user_prompt, 4)}
          </div>` : ''}
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            ${primaryBtn('Save', `data-save-prompt="${p.id}"`)}
            ${ghostBtn('History', `data-history-prompt="${p.id}"`)}
            ${dangerBtn('Delete', `data-delete-prompt="${p.id}"`)}
            <span data-prompt-msg="${p.id}" style="font-size:12px"></span>
          </div>
        </div>
      `).join('');

      promptsEl.querySelectorAll('button[data-save-prompt]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = (btn as HTMLElement).dataset['savePrompt']!;
          const block = promptsEl.querySelector<HTMLElement>(`[data-prompt-id="${id}"]`)!;
          const msgEl = promptsEl.querySelector<HTMLElement>(`[data-prompt-msg="${id}"]`)!;
          const body: Record<string, string | null> = {};
          block.querySelectorAll('textarea[data-field]').forEach(ta => {
            body[(ta as HTMLElement).dataset['field']!] = (ta as HTMLTextAreaElement).value;
          });
          const res = await fetch(`/api/admin/llm-prompts?id=${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify(body),
          });
          msgEl.textContent = res.ok ? 'Saved!' : 'Error';
          msgEl.style.color = res.ok ? 'var(--success,#38a169)' : 'var(--danger,#e53e3e)';
          if (res.ok) setTimeout(() => { msgEl.textContent = ''; }, 2500);
        });
      });

      promptsEl.querySelectorAll('button[data-history-prompt]').forEach(btn => {
        btn.addEventListener('click', async () => {
          await showPromptHistory((btn as HTMLElement).dataset['historyPrompt']!);
        });
      });

      promptsEl.querySelectorAll('button[data-delete-prompt]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = (btn as HTMLElement).dataset['deletePrompt']!;
          const p = prompts.find(x => x.id === id);
          const label = `${p?.prompt_key ?? id} (${p?.variant ?? 'any'} / ${p?.mode ?? 'any'})`;
          if (!confirm(`Delete prompt "${label}"? This cannot be undone.`)) return;
          const res = await fetch(`/api/admin/llm-prompts?id=${id}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` },
          });
          if (res.ok) await loadPrompts();
        });
      });
    }

    renderTabs();
    renderPrompts();
  }

  // ─── Function Provider Config ───────────────────────────────────────────────
  let functionConfigs: LlmFunctionConfig[] = [];
  let enabledProviders: LlmProvider[] = [];

  async function loadFunctionConfigs(): Promise<void> {
    const el = container.querySelector<HTMLElement>('#llm-function-configs')!;
    el.innerHTML = 'Loading…';

    const [cfgRes, provRes] = await Promise.all([
      fetch('/api/admin/llm-function-configs', { headers: { Authorization: `Bearer ${token}` } }),
      fetch('/api/admin/llm-providers', { headers: { Authorization: `Bearer ${token}` } }),
    ]);

    const cfgJson = (await cfgRes.json()) as { configs?: LlmFunctionConfig[]; error?: string };
    const provJson = (await provRes.json()) as { providers?: LlmProvider[] };

    if (!cfgRes.ok || cfgJson.error) {
      el.innerHTML = `<p style="color:var(--danger,#e53e3e);font-size:13px">Failed to load function configs: ${escHtml(cfgJson.error ?? cfgRes.statusText)}</p>`;
      return;
    }

    functionConfigs = cfgJson.configs ?? [];
    enabledProviders = (provJson.providers ?? []).filter(p => p.enabled);

    if (!functionConfigs.length) {
      el.innerHTML = '<p style="color:var(--text-muted);font-size:13px">No function configs found.</p>';
      return;
    }

    renderFunctionConfigs();
  }

  function renderFunctionConfigs(): void {
    const el = container.querySelector<HTMLElement>('#llm-function-configs')!;

    el.innerHTML = functionConfigs.map(cfg => {
      const chainChips = cfg.provider_chain.map((name, idx) => `
        <span data-chain-item style="
          display:inline-flex;align-items:center;gap:4px;
          padding:3px 8px;border-radius:12px;
          background:var(--surface);border:1px solid var(--border);
          color:var(--text);font-size:12px;font-weight:500
        ">
          <span style="color:var(--text-muted);font-size:11px">${idx + 1}.</span>
          ${escHtml(name)}
          <button data-remove-chain="${escHtml(cfg.function_key)}" data-provider-name="${escHtml(name)}"
            style="background:none;border:none;color:var(--danger,#e53e3e);cursor:pointer;font-size:14px;line-height:1;padding:0 2px"
            title="Remove ${escHtml(name)} from chain"
          >×</button>
        </span>
      `).join('');

      const availableOptions = enabledProviders
        .filter(p => !cfg.provider_chain.includes(p.name))
        .map(p => `<option value="${escHtml(p.name)}">${escHtml(p.name)}</option>`)
        .join('');

      return `
        <div data-fn-key="${escHtml(cfg.function_key)}"
          style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px;margin-bottom:12px">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;flex-wrap:wrap">
            <span style="font-size:15px;font-weight:600;font-family:monospace">${escHtml(cfg.function_key)}</span>
            ${cfg.description ? `<span style="font-size:12px;color:var(--text-muted)">${escHtml(cfg.description)}</span>` : ''}
          </div>

          <div style="margin-bottom:12px">
            <label style="display:block;color:var(--text-muted);font-size:12px;font-weight:600;margin-bottom:6px">Provider Chain (ordered fallback)</label>
            <div data-chain-chips="${escHtml(cfg.function_key)}"
              style="display:flex;flex-wrap:wrap;gap:6px;min-height:32px;align-items:center">
              ${chainChips || '<span style="color:var(--text-muted);font-size:12px;font-style:italic">No providers — add one below</span>'}
            </div>
            ${availableOptions ? `
            <div style="display:flex;align-items:center;gap:6px;margin-top:8px">
              <select data-add-provider-select="${escHtml(cfg.function_key)}"
                style="padding:5px 8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-size:12px">
                <option value="">— add provider —</option>
                ${availableOptions}
              </select>
              <button data-add-provider-btn="${escHtml(cfg.function_key)}"
                style="padding:5px 12px;background:transparent;color:var(--accent);border:1px solid var(--accent);border-radius:var(--radius);cursor:pointer;font-size:12px"
              >+ Add</button>
            </div>` : '<p style="font-size:12px;color:var(--text-muted);margin:6px 0 0">All enabled providers already in chain.</p>'}
          </div>

          ${fieldRow('Timeout (ms)', numInput('timeout_ms', cfg.timeout_ms))}
          ${fieldRow('Max Retries', numInput('max_retries', cfg.max_retries))}

          <div style="display:flex;gap:8px;margin-top:8px">
            ${primaryBtn('Save', `data-save-fn="${escHtml(cfg.function_key)}"`)}
            <span data-fn-msg="${escHtml(cfg.function_key)}" style="font-size:12px;padding:7px 0"></span>
          </div>
        </div>
      `;
    }).join('');

    // Remove provider from chain
    el.querySelectorAll('button[data-remove-chain]').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = (btn as HTMLElement).dataset['removeChain']!;
        const providerName = (btn as HTMLElement).dataset['providerName']!;
        const cfg = functionConfigs.find(c => c.function_key === key);
        if (!cfg) return;
        cfg.provider_chain = cfg.provider_chain.filter(n => n !== providerName);
        renderFunctionConfigs();
      });
    });

    // Add provider to chain
    el.querySelectorAll('button[data-add-provider-btn]').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = (btn as HTMLElement).dataset['addProviderBtn']!;
        const select = el.querySelector<HTMLSelectElement>(`[data-add-provider-select="${key}"]`);
        const name = select?.value;
        if (!name) return;
        const cfg = functionConfigs.find(c => c.function_key === key);
        if (!cfg) return;
        if (!cfg.provider_chain.includes(name)) {
          cfg.provider_chain = [...cfg.provider_chain, name];
        }
        renderFunctionConfigs();
      });
    });

    // Save function config
    el.querySelectorAll('button[data-save-fn]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const key = (btn as HTMLElement).dataset['saveFn']!;
        const row = el.querySelector<HTMLElement>(`[data-fn-key="${key}"]`)!;
        const msgEl = el.querySelector<HTMLElement>(`[data-fn-msg="${key}"]`)!;
        const cfg = functionConfigs.find(c => c.function_key === key);
        if (!cfg) return;

        const getNum = (field: string): number => {
          const inp = row.querySelector<HTMLInputElement>(`input[data-field="${field}"]`);
          return inp ? Number(inp.value) : 0;
        };

        const body = {
          provider_chain: cfg.provider_chain,
          timeout_ms: getNum('timeout_ms'),
          max_retries: getNum('max_retries'),
        };

        const res = await fetch(`/api/admin/llm-function-configs?function_key=${encodeURIComponent(key)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        });

        msgEl.textContent = res.ok ? 'Saved!' : 'Error saving';
        msgEl.style.color = res.ok ? 'var(--success,#38a169)' : 'var(--danger,#e53e3e)';
        if (res.ok) {
          const cfg2 = functionConfigs.find(c => c.function_key === key);
          if (cfg2) {
            cfg2.timeout_ms = body.timeout_ms;
            cfg2.max_retries = body.max_retries;
          }
          setTimeout(() => { msgEl.textContent = ''; }, 2500);
        }
      });
    });
  }

  void loadProviders();
  void loadPrompts();
  void loadFunctionConfigs();
}
