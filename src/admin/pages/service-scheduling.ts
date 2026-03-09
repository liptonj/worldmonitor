type ServiceConfig = {
  service_key: string;
  description: string | null;
  enabled: boolean;
  cron_schedule: string;
  ttl_seconds: number;
  timeout_ms: number;
  fetch_type: string;
  redis_key: string | null;
  last_run_at: string | null;
  last_status: string | null;
  last_duration_ms: number | null;
  consecutive_failures: number;
};

type TabId = 'service-config' | 'source-scheduling' | 'cache-viewer';

const SUPABASE_URL =
  (typeof window !== 'undefined' && (window as unknown as { ENV?: { SUPABASE_URL?: string } }).ENV?.SUPABASE_URL) ||
  (typeof import.meta !== 'undefined' && (import.meta.env?.VITE_SUPABASE_URL as string)) ||
  '';
const SUPABASE_ANON_KEY =
  (typeof window !== 'undefined' && (window as unknown as { ENV?: { SUPABASE_ANON_KEY?: string } }).ENV?.SUPABASE_ANON_KEY) ||
  (typeof import.meta !== 'undefined' && (import.meta.env?.VITE_SUPABASE_ANON_KEY as string)) ||
  '';

const FETCH_TYPES = ['custom', 'simple_http', 'simple_rss'];

function escHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function textInput(name: string, value: string, placeholder = '', width = '100%'): string {
  return `<input type="text" data-field="${name}" value="${escHtml(value)}" placeholder="${escHtml(placeholder)}"
    style="width:${width};padding:5px 8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-size:12px;box-sizing:border-box"/>`;
}

function numInput(name: string, value: number, min = 0, max = 999999, width = '70px'): string {
  return `<input type="number" data-field="${name}" value="${value}" min="${min}" max="${max}"
    style="width:${width};padding:5px 8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-size:12px"/>`;
}

function selectInput(name: string, options: string[], value: string): string {
  return `<select data-field="${name}" style="padding:5px 8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-size:12px">
    ${options.map((o) => `<option value="${o}"${o === value ? ' selected' : ''}>${o}</option>`).join('')}
  </select>`;
}

function checkInput(name: string, checked: boolean, label: string): string {
  return `<label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px">
    <input type="checkbox" data-field="${name}" ${checked ? 'checked' : ''} style="cursor:pointer;accent-color:var(--accent)"/>
    ${escHtml(label)}
  </label>`;
}

function cronToHuman(expr: string): string {
  if (expr === '*/5 * * * *') return 'every 5 min';
  if (expr === '*/10 * * * *') return 'every 10 min';
  if (expr === '*/15 * * * *') return 'every 15 min';
  if (expr === '*/30 * * * *') return 'every 30 min';
  if (expr === '0 * * * *') return 'every hour';
  if (expr === '0 */6 * * *') return 'every 6 hours';
  if (expr === '0 0 * * *') return 'daily at midnight';
  if (expr === '*/1 * * * *') return 'every minute';
  return expr;
}

function statusBadge(status: string | null, failures: number, lastRun: string | null): string {
  if (!lastRun) return '<span style="color:var(--text-muted);font-size:11px">never run</span>';
  if (status === 'ok' && failures === 0)
    return '<span style="color:var(--success,#38a169);font-size:11px">✓ ok</span>';
  return '<span style="color:var(--danger,#e53e3e);font-size:11px">✗ error</span>';
}

function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return d.toLocaleDateString();
}

type ServiceGroup = { label: string; services: ServiceConfig[] };

function groupServices(configs: ServiceConfig[]): ServiceGroup[] {
  const groups: { ai: ServiceConfig[]; news: ServiceConfig[]; config: ServiceConfig[]; other: ServiceConfig[] } = {
    ai: [],
    news: [],
    config: [],
    other: [],
  };
  for (const s of configs) {
    if (s.service_key.startsWith('ai:')) groups.ai.push(s);
    else if (s.service_key.startsWith('news:')) groups.news.push(s);
    else if (s.service_key.startsWith('config:')) groups.config.push(s);
    else groups.other.push(s);
  }
  const result: ServiceGroup[] = [];
  if (groups.ai.length) result.push({ label: 'AI Services', services: groups.ai });
  if (groups.news.length) result.push({ label: 'News Services', services: groups.news });
  if (groups.config.length) result.push({ label: 'Config Services', services: groups.config });
  if (groups.other.length) result.push({ label: 'Other Services', services: groups.other });
  return result;
}

