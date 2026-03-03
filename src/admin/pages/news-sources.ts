type NewsSource = {
  id: string;
  name: string;
  url: unknown;
  tier: number;
  variants: string[];
  category: string;
  lang: string;
  proxy_mode: string;
  enabled: boolean;
};

export function renderNewsSourcesPage(container: HTMLElement, token: string): void {
  container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px">
      <h2>News Sources</h2>
      <div style="display:flex;gap:8px">
        <input id="ns-search" type="text" placeholder="Search name/URL…" style="padding:6px 12px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);width:200px"/>
        <select id="ns-variant" style="padding:6px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text)">
          <option value="">All variants</option>
          <option value="full">Full</option>
          <option value="tech">Tech</option>
          <option value="finance">Finance</option>
          <option value="happy">Happy</option>
        </select>
      </div>
    </div>
    <div id="ns-list">Loading…</div>
    <div style="margin-top:24px;padding:20px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius)">
      <h3 style="margin-bottom:16px">Bulk Import (JSON array)</h3>
      <p style="color:var(--text-muted);font-size:12px;margin-bottom:8px">Format: [{"name":"...","url":"...","tier":2,"variants":["full"],"category":"general","lang":"en"}]</p>
      <textarea id="ns-bulk" rows="6" style="width:100%;padding:8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-family:monospace;font-size:12px;resize:vertical"></textarea>
      <div style="margin-top:8px;display:flex;gap:8px;align-items:center">
        <button id="ns-bulk-import" style="padding:8px 16px;background:var(--accent);color:#fff;border:none;border-radius:var(--radius);cursor:pointer">Import</button>
        <span id="ns-bulk-msg" style="font-size:13px"></span>
      </div>
    </div>
  `;

  let allSources: NewsSource[] = [];

  function renderTable(sources: NewsSource[]): void {
    const list = container.querySelector<HTMLElement>('#ns-list')!;
    if (!sources.length) {
      list.innerHTML = '<p style="color:var(--text-muted)">No sources found.</p>';
      return;
    }
    list.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="color:var(--text-muted);font-size:12px;border-bottom:1px solid var(--border)">
        <th style="text-align:left;padding:8px 4px">Name</th>
        <th style="text-align:left;padding:8px 4px">URL</th>
        <th style="text-align:center;padding:8px 4px">Tier</th>
        <th style="text-align:left;padding:8px 4px">Variants</th>
        <th style="text-align:left;padding:8px 4px">Lang</th>
        <th style="text-align:center;padding:8px 4px">Enabled</th>
        <th></th>
      </tr></thead>
      <tbody>${sources
        .map(s => {
          const urlDisplay =
            typeof s.url === 'string' ? s.url : '<span style="color:var(--text-muted)">{multi-lang}</span>';
          const chips = s.variants
            .map(
              v =>
                `<span style="padding:2px 6px;background:rgba(56,139,253,0.15);color:var(--accent);border-radius:4px;font-size:11px">${v}</span>`
            )
            .join(' ');
          return `<tr style="border-bottom:1px solid var(--border)">
          <td style="padding:8px 4px">${s.name}</td>
          <td style="padding:8px 4px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${urlDisplay}</td>
          <td style="padding:8px 4px;text-align:center">${s.tier}</td>
          <td style="padding:8px 4px">${chips}</td>
          <td style="padding:8px 4px">${s.lang}</td>
          <td style="padding:8px 4px;text-align:center">
            <input type="checkbox" data-id="${s.id}" ${s.enabled ? 'checked' : ''} style="cursor:pointer"/>
          </td>
          <td style="padding:8px 4px">
            <button data-del-id="${s.id}" style="padding:4px 8px;background:transparent;border:1px solid var(--danger);color:var(--danger);border-radius:var(--radius);cursor:pointer;font-size:11px">Del</button>
          </td>
        </tr>`;
        })
        .join('')}</tbody>
    </table>`;

    list.querySelectorAll('input[data-id]').forEach(el => {
      el.addEventListener('change', async () => {
        const input = el as HTMLInputElement;
        await fetch(`/api/admin/news-sources?id=${input.dataset['id']}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ enabled: input.checked }),
        });
      });
    });

    list.querySelectorAll('button[data-del-id]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = (btn as HTMLElement).dataset['delId']!;
        if (!confirm('Delete this source?')) return;
        await fetch(`/api/admin/news-sources?id=${id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
        load();
      });
    });
  }

  function filterAndRender(): void {
    const search = (container.querySelector<HTMLInputElement>('#ns-search')!).value.toLowerCase();
    const variant = (container.querySelector<HTMLSelectElement>('#ns-variant')!).value;
    renderTable(
      allSources.filter(s => {
        const urlStr = typeof s.url === 'string' ? s.url : JSON.stringify(s.url);
        const matchSearch =
          !search || s.name.toLowerCase().includes(search) || urlStr.toLowerCase().includes(search);
        const matchVariant = !variant || s.variants.includes(variant);
        return matchSearch && matchVariant;
      })
    );
  }

  async function load(): Promise<void> {
    const res = await fetch('/api/admin/news-sources', { headers: { Authorization: `Bearer ${token}` } });
    const json = (await res.json()) as { sources?: NewsSource[] };
    allSources = json.sources ?? [];
    filterAndRender();
  }

  container.querySelector('#ns-search')!.addEventListener('input', filterAndRender);
  container.querySelector('#ns-variant')!.addEventListener('change', filterAndRender);

  container.querySelector('#ns-bulk-import')!.addEventListener('click', async () => {
    const msg = container.querySelector<HTMLElement>('#ns-bulk-msg')!;
    const raw = (container.querySelector<HTMLTextAreaElement>('#ns-bulk')!).value.trim();
    let rows: unknown[];
    try {
      rows = JSON.parse(raw);
    } catch {
      msg.textContent = 'Invalid JSON';
      msg.style.color = 'var(--danger)';
      return;
    }
    if (!Array.isArray(rows)) {
      msg.textContent = 'Expected JSON array';
      msg.style.color = 'var(--danger)';
      return;
    }
    let ok = 0;
    let fail = 0;
    for (const row of rows) {
      const res = await fetch('/api/admin/news-sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(row),
      });
      res.ok ? ok++ : fail++;
    }
    msg.textContent = `Imported ${ok}, failed ${fail}`;
    msg.style.color = fail ? 'var(--warning)' : 'var(--success)';
    load();
  });

  load();
}
