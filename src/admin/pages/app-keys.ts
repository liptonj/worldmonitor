type AppKey = {
  id: string;
  description: string | null;
  enabled: boolean;
  created_at: string;
  revoked_at: string | null;
};

export function renderAppKeysPage(container: HTMLElement, token: string): void {
  container.innerHTML = `
    <h2 style="margin-bottom:16px">App Access Keys</h2>
    <div style="background:rgba(210,153,34,0.1);border:1px solid var(--warning);border-radius:var(--radius);padding:12px 16px;margin-bottom:24px;color:var(--warning);font-size:13px">
      ⚠️ Each key is shown only once — copy and store it immediately in a secure location.
    </div>
    <div id="keys-list">Loading…</div>
    <div style="margin-top:24px;padding:20px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius)">
      <h3 style="margin-bottom:16px">Generate New Key</h3>
      <input id="key-desc" type="text" placeholder="Description (e.g. Desktop App v3)" style="width:300px;padding:8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);margin-right:8px"/>
      <button id="key-generate" style="padding:8px 16px;background:var(--accent);color:#fff;border:none;border-radius:var(--radius);cursor:pointer">Generate</button>
      <div id="key-reveal" style="display:none;margin-top:16px;padding:12px;background:rgba(63,185,80,0.1);border:1px solid var(--success);border-radius:var(--radius)">
        <p style="color:var(--success);margin-bottom:8px;font-size:13px">✅ Copy this key now — it will not be shown again:</p>
        <code id="key-value" style="font-family:monospace;font-size:14px;color:var(--text);word-break:break-all"></code>
      </div>
    </div>
  `;

  async function load(): Promise<void> {
    const list = container.querySelector<HTMLElement>('#keys-list')!;
    const res = await fetch('/api/admin/app-keys', { headers: { Authorization: `Bearer ${token}` } });
    const json = (await res.json()) as { keys?: AppKey[] };
    if (!json.keys?.length) {
      list.innerHTML = '<p style="color:var(--text-muted)">No keys yet.</p>';
      return;
    }
    list.innerHTML = `<table style="width:100%;border-collapse:collapse">
      <thead><tr style="color:var(--text-muted);font-size:12px;border-bottom:1px solid var(--border)">
        <th style="text-align:left;padding:8px 4px">Description</th>
        <th style="text-align:left;padding:8px 4px">Created</th>
        <th style="text-align:center;padding:8px 4px">Status</th>
        <th></th>
      </tr></thead>
      <tbody>${json.keys
        .map(
          k => `
        <tr style="border-bottom:1px solid var(--border)">
          <td style="padding:8px 4px">${k.description ?? '—'}</td>
          <td style="padding:8px 4px;color:var(--text-muted)">${new Date(k.created_at).toLocaleDateString()}</td>
          <td style="padding:8px 4px;text-align:center">
            <span style="padding:2px 8px;border-radius:4px;font-size:12px;${k.enabled ? 'background:rgba(63,185,80,0.15);color:var(--success)' : 'background:rgba(218,54,51,0.15);color:var(--danger)'}">
              ${k.enabled ? 'Active' : 'Revoked'}
            </span>
          </td>
          <td style="padding:8px 4px">${k.enabled ? `<button data-revoke="${k.id}" style="padding:4px 10px;background:transparent;border:1px solid var(--danger);color:var(--danger);border-radius:var(--radius);cursor:pointer;font-size:12px">Revoke</button>` : ''}</td>
        </tr>`
        )
        .join('')}</tbody>
    </table>`;
    list.querySelectorAll('button[data-revoke]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Revoke this key? Apps using it will lose access immediately.')) return;
        await fetch(`/api/admin/app-keys?id=${(btn as HTMLElement).dataset['revoke']}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
        load();
      });
    });
  }

  container.querySelector('#key-generate')!.addEventListener('click', async () => {
    const desc = (container.querySelector<HTMLInputElement>('#key-desc')!).value.trim();
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    const rawKey = 'wm_' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    const res = await fetch('/api/admin/app-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ rawKey, description: desc || 'Desktop App' }),
    });
    if (res.ok) {
      const reveal = container.querySelector<HTMLElement>('#key-reveal')!;
      container.querySelector<HTMLElement>('#key-value')!.textContent = rawKey;
      reveal.style.display = 'block';
      load();
    }
  });

  load();
}
