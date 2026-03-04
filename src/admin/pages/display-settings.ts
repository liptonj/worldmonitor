export function renderDisplaySettingsPage(container: HTMLElement, token: string): void {
  container.innerHTML = `
    <h2 style="margin-bottom:24px">Display Settings</h2>
    <p style="color:var(--text-muted);font-size:13px;margin-bottom:24px">
      These settings apply as defaults for all users. Users can override them in their personal settings.
    </p>
    <div id="display-settings-body">Loading…</div>
  `;

  async function load(): Promise<void> {
    const body = container.querySelector<HTMLElement>('#display-settings-body')!;
    try {
      const res = await fetch('/api/admin/display-settings', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = (await res.json()) as {
        time_format?: string;
        timezone_mode?: string;
        temp_unit?: string;
        error?: string;
      };
    if (json.error) {
      const errP = document.createElement('p');
      errP.style.color = 'var(--error)';
      errP.textContent = json.error as string;
      body.innerHTML = '';
      body.appendChild(errP);
      return;
    }

    const timeFormat = json.time_format ?? '24h';
    const timezoneMode = json.timezone_mode ?? 'utc';
    const tempUnit = json.temp_unit ?? 'celsius';

    const selectStyle =
      'padding:8px 12px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-size:14px;min-width:200px';

    body.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:16px 0;border-bottom:1px solid var(--border)">
        <div>
          <div style="font-weight:500;margin-bottom:4px">Time Format</div>
          <div style="color:var(--text-muted);font-size:13px">How times are displayed (24-hour vs 12-hour AM/PM)</div>
        </div>
        <select id="time-format" data-field="time_format" style="${selectStyle}">
          <option value="24h" ${timeFormat === '24h' ? 'selected' : ''}>24-hour</option>
          <option value="12h" ${timeFormat === '12h' ? 'selected' : ''}>12-hour (AM/PM)</option>
        </select>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;padding:16px 0;border-bottom:1px solid var(--border)">
        <div>
          <div style="font-weight:500;margin-bottom:4px">Timezone</div>
          <div style="color:var(--text-muted);font-size:13px">Whether to show times in UTC or the user's local timezone</div>
        </div>
        <select id="timezone-mode" data-field="timezone_mode" style="${selectStyle}">
          <option value="utc" ${timezoneMode === 'utc' ? 'selected' : ''}>UTC</option>
          <option value="local" ${timezoneMode === 'local' ? 'selected' : ''}>Local timezone</option>
        </select>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;padding:16px 0;border-bottom:1px solid var(--border)">
        <div>
          <div style="font-weight:500;margin-bottom:4px">Temperature Unit</div>
          <div style="color:var(--text-muted);font-size:13px">Default unit for temperature display</div>
        </div>
        <select id="temp-unit" data-field="temp_unit" style="${selectStyle}">
          <option value="celsius" ${tempUnit === 'celsius' ? 'selected' : ''}>Celsius (°C)</option>
          <option value="fahrenheit" ${tempUnit === 'fahrenheit' ? 'selected' : ''}>Fahrenheit (°F)</option>
        </select>
      </div>
    `;

    const feedback = document.createElement('div');
    feedback.id = 'display-settings-feedback';
    feedback.style.cssText = 'margin-top:16px;font-size:13px;color:var(--accent);min-height:20px';
    body.appendChild(feedback);

    body.querySelectorAll('select[data-field]').forEach(el => {
      el.addEventListener('change', async () => {
        const select = el as HTMLSelectElement;
        const field = select.dataset['field']!;
        const value = select.value;
        const payload: Record<string, string> = {};
        payload[field] = value;

        const putRes = await fetch('/api/admin/display-settings', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(payload),
        });

        const fb = body.querySelector<HTMLElement>('#display-settings-feedback')!;
        if (putRes.ok) {
          fb.textContent = 'Saved';
          setTimeout(() => {
            fb.textContent = '';
          }, 2000);
        } else {
          const err = (await putRes.json()) as { error?: string };
          fb.textContent = err.error ?? 'Save failed';
          fb.style.color = 'var(--error)';
        }
      });
    });
    } catch (err) {
      body.textContent = 'Failed to load display settings.';
      console.error('[display-settings] load error:', err);
    }
  }

  load();
}