async function fetchServiceConfigs(accessToken: string): Promise<ServiceConfig[]> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/service_config?select=*&order=service_key.asc`,
    {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${accessToken}`,
        'Accept-Profile': 'wm_admin',
      },
    },
  );
  if (!res.ok) throw new Error(`Failed to fetch: ${res.statusText}`);
  return res.json();
}

async function fetchStatuses(accessToken: string): Promise<
  Array<{
    service_key: string;
    last_run_at: string | null;
    last_status: string | null;
    consecutive_failures: number;
  }>
> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_relay_service_statuses`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Accept-Profile': 'wm_admin',
    },
    body: '{}',
  });
  if (!res.ok) return [];
  const rows = await res.json();
  return rows ?? [];
}

function mergeStatuses(
  configs: ServiceConfig[],
  statuses: Array<{ service_key: string; last_run_at: string | null; last_status: string | null; consecutive_failures: number }>,
): ServiceConfig[] {
  const byKey = new Map(statuses.map((s) => [s.service_key, s]));
  return configs.map((c) => {
    const st = byKey.get(c.service_key);
    if (!st) return c;
    return { ...c, last_run_at: st.last_run_at, last_status: st.last_status, consecutive_failures: st.consecutive_failures };
  });
}

export function renderServiceSchedulingPage(container: HTMLElement, accessToken: string): void {
  let activeTab: TabId = 'service-config';
  let cacheViewerSearch: string | null = null;
  let statusPollInterval: ReturnType<typeof setInterval> | null = null;

  container.innerHTML = `
    <div class="page-header">
      <h1 style="margin:0;font-size:24px;font-weight:600">Service Scheduling</h1>
    </div>

    <div class="tabs" style="display:flex;gap:8px;border-bottom:1px solid var(--border);margin-bottom:20px">
      <button class="tab" data-tab="service-config" style="padding:10px 16px;background:transparent;border:none;border-bottom:2px solid var(--accent);color:var(--accent);cursor:pointer;font-size:14px;margin-bottom:-1px">⚙️ Service Config</button>
      <button class="tab" data-tab="source-scheduling" style="padding:10px 16px;background:transparent;border:none;border-bottom:2px solid transparent;color:var(--text-muted);cursor:pointer;font-size:14px;margin-bottom:-1px">📰 Source Scheduling</button>
      <button class="tab" data-tab="cache-viewer" style="padding:10px 16px;background:transparent;border:none;border-bottom:2px solid transparent;color:var(--text-muted);cursor:pointer;font-size:14px;margin-bottom:-1px">🔍 Cache Viewer</button>
    </div>

    <div id="tab-content"></div>
  `;

  function updateActiveTab(): void {
    container.querySelectorAll('.tab').forEach((btn) => {
      const tab = btn.getAttribute('data-tab');
      const isActive = tab === activeTab;
      (btn as HTMLElement).style.background = 'transparent';
      (btn as HTMLElement).style.borderBottom = `2px solid ${isActive ? 'var(--accent)' : 'transparent'}`;
      (btn as HTMLElement).style.color = isActive ? 'var(--accent)' : 'var(--text-muted)';
      (btn as HTMLElement).style.marginBottom = '-1px';
    });
  }

  function renderActiveTab(): void {
    if (statusPollInterval) {
      clearInterval(statusPollInterval);
      statusPollInterval = null;
    }
    const content = container.querySelector('#tab-content') as HTMLElement;
    switch (activeTab) {
      case 'service-config':
        renderServiceConfigTab(content, accessToken, (redisKey) => {
          cacheViewerSearch = redisKey || null;
          activeTab = 'cache-viewer';
          updateActiveTab();
          renderActiveTab();
        }, (interval) => {
          statusPollInterval = interval;
        });
        break;
      case 'source-scheduling':
        content.innerHTML = '<p style="color:var(--text-muted);padding:20px">Source Scheduling tab — Coming soon</p>';
        break;
      case 'cache-viewer':
        content.innerHTML = `<p style="color:var(--text-muted);padding:20px">Cache Viewer tab — Coming soon${cacheViewerSearch ? ` (search: ${escHtml(cacheViewerSearch)})` : ''}</p>`;
        break;
    }
  }

  container.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeTab = btn.getAttribute('data-tab') as TabId;
      updateActiveTab();
      renderActiveTab();
    });
  });

  updateActiveTab();
  renderActiveTab();
}

function renderServiceConfigTab(
  container: HTMLElement,
  accessToken: string,
  onSwitchToCacheViewer: (redisKey: string) => void,
  onPollStarted: (interval: ReturnType<typeof setInterval>) => void,
): void {
  let configs: ServiceConfig[] = [];
  const selectedKeys = new Set<string>();

  function showError(msg: string): void {
    const el = container.querySelector<HTMLElement>('#sc-error');
    if (el) {
      el.textContent = msg;
      el.style.display = 'block';
      el.style.color = 'var(--danger,#e53e3e)';
    }
  }

  function clearError(): void {
    const el = container.querySelector<HTMLElement>('#sc-error');
    if (el) el.style.display = 'none';
  }

  function showToast(msg: string, ok = true): void {
    const el = container.querySelector<HTMLElement>('#sc-toast');
    if (el) {
      el.textContent = msg;
      el.style.display = 'block';
      el.style.color = ok ? 'var(--success,#38a169)' : 'var(--danger,#e53e3e)';
      setTimeout(() => { el!.style.display = 'none'; }, 2500);
    }
  }

  async function pollStatuses(): Promise<void> {
    try {
      const statuses = await fetchStatuses(accessToken);
      configs = mergeStatuses(configs, statuses);
      render();
    } catch {
      // ignore poll errors
    }
  }

  function collectRowData(row: HTMLElement, serviceKey: string): Partial<ServiceConfig> {
    const get = (n: string) =>
      (row.querySelector(`[data-field="${n}"]`) as HTMLInputElement | HTMLSelectElement | null)?.value?.trim() ?? '';
    const checked = (n: string) =>
      (row.querySelector(`[data-field="${n}"]`) as HTMLInputElement | null)?.checked ?? false;
    return {
      service_key: serviceKey,
      description: get('description') || null,
      enabled: checked('enabled'),
      cron_schedule: get('cron_schedule') || '*/5 * * * *',
      ttl_seconds: parseInt(get('ttl_seconds'), 10) || 300,
      timeout_ms: parseInt(get('timeout_ms'), 10) || 30000,
      fetch_type: get('fetch_type') || 'custom',
    };
  }

  async function saveRow(serviceKey: string, row: HTMLElement): Promise<void> {
    const data = collectRowData(row, serviceKey);
    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/service_config?service_key=eq.${encodeURIComponent(serviceKey)}`,
        {
          method: 'PATCH',
          headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'Content-Profile': 'wm_admin',
          },
          body: JSON.stringify({
            description: data.description,
            enabled: data.enabled,
            cron_schedule: data.cron_schedule,
            ttl_seconds: data.ttl_seconds,
            timeout_ms: data.timeout_ms,
            fetch_type: data.fetch_type,
          }),
        },
      );
      if (!res.ok) throw new Error(await res.text());
      showToast('Saved');
      configs = configs.map((c) => (c.service_key === serviceKey ? { ...c, ...data } : c));
    } catch (e) {
      showToast((e as Error).message || 'Save failed', false);
    }
  }

  async function triggerNow(serviceKey: string): Promise<void> {
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/trigger_relay_service`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Accept-Profile': 'wm_admin',
        },
        body: JSON.stringify({ p_service_key: serviceKey }),
      });
      if (!res.ok) throw new Error(await res.text());
      showToast('Triggered');
      await pollStatuses();
    } catch (e) {
      showToast((e as Error).message || 'Trigger failed', false);
    }
  }

  async function bulkEnable(enable: boolean): Promise<void> {
    const keys = Array.from(selectedKeys);
    if (!keys.length) {
      showToast('Select services first', false);
      return;
    }
    try {
      for (const key of keys) {
        const res = await fetch(
          `${SUPABASE_URL}/rest/v1/service_config?service_key=eq.${encodeURIComponent(key)}`,
          {
            method: 'PATCH',
            headers: {
              apikey: SUPABASE_ANON_KEY,
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
              'Content-Profile': 'wm_admin',
            },
            body: JSON.stringify({ enabled: enable }),
          },
        );
        if (!res.ok) throw new Error(await res.text());
      }
      showToast(enable ? 'Enabled selected' : 'Disabled selected');
      selectedKeys.clear();
      await load();
    } catch (e) {
      showToast((e as Error).message || 'Bulk update failed', false);
    }
  }

  function render(): void {
    const groups = groupServices(configs);
    const tableHtml = groups
      .map(
        (g) => `
      <div style="margin-bottom:24px">
        <h3 style="margin:0 0 12px;font-size:14px;color:var(--text-muted);font-weight:600">${escHtml(g.label)}</h3>
        <div style="overflow-x:auto">
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <thead>
              <tr style="color:var(--text-muted);font-size:11px;border-bottom:2px solid var(--border)">
                <th style="text-align:left;padding:8px 6px;width:24px"></th>
                <th style="text-align:left;padding:8px 6px;white-space:nowrap">Service Key</th>
                <th style="text-align:left;padding:8px 6px">Description</th>
                <th style="text-align:center;padding:8px 6px">Enabled</th>
                <th style="text-align:left;padding:8px 6px">Cron</th>
                <th style="text-align:left;padding:8px 6px">TTL</th>
                <th style="text-align:left;padding:8px 6px">Timeout</th>
                <th style="text-align:left;padding:8px 6px">Fetch</th>
                <th style="text-align:left;padding:8px 6px">Status</th>
                <th style="text-align:left;padding:8px 6px">Last Run</th>
                <th style="text-align:left;padding:8px 6px">Duration</th>
                <th style="text-align:center;padding:8px 6px">Failures</th>
                <th style="padding:8px 6px">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${g.services
                .map(
                  (s) => `
                <tr data-service-key="${escHtml(s.service_key)}" style="border-bottom:1px solid var(--border)">
                  <td style="padding:8px 6px">
                    <input type="checkbox" data-bulk-select data-key="${escHtml(s.service_key)}" style="cursor:pointer;accent-color:var(--accent)"/>
                  </td>
                  <td style="padding:8px 6px;font-family:monospace;font-size:12px">${escHtml(s.service_key)}</td>
                  <td style="padding:8px 6px">${textInput('description', s.description ?? '', '', '140px')}</td>
                  <td style="padding:8px 6px;text-align:center">${checkInput('enabled', s.enabled, '')}</td>
                  <td style="padding:8px 6px">
                    <div style="display:flex;flex-direction:column;gap:2px">
                      ${textInput('cron_schedule', s.cron_schedule, '*/5 * * * *', '100px')}
                      <span style="font-size:10px;color:var(--text-muted)">${escHtml(cronToHuman(s.cron_schedule))}</span>
                    </div>
                  </td>
                  <td style="padding:8px 6px">${numInput('ttl_seconds', s.ttl_seconds, 0, 999999, '60px')}</td>
                  <td style="padding:8px 6px">${numInput('timeout_ms', s.timeout_ms, 0, 300000, '70px')}</td>
                  <td style="padding:8px 6px">${selectInput('fetch_type', FETCH_TYPES, s.fetch_type)}</td>
                  <td style="padding:8px 6px">${statusBadge(s.last_status, s.consecutive_failures, s.last_run_at)}</td>
                  <td style="padding:8px 6px;color:var(--text-muted);font-size:12px">${escHtml(relativeTime(s.last_run_at))}</td>
                  <td style="padding:8px 6px;font-size:12px">${s.last_duration_ms != null ? `${s.last_duration_ms}ms` : '—'}</td>
                  <td style="padding:8px 6px;text-align:center;font-size:12px">${s.consecutive_failures}</td>
                  <td style="padding:8px 6px;white-space:nowrap">
                    <button data-trigger="${escHtml(s.service_key)}" style="padding:4px 8px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);cursor:pointer;font-size:11px;color:var(--text);margin-right:4px">Trigger</button>
                    <button data-save="${escHtml(s.service_key)}" style="padding:4px 8px;background:var(--accent);color:#fff;border:none;border-radius:var(--radius);cursor:pointer;font-size:11px;margin-right:4px">Save</button>
                    ${s.redis_key ? `<button data-view-cache="${escHtml(s.redis_key)}" style="padding:4px 8px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);cursor:pointer;font-size:11px;color:var(--text)">Cache</button>` : ''}
                  </td>
                </tr>
              `,
                )
                .join('')}
            </tbody>
          </table>
        </div>
      </div>
    `,
      )
      .join('');

    container.innerHTML = `
      <div id="sc-error" style="display:none;padding:10px 14px;background:rgba(229,62,62,0.1);border:1px solid var(--danger,#e53e3e);border-radius:var(--radius);margin-bottom:16px"></div>
      <div id="sc-toast" style="display:none;position:fixed;top:20px;right:20px;padding:10px 16px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);z-index:1000;font-size:13px"></div>

      <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap">
        <button id="sc-bulk-enable" style="padding:6px 14px;background:var(--success,#38a169);color:#fff;border:none;border-radius:var(--radius);cursor:pointer;font-size:13px">Enable Selected</button>
        <button id="sc-bulk-disable" style="padding:6px 14px;background:var(--danger,#e53e3e);color:#fff;border:none;border-radius:var(--radius);cursor:pointer;font-size:13px">Disable Selected</button>
        <span id="sc-count" style="color:var(--text-muted);font-size:12px">${configs.length} services</span>
      </div>

      <div id="sc-tables">${tableHtml}</div>
    `;

    // Bulk select handlers
    container.querySelectorAll('[data-bulk-select]').forEach((cb) => {
      cb.addEventListener('change', () => {
        const key = (cb as HTMLElement).dataset['key']!;
        if ((cb as HTMLInputElement).checked) selectedKeys.add(key);
        else selectedKeys.delete(key);
      });
    });

    container.querySelector('#sc-bulk-enable')?.addEventListener('click', () => bulkEnable(true));
    container.querySelector('#sc-bulk-disable')?.addEventListener('click', () => bulkEnable(false));

    // Row action handlers
    container.querySelectorAll('[data-save]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = (btn as HTMLElement).dataset['save']!;
        const row = container.querySelector(`tr[data-service-key="${key}"]`) as HTMLElement;
        if (row) saveRow(key, row);
      });
    });

    container.querySelectorAll('[data-trigger]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = (btn as HTMLElement).dataset['trigger']!;
        triggerNow(key);
      });
    });

    container.querySelectorAll('[data-view-cache]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = (btn as HTMLElement).dataset['viewCache'] ?? '';
        onSwitchToCacheViewer(key);
      });
    });
  }

  async function load(): Promise<void> {
    clearError();
    container.innerHTML = `
      <div id="sc-error" style="display:none;padding:10px 14px;background:rgba(229,62,62,0.1);border:1px solid var(--danger,#e53e3e);border-radius:var(--radius);margin-bottom:16px"></div>
      <div id="sc-tables"><p style="color:var(--text-muted);padding:20px">Loading…</p></div>
    `;
    try {
      configs = await fetchServiceConfigs(accessToken);
      render();
      const interval = setInterval(pollStatuses, 30000);
      onPollStarted(interval);
    } catch (e) {
      showError((e as Error).message || 'Failed to load services');
      const tables = container.querySelector('#sc-tables');
      if (tables) tables.innerHTML = '';
    }
  }

  void load();
}
