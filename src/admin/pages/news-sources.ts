type NewsSource = {
  id: string;
  name: string;
  url: unknown; // string | { [lang: string]: string }
  tier: number;
  variants: string[];
  category: string | null;
  source_type: string | null;
  lang: string;
  proxy_mode: string;
  propaganda_risk: string;
  state_affiliated: string | null;
  propaganda_note: string | null;
  default_enabled: boolean;
  enabled: boolean;
};

const KNOWN_VARIANTS = ['full', 'tech', 'finance', 'happy', 'world'];
const PROXY_MODES    = ['proxy', 'railway', 'direct', 'rss'];
const PROP_RISKS     = ['low', 'medium', 'high'];

function escHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function textInput(name: string, value: string, placeholder = '', width = '100%'): string {
  return `<input type="text" data-field="${name}" value="${escHtml(value)}" placeholder="${escHtml(placeholder)}"
    style="width:${width};padding:5px 8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-size:12px;box-sizing:border-box"/>`;
}

function numInput(name: string, value: number, min = 1, max = 4): string {
  return `<input type="number" data-field="${name}" value="${value}" min="${min}" max="${max}"
    style="width:60px;padding:5px 8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-size:12px"/>`;
}

function selectInput(name: string, options: string[], value: string): string {
  return `<select data-field="${name}" style="padding:5px 8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-size:12px">
    ${options.map(o => `<option value="${o}"${o === value ? ' selected' : ''}>${o}</option>`).join('')}
  </select>`;
}

function checkInput(name: string, checked: boolean, label: string): string {
  return `<label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px">
    <input type="checkbox" data-field="${name}" ${checked ? 'checked' : ''} style="cursor:pointer;accent-color:var(--accent)"/>
    ${escHtml(label)}
  </label>`;
}

function variantCheckboxes(selected: string[]): string {
  return `<div style="display:flex;flex-wrap:wrap;gap:6px">${KNOWN_VARIANTS.map(v =>
    `<label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:12px">
      <input type="checkbox" data-variant="${v}" ${selected.includes(v) ? 'checked' : ''} style="cursor:pointer;accent-color:var(--accent)"/> ${v}
    </label>`
  ).join('')}</div>`;
}

function urlDisplay(url: unknown): string {
  if (typeof url === 'string') return `<span style="font-family:monospace;font-size:11px">${escHtml(url)}</span>`;
  return `<span style="color:var(--text-muted);font-size:11px">{multi-lang}</span>`;
}

function urlToEditString(url: unknown): string {
  if (typeof url === 'string') return url;
  return JSON.stringify(url);
}

function badge(text: string, color = 'var(--accent)'): string {
  return `<span style="display:inline-block;padding:1px 7px;border-radius:10px;background:var(--surface);border:1px solid var(--border);color:${color};font-size:11px">${escHtml(text)}</span>`;
}

function fieldLabel(text: string): string {
  return `<label style="display:block;color:var(--text-muted);font-size:11px;font-weight:600;margin-bottom:3px">${text}</label>`;
}

