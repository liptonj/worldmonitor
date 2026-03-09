import type { SupabaseClient, User } from '@supabase/supabase-js';
import { renderSecretsPage } from './pages/secrets';
import { renderFeatureFlagsPage } from './pages/feature-flags';
import { renderNewsSourcesPage } from './pages/news-sources';
import { renderLlmConfigPage } from './pages/llm-config';
import { renderAppKeysPage } from './pages/app-keys';
import { renderDisplaySettingsPage } from './pages/display-settings';
import { renderMarketSymbolsPage } from './pages/market-symbols';
import { renderServiceSchedulingPage } from './pages/service-scheduling';

type PageId = 'secrets' | 'feature-flags' | 'news-sources' | 'llm-config' | 'app-keys' | 'display-settings' | 'market-symbols' | 'service-scheduling';

const NAV: Array<{ id: PageId; label: string; icon: string }> = [
  { id: 'secrets', label: 'API Keys & Secrets', icon: '🔑' },
  { id: 'feature-flags', label: 'Feature Flags', icon: '🚩' },
  { id: 'news-sources', label: 'News Sources', icon: '📡' },
  { id: 'llm-config', label: 'LLM Config & Prompts', icon: '🤖' },
  { id: 'app-keys', label: 'App Access Keys', icon: '🗝️' },
  { id: 'display-settings', label: 'Display Settings', icon: '🖥️' },
  { id: 'market-symbols', label: 'Market Symbols', icon: '📈' },
  { id: 'service-scheduling', label: 'Service Scheduling', icon: '⏱️' },
];

export function renderDashboard(
  container: HTMLElement,
  supabase: SupabaseClient,
  accessToken: string,
  user: User,
): void {
  container.innerHTML = `
    <div style="display:flex;min-height:100vh">
      <nav style="width:220px;background:var(--surface);border-right:1px solid var(--border);padding:20px 0;display:flex;flex-direction:column">
        <div style="padding:0 16px 20px;border-bottom:1px solid var(--border)">
          <div style="font-weight:700">World Monitor</div>
          <div style="color:var(--text-muted);font-size:12px">Admin Portal</div>
        </div>
        <ul id="admin-nav" style="list-style:none;padding:12px 0;flex:1">
          ${NAV.map(item => `
            <li><a href="#${item.id}" data-page="${item.id}" style="
              display:flex;align-items:center;gap:10px;padding:8px 16px;
              color:var(--text-muted);text-decoration:none;border-radius:var(--radius);
              margin:2px 8px;cursor:pointer;
            ">${item.icon} ${item.label}</a></li>
          `).join('')}
        </ul>
        <div style="padding:16px;border-top:1px solid var(--border)">
          <div style="color:var(--text-muted);font-size:12px;margin-bottom:8px">${user.email}</div>
          <button id="admin-export" style="
            width:100%;padding:6px;background:transparent;
            border:1px solid var(--border);border-radius:var(--radius);
            color:var(--text-muted);cursor:pointer;font-size:13px;margin-bottom:8px;
          ">Export Configuration</button>
          <button id="admin-signout" style="
            width:100%;padding:6px;background:transparent;
            border:1px solid var(--border);border-radius:var(--radius);
            color:var(--text-muted);cursor:pointer;font-size:13px;
          ">Sign Out</button>
        </div>
      </nav>
      <main id="admin-content" style="flex:1;padding:32px;overflow-y:auto"></main>
    </div>
  `;

  const content = container.querySelector<HTMLElement>('#admin-content')!;
  const nav = container.querySelector<HTMLElement>('#admin-nav')!;

  function navigateTo(pageId: PageId): void {
    nav.querySelectorAll('a').forEach(a => {
      const active = a.dataset['page'] === pageId;
      a.style.background = active ? 'rgba(56,139,253,0.15)' : 'transparent';
      a.style.color = active ? 'var(--accent)' : 'var(--text-muted)';
    });
    content.innerHTML = '';
    switch (pageId) {
      case 'secrets':
        renderSecretsPage(content, accessToken);
        break;
      case 'feature-flags':
        renderFeatureFlagsPage(content, accessToken);
        break;
      case 'news-sources':
        renderNewsSourcesPage(content, accessToken);
        break;
      case 'llm-config':
        renderLlmConfigPage(content, accessToken);
        break;
      case 'app-keys':
        renderAppKeysPage(content, accessToken);
        break;
      case 'display-settings':
        renderDisplaySettingsPage(content, accessToken);
        break;
      case 'market-symbols':
        renderMarketSymbolsPage(content, accessToken);
        break;
      case 'service-scheduling':
        renderServiceSchedulingPage(content, accessToken);
        break;
    }
  }

  nav.addEventListener('click', e => {
    const link = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[data-page]');
    if (!link) return;
    e.preventDefault();
    navigateTo(link.dataset['page'] as PageId);
  });

  container.querySelector('#admin-signout')!.addEventListener('click', async () => {
    await supabase.auth.signOut();
    location.reload();
  });

  container.querySelector('#admin-export')!.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/admin/export', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) {
        console.error('Export failed:', res.statusText);
        return;
      }
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `worldmonitor-config-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
    } catch (err) {
      console.error('Export error:', err);
    }
  });

  const hash = location.hash.replace('#', '') as PageId;
  navigateTo(NAV.some(n => n.id === hash) ? hash : 'secrets');
}
