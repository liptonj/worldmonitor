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

type NewsSource = {
  id: string;
  name: string;
  category: string | null;
  tier: number;
  lang: string;
  enabled: boolean;
  poll_interval_minutes: number | null;
  custom_cron: string | null;
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

// Gateway URL for admin cache API
const GATEWAY_URL =
  (typeof window !== 'undefined' && (window as unknown as { ENV?: { GATEWAY_URL?: string } }).ENV?.GATEWAY_URL) ||
  (typeof import.meta !== 'undefined' && (import.meta.env?.VITE_GATEWAY_URL as string)) ||
  'http://localhost:3004';

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

function numInputOptional(name: string, value: number | null, min = 0, max = 999, width = '70px'): string {
  const displayValue = value ?? '';
  return `<input type="number" data-field="${name}" value="${displayValue}" min="${min}" max="${max}"
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

function tierColor(tier: number): string {
  switch (tier) {
    case 1:
      return '#22c55e'; // green
    case 2:
      return '#3b82f6'; // blue
    case 3:
      return '#f59e0b'; // amber
    case 4:
      return '#ef4444'; // red
    default:
      return 'var(--text-muted)';
  }
}

function badge(text: string, bgColor: string): string {
  return `<span style="display:inline-block;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:500;background:${bgColor};color:#fff">${escHtml(text)}</span>`;
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
    const content = container.querySelector('#tab-content') as HTMLElement;

    // Clean up previous tab before rendering new one
    const cacheViewerCleanup = (content as unknown as { __cacheViewerCleanup?: () => void })
      .__cacheViewerCleanup;
    if (cacheViewerCleanup) {
      cacheViewerCleanup();
      delete (content as unknown as { __cacheViewerCleanup?: () => void }).__cacheViewerCleanup;
    }
    if (statusPollInterval) {
      clearInterval(statusPollInterval);
      statusPollInterval = null;
    }

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
        renderSourceSchedulingTab(content, accessToken);
        break;
      case 'cache-viewer':
        renderCacheViewerTab(content, accessToken, cacheViewerSearch ?? '');
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
        const key = (btn as HTMLElement).dataset['viewCache'] ?? (btn as HTMLElement).getAttribute('data-view-cache') ?? '';
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

function renderSourceSchedulingTab(container: HTMLElement, accessToken: string): void {
  const TIER_DEFAULTS: Record<number, number> = { 1: 5, 2: 15, 3: 30, 4: 60 };

  async function fetchSources(): Promise<NewsSource[]> {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/news_sources?select=id,name,category,tier,lang,enabled,poll_interval_minutes,custom_cron&order=name.asc`,
      {
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${accessToken}`,
          'Accept-Profile': 'wm_admin',
        },
      },
    );
    if (!res.ok) throw new Error(`Failed to fetch sources: ${res.statusText}`);
    return res.json();
  }

  function effectiveInterval(source: NewsSource): string {
    if (source.custom_cron) return cronToHuman(source.custom_cron);
    if (source.poll_interval_minutes) return `every ${source.poll_interval_minutes} min`;
    return `every ${TIER_DEFAULTS[source.tier]} min (tier default)`;
  }

  function hasOverride(source: NewsSource): boolean {
    return source.poll_interval_minutes !== null || source.custom_cron !== null;
  }

  const selectStyle =
    'padding:5px 8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-size:12px;min-width:120px';
  const inputStyle =
    'padding:5px 8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-size:12px;min-width:180px';
  const thStyle = 'text-align:left;padding:8px 6px;white-space:nowrap';
  const tdStyle = 'padding:8px 6px';

  async function load(): Promise<void> {
    try {
      container.innerHTML = '<p style="color:var(--text-muted)">Loading sources...</p>';

      const sources = await fetchSources();
      let filteredSources = sources;

      let filterCategory = '';
      let filterTier = '';
      let filterLang = '';
      let filterEnabled = '';
      let filterSearch = '';

      function applyFilters(): void {
        filteredSources = sources.filter((s) => {
          if (filterCategory && s.category !== filterCategory) return false;
          if (filterTier && s.tier.toString() !== filterTier) return false;
          if (filterLang && s.lang !== filterLang) return false;
          if (filterEnabled === 'yes' && !s.enabled) return false;
          if (filterEnabled === 'no' && s.enabled) return false;
          if (filterSearch && !s.name.toLowerCase().includes(filterSearch.toLowerCase())) return false;
          return true;
        });
        renderTable();
      }

      function showToast(msg: string, ok = true): void {
        const el = container.querySelector<HTMLElement>('#ss-toast');
        if (el) {
          el.textContent = msg;
          el.style.display = 'block';
          el.style.color = ok ? 'var(--success,#38a169)' : 'var(--danger,#e53e3e)';
          setTimeout(() => {
            el!.style.display = 'none';
          }, 2500);
        }
      }

      function renderTable(): void {
        const categories = Array.from(new Set(sources.map((s) => s.category).filter(Boolean))).sort() as string[];
        const languages = Array.from(new Set(sources.map((s) => s.lang))).sort();

        container.innerHTML = `
          <div id="ss-toast" style="display:none;position:fixed;top:20px;right:20px;padding:10px 16px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);z-index:1000;font-size:13px"></div>
          <div style="margin-bottom:16px">
            <h2 style="margin:0 0 12px 0;font-size:18px;font-weight:600">Source Scheduling (${filteredSources.length} sources)</h2>

            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <select id="filter-category" style="${selectStyle}">
                <option value="">All Categories</option>
                ${categories.map((c) => `<option value="${escHtml(c)}">${escHtml(c)}</option>`).join('')}
              </select>

              <select id="filter-tier" style="${selectStyle}">
                <option value="">All Tiers</option>
                <option value="1">Tier 1</option>
                <option value="2">Tier 2</option>
                <option value="3">Tier 3</option>
                <option value="4">Tier 4</option>
              </select>

              <select id="filter-lang" style="${selectStyle}">
                <option value="">All Languages</option>
                ${languages.map((l) => `<option value="${escHtml(l)}">${escHtml(l)}</option>`).join('')}
              </select>

              <select id="filter-enabled" style="${selectStyle}">
                <option value="">All Status</option>
                <option value="yes">Enabled Only</option>
                <option value="no">Disabled Only</option>
              </select>

              <input type="text" id="filter-search" placeholder="Search by name..." style="${inputStyle}" />
            </div>
          </div>

          <div style="overflow-x:auto">
            <table style="width:100%;border-collapse:collapse;font-size:13px">
              <thead>
                <tr style="background:var(--surface);border-bottom:2px solid var(--border)">
                  <th style="${thStyle}">Name</th>
                  <th style="${thStyle}">Category</th>
                  <th style="${thStyle}">Tier</th>
                  <th style="${thStyle}">Effective Interval</th>
                  <th style="${thStyle}">Poll Interval (min)</th>
                  <th style="${thStyle}">Custom Cron</th>
                  <th style="${thStyle}">Enabled</th>
                  <th style="${thStyle}">Actions</th>
                </tr>
              </thead>
              <tbody>
                ${filteredSources
                  .map(
                    (s) => `
                  <tr data-source-id="${escHtml(s.id)}" style="border-bottom:1px solid var(--border)">
                    <td style="${tdStyle}">
                      ${escHtml(s.name)}
                      ${hasOverride(s) ? badge('custom', 'var(--accent)') : ''}
                    </td>
                    <td style="${tdStyle}">${escHtml(s.category || '-')}</td>
                    <td style="${tdStyle}">${badge(`T${s.tier}`, tierColor(s.tier))}</td>
                    <td style="${tdStyle}">${escHtml(effectiveInterval(s))}</td>
                    <td style="${tdStyle}">
                      ${numInputOptional('poll_interval', s.poll_interval_minutes, 0, 999)}
                      <span style="font-size:10px;color:var(--text-muted);display:block;margin-top:2px">(blank = tier default)</span>
                    </td>
                    <td style="${tdStyle}">${textInput('custom_cron', s.custom_cron || '', '*/5 * * * *', '150px')}</td>
                    <td style="${tdStyle}">${checkInput('enabled', s.enabled, '')}</td>
                    <td style="${tdStyle}">
                      <button class="btn-save" style="padding:4px 8px;background:var(--accent);color:#fff;border:none;border-radius:var(--radius);cursor:pointer;font-size:11px;margin-right:4px">Save</button>
                      <button class="btn-reset" style="padding:4px 8px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);cursor:pointer;font-size:11px;color:var(--text)">Reset</button>
                    </td>
                  </tr>
                `,
                  )
                  .join('')}
              </tbody>
            </table>
          </div>
        `;

        const filterEls = {
          category: container.querySelector('#filter-category') as HTMLSelectElement,
          tier: container.querySelector('#filter-tier') as HTMLSelectElement,
          lang: container.querySelector('#filter-lang') as HTMLSelectElement,
          enabled: container.querySelector('#filter-enabled') as HTMLSelectElement,
          search: container.querySelector('#filter-search') as HTMLInputElement,
        };

        filterEls.category.value = filterCategory;
        filterEls.tier.value = filterTier;
        filterEls.lang.value = filterLang;
        filterEls.enabled.value = filterEnabled;
        filterEls.search.value = filterSearch;

        [filterEls.category, filterEls.tier, filterEls.lang, filterEls.enabled].forEach((el) => {
          el.addEventListener('change', () => {
            filterCategory = filterEls.category.value;
            filterTier = filterEls.tier.value;
            filterLang = filterEls.lang.value;
            filterEnabled = filterEls.enabled.value;
            applyFilters();
          });
        });

        filterEls.search.addEventListener('input', () => {
          filterSearch = filterEls.search.value;
          applyFilters();
        });

        container.querySelectorAll('.btn-save').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const row = (btn as HTMLElement).closest('tr');
            if (!row) return;

            const id = row.getAttribute('data-source-id')!;
            const source = sources.find((s) => s.id === id);
            if (!source) return;

            const pollInput = row.querySelector('[data-field="poll_interval"]') as HTMLInputElement;
            const cronInput = row.querySelector('[data-field="custom_cron"]') as HTMLInputElement;
            const enabledInput = row.querySelector('[data-field="enabled"]') as HTMLInputElement;

            const pollValue = parseInt(pollInput.value, 10) || null;
            const cronValue = cronInput.value.trim() || null;

            try {
              const res = await fetch(
                `${SUPABASE_URL}/rest/v1/news_sources?id=eq.${encodeURIComponent(id)}`,
                {
                  method: 'PATCH',
                  headers: {
                    apikey: SUPABASE_ANON_KEY,
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                    'Accept-Profile': 'wm_admin',
                    'Content-Profile': 'wm_admin',
                  },
                  body: JSON.stringify({
                    poll_interval_minutes: pollValue,
                    custom_cron: cronValue,
                    enabled: enabledInput.checked,
                  }),
                },
              );

              if (!res.ok) throw new Error(`Save failed: ${res.statusText}`);

              source.poll_interval_minutes = pollValue;
              source.custom_cron = cronValue;
              source.enabled = enabledInput.checked;

              renderTable();
              showToast('Saved successfully', true);
            } catch (err) {
              showToast(`Error: ${(err as Error).message}`, false);
            }
          });
        });

        container.querySelectorAll('.btn-reset').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const row = (btn as HTMLElement).closest('tr');
            if (!row) return;

            const id = row.getAttribute('data-source-id')!;
            const source = sources.find((s) => s.id === id);
            if (!source) return;

            if (!confirm(`Reset ${source.name} to tier default?`)) return;

            try {
              const res = await fetch(
                `${SUPABASE_URL}/rest/v1/news_sources?id=eq.${encodeURIComponent(id)}`,
                {
                  method: 'PATCH',
                  headers: {
                    apikey: SUPABASE_ANON_KEY,
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                    'Accept-Profile': 'wm_admin',
                    'Content-Profile': 'wm_admin',
                  },
                  body: JSON.stringify({
                    poll_interval_minutes: null,
                    custom_cron: null,
                  }),
                },
              );

              if (!res.ok) throw new Error(`Reset failed: ${res.statusText}`);

              source.poll_interval_minutes = null;
              source.custom_cron = null;

              renderTable();
              showToast('Reset to tier default', true);
            } catch (err) {
              showToast(`Error: ${(err as Error).message}`, false);
            }
          });
        });
      }

      renderTable();
    } catch (err) {
      container.innerHTML = `<div style="padding:10px 14px;background:rgba(229,62,62,0.1);border:1px solid var(--danger,#e53e3e);border-radius:var(--radius);color:var(--danger,#e53e3e)">${escHtml((err as Error).message)}</div>`;
    }
  }

  void load();
}

function renderCacheViewerTab(container: HTMLElement, accessToken: string, initialSearch = ''): void {
  let adminApiKey = '';
  let keys: Array<{ key: string; ttl: number; size: number; type: string }> = [];
  let filteredKeys = keys;
  let selectedKey = '';
  let autoRefresh = false;
  let refreshInterval: ReturnType<typeof setInterval> | null = null;

  const errorStyle = 'padding:10px 14px;background:rgba(229,62,62,0.1);border:1px solid var(--danger,#e53e3e);border-radius:var(--radius);color:var(--danger,#e53e3e)';
  const btnStyle = 'padding:4px 8px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);cursor:pointer;font-size:11px;color:var(--text)';
  const btnDangerStyle = 'padding:4px 8px;background:transparent;border:1px solid var(--danger,#e53e3e);border-radius:var(--radius);cursor:pointer;font-size:11px;color:var(--danger,#e53e3e)';
  const selectStyle = 'padding:5px 8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-size:12px';

  async function loadApiKey(): Promise<void> {
    const res = await fetch('/api/admin/admin-api-key', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(err.error ?? `Failed to load API key: ${res.statusText}`);
    }
    const data = (await res.json()) as { key: string };
    adminApiKey = data.key ?? '';
  }

  async function fetchKeys(): Promise<void> {
    const res = await fetch(`${GATEWAY_URL}/admin/cache/keys`, {
      headers: { Authorization: `Bearer ${adminApiKey}` },
    });

    if (!res.ok) {
      if (res.status === 401) throw new Error('Unauthorized - check ADMIN_API_KEY');
      throw new Error(`Failed to fetch keys: ${res.statusText}`);
    }

    const data = (await res.json()) as { keys?: Array<{ key: string; ttl: number; size: number; type: string }> };
    keys = data.keys ?? [];
  }

  async function fetchValue(key: string): Promise<{ value: unknown; ttl: number } | null> {
    const res = await fetch(`${GATEWAY_URL}/admin/cache/key/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${adminApiKey}` },
    });

    if (!res.ok) {
      if (res.status === 404) return null;
      throw new Error(`Failed to fetch value: ${res.statusText}`);
    }

    return res.json();
  }

  async function deleteKey(key: string): Promise<void> {
    const res = await fetch(`${GATEWAY_URL}/admin/cache/key/${encodeURIComponent(key)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminApiKey}` },
    });

    if (!res.ok) throw new Error(`Failed to delete: ${res.statusText}`);
  }

  function keyPrefixColor(key: string): string {
    if (key.startsWith('ai:')) return '#8b5cf6';
    if (key.startsWith('news:')) return '#3b82f6';
    if (key.startsWith('config:')) return '#10b981';
    if (key.startsWith('market:')) return '#f59e0b';
    return 'var(--text-muted)';
  }

  function ttlProgress(ttl: number, maxTtl: number): string {
    if (ttl === -1) return '100%';
    const percent = Math.min(100, (ttl / maxTtl) * 100);
    return `${percent}%`;
  }

  function renderJson(value: unknown, indent = 0): string {
    const pad = '  '.repeat(indent);

    if (value === null) return '<span style="color:#94a3b8">null</span>';
    if (typeof value === 'boolean') return `<span style="color:#fb923c">${value}</span>`;
    if (typeof value === 'number') return `<span style="color:#60a5fa">${value}</span>`;
    if (typeof value === 'string') return `<span style="color:#34d399">"${escHtml(value)}"</span>`;

    if (Array.isArray(value)) {
      if (value.length === 0) return '[]';
      const items = value.map((v) => `${pad}  ${renderJson(v, indent + 1)}`).join(',\n');
      return `[\n${items}\n${pad}]`;
    }

    if (typeof value === 'object' && value !== null) {
      const entries = Object.entries(value);
      if (entries.length === 0) return '{}';
      const props = entries
        .map(
          ([k, v]) =>
            `${pad}  <span style="color:var(--text)">"${escHtml(k)}"</span>: ${renderJson(v, indent + 1)}`,
        )
        .join(',\n');
      return `{\n${props}\n${pad}}`;
    }

    return String(value);
  }

  function showToast(msg: string, ok = true): void {
    const el = container.querySelector<HTMLElement>('#cv-toast');
    if (el) {
      el.textContent = msg;
      el.style.display = 'block';
      el.style.color = ok ? 'var(--success,#38a169)' : 'var(--danger,#e53e3e)';
      setTimeout(() => {
        el.style.display = 'none';
      }, 2500);
    }
  }

  async function load(): Promise<void> {
    try {
      container.innerHTML = '<p style="color:var(--text-muted)">Loading API key...</p>';

      await loadApiKey();
      await fetchKeys();

      filteredKeys = keys;
      if (initialSearch) {
        filteredKeys = keys.filter((k) => k.key.includes(initialSearch));
        if (filteredKeys.length > 0) selectedKey = filteredKeys[0]!.key;
      }

      renderUI();
    } catch (err) {
      container.innerHTML = `<div style="${errorStyle}">${escHtml((err as Error).message)}</div>`;
    }
  }

  function renderUI(): void {
    container.innerHTML = `
      <div id="cv-toast" style="display:none;position:fixed;top:20px;right:20px;padding:10px 16px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);z-index:1000;font-size:13px"></div>
      <div style="display:grid;grid-template-columns:400px 1fr;gap:16px;height:calc(100vh - 250px)">
        <div style="display:flex;flex-direction:column;gap:12px;overflow:hidden">
          <div>
            <h2 style="margin:0 0 8px 0;font-size:18px;font-weight:600">Redis Cache (${filteredKeys.length} keys)</h2>
            <input type="text" id="search-input" placeholder="Search keys..." value="${escHtml(initialSearch)}"
              style="width:100%;padding:8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-size:12px;margin-bottom:8px;box-sizing:border-box" />
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <select id="sort-select" style="${selectStyle}">
                <option value="name">Sort by Name</option>
                <option value="ttl">Sort by TTL</option>
                <option value="size">Sort by Size</option>
              </select>
              <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px">
                <input type="checkbox" id="auto-refresh" style="cursor:pointer;accent-color:var(--accent)" />
                Auto-refresh (30s)
              </label>
              <button id="refresh-now" style="${btnStyle}">↻</button>
            </div>
          </div>
          <div id="key-list" style="flex:1;overflow-y:auto;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface)">
            ${filteredKeys
              .map(
                (k) => `
              <div class="key-item" data-key="${escHtml(k.key)}"
                style="padding:8px;border-bottom:1px solid var(--border);cursor:pointer;${k.key === selectedKey ? 'background:var(--bg)' : ''}">
                <div style="font-family:monospace;font-size:11px;color:${keyPrefixColor(k.key)};margin-bottom:4px">${escHtml(k.key)}</div>
                <div style="display:flex;gap:8px;font-size:10px;color:var(--text-muted)">
                  <span>TTL: ${k.ttl === -1 ? '∞' : `${k.ttl}s`}</span>
                  <span>Size: ${Math.round(k.size / 1024)}KB</span>
                  <span>Type: ${k.type}</span>
                </div>
                <div style="height:2px;background:var(--border);margin-top:4px;border-radius:2px">
                  <div style="height:100%;background:var(--accent);border-radius:2px;width:${ttlProgress(k.ttl, 3600)}"></div>
                </div>
              </div>
            `,
              )
              .join('')}
          </div>
        </div>
        <div id="value-panel" style="display:flex;flex-direction:column;gap:12px;overflow:hidden">
          ${selectedKey ? '<p style="color:var(--text-muted)">Loading value...</p>' : '<p style="color:var(--text-muted)">Select a key to view</p>'}
        </div>
      </div>
    `;

    const searchInput = container.querySelector('#search-input') as HTMLInputElement;
    searchInput.addEventListener('input', () => {
      const query = searchInput.value.toLowerCase();
      filteredKeys = keys.filter((k) => k.key.toLowerCase().includes(query));
      renderUI();
    });

    const sortSelect = container.querySelector('#sort-select') as HTMLSelectElement;
    sortSelect.addEventListener('change', () => {
      const sortBy = sortSelect.value;
      filteredKeys = [...filteredKeys].sort((a, b) => {
        if (sortBy === 'name') return a.key.localeCompare(b.key);
        if (sortBy === 'ttl') return b.ttl - a.ttl;
        if (sortBy === 'size') return b.size - a.size;
        return 0;
      });
      renderUI();
    });

    const autoRefreshCb = container.querySelector('#auto-refresh') as HTMLInputElement;
    autoRefreshCb.checked = autoRefresh;
    autoRefreshCb.addEventListener('change', () => {
      autoRefresh = autoRefreshCb.checked;
      if (autoRefresh) {
        refreshInterval = window.setInterval(async () => {
          await fetchKeys();
          filteredKeys = keys.filter((k) =>
            k.key.toLowerCase().includes(searchInput.value.toLowerCase()),
          );
          renderUI();
        }, 30000);
      } else if (refreshInterval) {
        clearInterval(refreshInterval);
        refreshInterval = null;
      }
    });

    const refreshBtn = container.querySelector('#refresh-now') as HTMLButtonElement;
    refreshBtn.addEventListener('click', async () => {
      await fetchKeys();
      filteredKeys = keys.filter((k) =>
        k.key.toLowerCase().includes(searchInput.value.toLowerCase()),
      );
      renderUI();
      showToast('Keys refreshed', true);
    });

    container.querySelectorAll('.key-item').forEach((item) => {
      item.addEventListener('click', () => {
        selectedKey = item.getAttribute('data-key')!;
        renderUI();
        void loadValue(selectedKey);
      });
    });

    if (selectedKey) void loadValue(selectedKey);
  }

  async function loadValue(key: string): Promise<void> {
    const panel = container.querySelector('#value-panel') as HTMLElement;
    if (!panel) return;
    panel.innerHTML = '<p style="color:var(--text-muted)">Loading...</p>';

    try {
      const data = await fetchValue(key);
      if (!data) {
        panel.innerHTML = '<p style="color:var(--text-muted)">Key not found</p>';
        return;
      }

      panel.innerHTML = `
        <div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px">
            <h3 style="margin:0;font-size:16px;font-weight:600;font-family:monospace">${escHtml(key)}</h3>
            <div style="display:flex;gap:8px">
              <button id="copy-btn" style="${btnStyle}">📋 Copy</button>
              <button id="invalidate-btn" style="${btnDangerStyle}">🗑️ Invalidate</button>
            </div>
          </div>
          <div style="display:flex;gap:16px;font-size:12px;color:var(--text-muted);margin-bottom:12px">
            <span>TTL: ${data.ttl === -1 ? '∞' : `${data.ttl}s`}</span>
            <span>Type: string</span>
            <span>Size: ${Math.round(JSON.stringify(data.value).length / 1024)}KB</span>
          </div>
          <div style="background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);padding:12px;overflow:auto;max-height:calc(100vh - 400px)">
            <pre style="margin:0;font-family:monospace;font-size:11px;line-height:1.6;white-space:pre-wrap">${renderJson(data.value)}</pre>
          </div>
        </div>
      `;

      const copyBtn = panel.querySelector('#copy-btn') as HTMLButtonElement;
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(JSON.stringify(data.value, null, 2));
        showToast('Copied to clipboard', true);
      });

      const invalidateBtn = panel.querySelector('#invalidate-btn') as HTMLButtonElement;
      invalidateBtn.addEventListener('click', async () => {
        if (!confirm(`Delete key "${key}"?`)) return;

        try {
          await deleteKey(key);
          keys = keys.filter((k) => k.key !== key);
          filteredKeys = filteredKeys.filter((k) => k.key !== key);
          selectedKey = '';
          renderUI();
          showToast('Key deleted', true);
        } catch (err) {
          showToast(`Error: ${(err as Error).message}`, false);
        }
      });
    } catch (err) {
      panel.innerHTML = `<div style="${errorStyle}">${escHtml((err as Error).message)}</div>`;
    }
  }

  const cleanup = (): void => {
    if (refreshInterval) {
      clearInterval(refreshInterval);
      refreshInterval = null;
    }
  };

  (container as unknown as { __cacheViewerCleanup?: () => void }).__cacheViewerCleanup = cleanup;

  void load();
}
