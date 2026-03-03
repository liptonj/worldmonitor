export function renderFeatureFlagsPage(container: HTMLElement, token: string): void {
  container.innerHTML = `<h2 style="margin-bottom:24px">Feature Flags</h2><div id="flags-body">Loading…</div>`;

  async function load(): Promise<void> {
    const body = container.querySelector<HTMLElement>('#flags-body')!;
    const res = await fetch('/api/admin/feature-flags', { headers: { Authorization: `Bearer ${token}` } });
    const json = (await res.json()) as {
      flags?: Array<{ key: string; value: unknown; description: string; category: string }>;
    };
    if (!json.flags?.length) {
      body.innerHTML = '<p style="color:var(--text-muted)">No flags.</p>';
      return;
    }

    const byCategory = json.flags.reduce<Record<string, typeof json.flags>>((acc, f) => {
      (acc[f.category] ??= []).push(f);
      return acc;
    }, {});

    body.innerHTML = Object.entries(byCategory)
      .map(
        ([cat, flags]) => `
      <div style="margin-bottom:24px">
        <h3 style="font-size:12px;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:12px">${cat}</h3>
        <table style="width:100%;border-collapse:collapse">
          <thead><tr style="color:var(--text-muted);font-size:12px;border-bottom:1px solid var(--border)">
            <th style="text-align:left;padding:8px 4px">Key</th>
            <th style="text-align:left;padding:8px 4px;width:200px">Value</th>
            <th style="text-align:left;padding:8px 4px">Description</th>
          </tr></thead>
          <tbody>${flags
            .map(f => {
              const strVal = typeof f.value === 'string' ? f.value : JSON.stringify(f.value);
              const isBool = strVal === 'true' || strVal === 'false';
              const isNum = !isBool && !isNaN(Number(strVal));
              let input: string;
              if (isBool) {
                input = `<input type="checkbox" data-key="${f.key}" ${strVal === 'true' ? 'checked' : ''} style="width:18px;height:18px;cursor:pointer"/>`;
              } else if (isNum) {
                input = `<input type="number" data-key="${f.key}" value="${strVal}" style="width:100px;padding:4px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text)"/>`;
              } else {
                input = `<input type="text" data-key="${f.key}" value="${strVal.replace(/^"|"$/g, '')}" style="width:160px;padding:4px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text)"/>`;
              }
              return `<tr style="border-bottom:1px solid var(--border)">
              <td style="padding:8px 4px;font-family:monospace;font-size:13px">${f.key}</td>
              <td style="padding:8px 4px">${input}</td>
              <td style="padding:8px 4px;color:var(--text-muted);font-size:13px">${f.description ?? ''}</td>
            </tr>`;
            })
            .join('')}</tbody>
        </table>
      </div>
    `
      )
      .join('');

    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    body.querySelectorAll('input[data-key]').forEach(el => {
      el.addEventListener('change', () => {
        const input = el as HTMLInputElement;
        const key = input.dataset['key']!;
        const value = input.type === 'checkbox' ? String(input.checked) : input.value;
        clearTimeout(timers.get(key));
        timers.set(
          key,
          setTimeout(() => {
            fetch('/api/admin/feature-flags', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              body: JSON.stringify({ key, value }),
            });
          }, 500)
        );
      });
    });
  }

  load();
}