function buildEditForm(s: Partial<NewsSource>, idPrefix: string): string {
  const name        = s.name ?? '';
  const urlStr      = urlToEditString(s.url ?? '');
  const tier        = s.tier ?? 2;
  const category    = s.category ?? 'general';
  const sourceType  = s.source_type ?? 'rss';
  const lang        = s.lang ?? 'en';
  const proxyMode   = s.proxy_mode ?? 'proxy';
  const propRisk    = s.propaganda_risk ?? 'low';
  const stateAff    = s.state_affiliated ?? '';
  const propNote    = s.propaganda_note ?? '';
  const variants    = s.variants ?? ['full'];
  const enabled     = s.enabled ?? true;
  const defEnabled  = s.default_enabled ?? true;

  const isNew = !s.id;

  return `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
      <div>
        ${fieldLabel('Name *')}
        ${textInput('name', name, 'e.g. BBC News')}
      </div>
      <div>
        ${fieldLabel('URL * (string or JSON object for multi-lang)')}
        ${textInput('url', urlStr, 'https://feeds.example.com/rss')}
      </div>
      <div>
        ${fieldLabel('Category')}
        ${textInput('category', category, 'general')}
      </div>
      <div>
        ${fieldLabel('Source Type')}
        ${textInput('source_type', sourceType, 'rss')}
      </div>
      <div>
        ${fieldLabel('Language')}
        ${textInput('lang', lang, 'en', '80px')}
      </div>
      <div>
        ${fieldLabel('Tier (1–4)')}
        ${numInput('tier', tier)}
      </div>
      <div>
        ${fieldLabel('Proxy Mode')}
        ${selectInput('proxy_mode', PROXY_MODES, proxyMode)}
      </div>
      <div>
        ${fieldLabel('Propaganda Risk')}
        ${selectInput('propaganda_risk', PROP_RISKS, propRisk)}
      </div>
      <div>
        ${fieldLabel('State Affiliated')}
        ${textInput('state_affiliated', stateAff, 'e.g. Russia')}
      </div>
      <div>
        ${fieldLabel('Propaganda Note')}
        ${textInput('propaganda_note', propNote, 'Optional note')}
      </div>
    </div>
    <div style="margin-bottom:12px">
      ${fieldLabel('Variants')}
      <div id="${idPrefix}-variants">${variantCheckboxes(variants)}</div>
    </div>
    <div style="display:flex;gap:20px;margin-bottom:14px">
      ${checkInput('enabled', enabled, 'Enabled')}
      ${checkInput('default_enabled', defEnabled, 'Default enabled')}
    </div>
    <div style="display:flex;gap:8px;align-items:center">
      <button data-save-${isNew ? 'new' : `source="${s.id}"`} style="padding:6px 16px;background:var(--accent);color:#fff;border:none;border-radius:var(--radius);cursor:pointer;font-size:13px">
        ${isNew ? 'Add Source' : 'Save'}
      </button>
      ${!isNew ? `<button data-del-id="${s.id}" style="padding:6px 12px;background:transparent;color:var(--danger,#e53e3e);border:1px solid var(--danger,#e53e3e);border-radius:var(--radius);cursor:pointer;font-size:12px">Delete</button>` : ''}
      <span data-form-msg style="font-size:12px"></span>
    </div>
  `;
}

function collectFormData(form: HTMLElement): Record<string, unknown> {
  const get = (n: string) =>
    (form.querySelector(`[data-field="${n}"]`) as HTMLInputElement | HTMLSelectElement | null)?.value?.trim() ?? '';
  const checked = (n: string) =>
    (form.querySelector(`[data-field="${n}"]`) as HTMLInputElement | null)?.checked ?? false;

  const rawUrl = get('url');
  let url: unknown = rawUrl;
  try { url = JSON.parse(rawUrl); } catch { /* keep string */ }

  const variants: string[] = [];
  form.querySelectorAll<HTMLInputElement>('[data-variant]').forEach(cb => {
    if (cb.checked) variants.push(cb.dataset['variant']!);
  });

  return {
    name:              get('name'),
    url,
    tier:              Number(get('tier')) || 2,
    category:          get('category') || 'general',
    source_type:       get('source_type') || 'rss',
    lang:              get('lang') || 'en',
    proxy_mode:        get('proxy_mode') || 'proxy',
    propaganda_risk:   get('propaganda_risk') || 'low',
    state_affiliated:  get('state_affiliated') || null,
    propaganda_note:   get('propaganda_note') || null,
    variants:          variants.length ? variants : ['full'],
    enabled:           checked('enabled'),
    default_enabled:   checked('default_enabled'),
  };
}

