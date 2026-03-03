export function renderSecretsPage(container: HTMLElement, token: string): void {
  container.innerHTML = `
    <h2 style="margin-bottom:24px">API Keys & Secrets</h2>
    <div id="secrets-list">Loading…</div>
    <div style="margin-top:32px;padding:20px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius)">
      <h3 style="margin-bottom:16px">Add / Update Secret</h3>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
        <div>
          <label style="display:block;color:var(--text-muted);margin-bottom:4px;font-size:12px">Name</label>
          <input id="secret-name" type="text" placeholder="GROQ_API_KEY" style="width:100%;padding:8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text)"/>
        </div>
        <div>
          <label style="display:block;color:var(--text-muted);margin-bottom:4px;font-size:12px">Value</label>
          <input id="secret-value" type="password" placeholder="••••••••" style="width:100%;padding:8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text)"/>
        </div>
      </div>
      <input id="secret-desc" type="text" placeholder="Description (optional)" style="width:100%;padding:8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);margin-bottom:12px"/>
      <button id="secret-save" style="padding:8px 20px;background:var(--accent);color:#fff;border:none;border-radius:var(--radius);cursor:pointer">Save Secret</button>
      <span id="secret-msg" style="margin-left:12px;font-size:13px"></span>
    </div>
  `;

  async function load(): Promise<void> {
    const list = container.querySelector<HTMLElement>('#secrets-list')!;
    try {
      const res = await fetch('/api/admin/secrets', { headers: { Authorization: `Bearer ${token}` } });
      const json = (await res.json()) as {
        secrets?: Array<{ name: string; description: string; updated_at: string }>;
      };
      if (!json.secrets?.length) {
        list.innerHTML = '<p style="color:var(--text-muted)">No secrets stored yet.</p>';
        return;
      }
      list.innerHTML = `<table style="width:100%;border-collapse:collapse">
        <thead><tr style="color:var(--text-muted);font-size:12px;border-bottom:1px solid var(--border)">
          <th style="text-align:left;padding:8px 4px">Name</th>
          <th style="text-align:left;padding:8px 4px">Description</th>
          <th style="text-align:left;padding:8px 4px">Updated</th>
          <th></th>
        </tr></thead>
        <tbody>${json.secrets
          .map(
            s => `
          <tr style="border-bottom:1px solid var(--border)">
            <td style="padding:8px 4px;font-family:monospace">${s.name}</td>
            <td style="padding:8px 4px;color:var(--text-muted)">${s.description ?? ''}</td>
            <td style="padding:8px 4px;color:var(--text-muted)">${new Date(s.updated_at).toLocaleDateString()}</td>
            <td style="padding:8px 4px"><button data-del="${s.name}" style="padding:4px 10px;background:transparent;border:1px solid var(--danger);color:var(--danger);border-radius:var(--radius);cursor:pointer;font-size:12px">Delete</button></td>
          </tr>`
          )
          .join('')}</tbody>
      </table>`;
      list.querySelectorAll('button[data-del]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const name = (btn as HTMLElement).dataset['del']!;
          if (!confirm(`Delete secret "${name}"?`)) return;
          await fetch(`/api/admin/secrets?name=${encodeURIComponent(name)}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` },
          });
          load();
        });
      });
    } catch {
      list.innerHTML = `<p style="color:var(--danger)">Failed to load secrets.</p>`;
    }
  }

  container.querySelector('#secret-save')!.addEventListener('click', async () => {
    const name = (container.querySelector<HTMLInputElement>('#secret-name')!).value.trim();
    const value = (container.querySelector<HTMLInputElement>('#secret-value')!).value;
    const description = (container.querySelector<HTMLInputElement>('#secret-desc')!).value.trim();
    const msg = container.querySelector<HTMLElement>('#secret-msg')!;
    if (!name || !value) {
      msg.textContent = 'Name and value required.';
      msg.style.color = 'var(--danger)';
      return;
    }
    const res = await fetch('/api/admin/secrets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name, value, description }),
    });
    if (res.ok) {
      msg.textContent = 'Saved!';
      msg.style.color = 'var(--success)';
      load();
    } else {
      msg.textContent = 'Save failed.';
      msg.style.color = 'var(--danger)';
    }
  });

  load();
}