export function renderNewsSourcesPage(container: HTMLElement, token: string): void {
  container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:20px">
      <h2 style="margin:0;font-size:20px">News Sources</h2>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <input id="ns-search" type="text" placeholder="Search name / URL…"
          style="padding:6px 12px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);width:200px;font-size:13px"/>
        <select id="ns-variant"
          style="padding:6px 10px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-size:13px">
          <option value="">All variants</option>
          ${KNOWN_VARIANTS.map(v => `<option value="${v}">${v}</option>`).join('')}
        </select>
        <button id="btn-add-source"
          style="padding:6px 14px;background:var(--accent);color:#fff;border:none;border-radius:var(--radius);cursor:pointer;font-size:13px">
          + Add Source
        </button>
      </div>
    </div>

    <!-- Add single source form -->
    <div id="add-source-form" style="display:none;background:var(--surface);border:1px solid var(--accent);border-radius:8px;padding:20px;margin-bottom:20px">
      <h4 style="margin:0 0 16px;font-size:14px;color:var(--accent)">New News Source</h4>
      ${buildEditForm({}, 'new')}
    </div>

    <!-- Sources list -->
    <div id="ns-list" style="margin-bottom:32px">Loading…</div>

    <!-- Bulk import (collapsed by default) -->
    <details style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:0">
      <summary style="padding:14px 18px;cursor:pointer;font-size:14px;font-weight:600;list-style:none;display:flex;align-items:center;gap:8px">
        <span>▶</span> Bulk Import (JSON array)
      </summary>
      <div style="padding:0 18px 18px">
        <p style="color:var(--text-muted);font-size:12px;margin:10px 0 8px">
          Format: <code>[{"name":"…","url":"…","tier":2,"variants":["full"],"category":"general","lang":"en"}]</code>
        </p>
        <textarea id="ns-bulk" rows="6"
          style="width:100%;padding:8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-family:monospace;font-size:12px;resize:vertical;box-sizing:border-box"></textarea>
        <div style="margin-top:8px;display:flex;gap:8px;align-items:center">
          <button id="ns-bulk-import"
            style="padding:7px 16px;background:var(--accent);color:#fff;border:none;border-radius:var(--radius);cursor:pointer;font-size:13px">Import</button>
          <span id="ns-bulk-msg" style="font-size:12px"></span>
        </div>
      </div>
    </details>
  `;

  let allSources: NewsSource[] = [];

  // ─── Add Source Form ──────────────────────────────────────────────────────
  const addFormEl = container.querySelector<HTMLElement>('#add-source-form')!;
  container.querySelector('#btn-add-source')!.addEventListener('click', () => {
    addFormEl.style.display = addFormEl.style.display === 'none' ? 'block' : 'none';
  });

  addFormEl.querySelector('[data-save-new]')!.addEventListener('click', async () => {
    const msgEl = addFormEl.querySelector<HTMLElement>('[data-form-msg]')!;
    const body = collectFormData(addFormEl);
    if (!body['name']) {
      msgEl.textContent = 'Name is required';
      msgEl.style.color = 'var(--danger,#e53e3e)';
      return;
    }
    const res = await fetch('/api/admin/news-sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      addFormEl.style.display = 'none';
      await load();
    } else {
      const err = (await res.json()) as { error?: string };
      msgEl.textContent = err.error ?? 'Error saving';
      msgEl.style.color = 'var(--danger,#e53e3e)';
    }
  });

  // ─── Sources Table ────────────────────────────────────────────────────────
  function renderTable(sources: NewsSource[]): void {
    const list = container.querySelector<HTMLElement>('#ns-list')!;
    if (!sources.length) {
      list.innerHTML = '<p style="color:var(--text-muted);font-size:13px">No sources found.</p>';
      return;
    }

    const countEl = document.createElement('p');
    countEl.style.cssText = 'color:var(--text-muted);font-size:12px;margin:0 0 12px';
    countEl.textContent = `${sources.length} source${sources.length !== 1 ? 's' : ''}`;

    const tableWrap = document.createElement('div');
    tableWrap.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead>
          <tr style="color:var(--text-muted);font-size:11px;border-bottom:2px solid var(--border)">
            <th style="text-align:left;padding:8px 6px;white-space:nowrap">Name</th>
            <th style="text-align:left;padding:8px 6px">URL</th>
            <th style="text-align:center;padding:8px 6px">Tier</th>
            <th style="text-align:left;padding:8px 6px">Variants</th>
            <th style="text-align:left;padding:8px 6px">Lang</th>
            <th style="text-align:center;padding:8px 6px">On</th>
            <th style="padding:8px 6px"></th>
          </tr>
        </thead>
        <tbody id="ns-tbody"></tbody>
      </table>
    `;

    list.innerHTML = '';
    list.appendChild(countEl);
    list.appendChild(tableWrap);

    const tbody = list.querySelector<HTMLElement>('#ns-tbody')!;

    sources.forEach(s => {
      // Summary row
      const row = document.createElement('tr');
      row.dataset['sourceId'] = s.id;
      row.style.cssText = 'border-bottom:1px solid var(--border);cursor:pointer';
      row.innerHTML = `
        <td style="padding:8px 6px;font-weight:500">${escHtml(s.name)}</td>
        <td style="padding:8px 6px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${urlDisplay(s.url)}</td>
        <td style="padding:8px 6px;text-align:center">${s.tier}</td>
        <td style="padding:8px 6px">${s.variants.map(v => badge(v)).join(' ')}</td>
        <td style="padding:8px 6px;color:var(--text-muted)">${escHtml(s.lang)}</td>
        <td style="padding:8px 6px;text-align:center">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${s.enabled ? 'var(--success,#38a169)' : 'var(--text-muted)'}"></span>
        </td>
        <td style="padding:8px 6px;white-space:nowrap">
          <button data-toggle-edit="${s.id}" style="padding:3px 10px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);cursor:pointer;font-size:11px;color:var(--text-muted)">Edit ▾</button>
        </td>
      `;
      tbody.appendChild(row);

      // Expand row (hidden initially)
      const expandRow = document.createElement('tr');
      expandRow.dataset['expandFor'] = s.id;
      expandRow.style.display = 'none';
      const expandCell = document.createElement('td');
      expandCell.colSpan = 7;
      expandCell.style.cssText = 'padding:0 6px 12px;background:var(--surface,rgba(0,0,0,0.2))';
      expandCell.innerHTML = `<div style="padding:16px;border:1px solid var(--border);border-radius:6px;margin-top:-1px">${buildEditForm(s, `edit-${s.id}`)}</div>`;
      expandRow.appendChild(expandCell);
      tbody.appendChild(expandRow);

      // Toggle edit row
      row.querySelector(`[data-toggle-edit="${s.id}"]`)!.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = expandRow.style.display !== 'none';
        expandRow.style.display = isOpen ? 'none' : 'table-row';
        (e.currentTarget as HTMLElement).textContent = isOpen ? 'Edit ▾' : 'Close ▴';
      });

      // Save edits
      const saveBtn = expandCell.querySelector<HTMLElement>(`[data-save-source="${s.id}"]`);
      saveBtn?.addEventListener('click', async () => {
        const msgEl = expandCell.querySelector<HTMLElement>('[data-form-msg]')!;
        const body = collectFormData(expandCell);
        const res = await fetch(`/api/admin/news-sources?id=${s.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        });
        if (res.ok) {
          msgEl.textContent = 'Saved!';
          msgEl.style.color = 'var(--success,#38a169)';
          setTimeout(() => { msgEl.textContent = ''; }, 2500);
          await load();
        } else {
          const err = (await res.json()) as { error?: string };
          msgEl.textContent = err.error ?? 'Error';
          msgEl.style.color = 'var(--danger,#e53e3e)';
        }
      });

      // Delete
      expandCell.querySelector<HTMLElement>(`[data-del-id="${s.id}"]`)?.addEventListener('click', async () => {
        if (!confirm(`Delete "${s.name}"?`)) return;
        await fetch(`/api/admin/news-sources?id=${s.id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
        await load();
      });
    });
  }

  function filterAndRender(): void {
    const search  = (container.querySelector<HTMLInputElement>('#ns-search')!).value.toLowerCase();
    const variant = (container.querySelector<HTMLSelectElement>('#ns-variant')!).value;
    renderTable(allSources.filter(s => {
      const urlStr = typeof s.url === 'string' ? s.url : JSON.stringify(s.url);
      const matchSearch  = !search || s.name.toLowerCase().includes(search) || urlStr.toLowerCase().includes(search);
      const matchVariant = !variant || s.variants.includes(variant);
      return matchSearch && matchVariant;
    }));
  }

  async function load(): Promise<void> {
    const res = await fetch('/api/admin/news-sources', { headers: { Authorization: `Bearer ${token}` } });
    const json = (await res.json()) as { sources?: NewsSource[] };
    allSources = json.sources ?? [];
    filterAndRender();
  }

  container.querySelector('#ns-search')!.addEventListener('input', filterAndRender);
  container.querySelector('#ns-variant')!.addEventListener('change', filterAndRender);

  // ─── Bulk Import ─────────────────────────────────────────────────────────
  container.querySelector('#ns-bulk-import')!.addEventListener('click', async () => {
    const msg  = container.querySelector<HTMLElement>('#ns-bulk-msg')!;
    const raw  = (container.querySelector<HTMLTextAreaElement>('#ns-bulk')!).value.trim();
    let rows: unknown[];
    try { rows = JSON.parse(raw); } catch {
      msg.textContent = 'Invalid JSON';
      msg.style.color = 'var(--danger,#e53e3e)';
      return;
    }
    if (!Array.isArray(rows)) {
      msg.textContent = 'Expected a JSON array';
      msg.style.color = 'var(--danger,#e53e3e)';
      return;
    }
    let ok = 0, fail = 0;
    for (const row of rows) {
      const r = await fetch('/api/admin/news-sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(row),
      });
      r.ok ? ok++ : fail++;
    }
    msg.textContent = `Imported ${ok}${fail ? `, ${fail} failed` : ''}`;
    msg.style.color = fail ? 'var(--warning,#d69e2e)' : 'var(--success,#38a169)';
    await load();
  });

  void load();
}
