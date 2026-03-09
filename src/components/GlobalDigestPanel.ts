import type { GetGlobalIntelDigestResponse } from '@/generated/client/worldmonitor/intelligence/v1/service_client';
import { Panel } from './Panel';
import { IntelligenceServiceClient } from '@/generated/client/worldmonitor/intelligence/v1/service_client';
import { fetchRelayPanel } from '@/services/relay-http';
import { h, replaceChildren } from '@/utils/dom-utils';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

const client = new IntelligenceServiceClient('', { fetch: (...args) => globalThis.fetch(...args) });

export class GlobalDigestPanel extends Panel {
  override readonly channelKeys = ['intelligence'];

  private contentEl: HTMLElement;
  private footerEl: HTMLElement;
  private refreshBtn: HTMLButtonElement;
  private isLoading = false;
  private lastDigestText: string | null = null;

  constructor() {
    super({
      id: 'global-digest',
      title: 'Intelligence Digest',
      infoTooltip: 'Global intelligence synthesis across all monitored sources. Updated every 4 hours.',
    });

    this.refreshBtn = h('button', {
      className: 'digest-refresh-btn',
    }, 'Refresh') as HTMLButtonElement;

    this.contentEl = h('div', { className: 'digest-content' });
    this.footerEl = h('div', { className: 'digest-footer' });

    const container = h('div', { className: 'digest-panel-content' },
      h('div', { className: 'digest-panel-header' }, this.refreshBtn),
      this.contentEl,
      this.footerEl,
    );

    this.refreshBtn.addEventListener('click', () => this.fetch(true));

    replaceChildren(this.content, container);

    replaceChildren(this.contentEl, h('div', { className: 'digest-loading' }, 'Loading…'));

    if (!document.getElementById('global-digest-panel-styles')) {
      const style = document.createElement('style');
      style.id = 'global-digest-panel-styles';
      style.textContent = `
        .digest-panel-content { display: flex; flex-direction: column; gap: 12px; padding: 8px; height: 100%; overflow-y: auto; }
        .digest-panel-header { display: flex; justify-content: flex-end; }
        .digest-refresh-btn { padding: 6px 12px; background: var(--accent-color, #3b82f6); color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 0.85em; }
        .digest-refresh-btn:hover { background: var(--accent-hover, #2563eb); }
        .digest-refresh-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .digest-content { flex: 1; line-height: 1.5; font-size: 0.9em; color: var(--text-primary, #ddd); overflow-y: auto; }
        .digest-loading { opacity: 0.7; font-style: italic; }
        .digest-empty, .digest-error { color: var(--semantic-critical, #ef4444); }
        .digest-body h3 { margin-top: 12px; margin-bottom: 4px; font-size: 1.1em; color: var(--text-bright, #fff); }
        .digest-body ul { padding-left: 20px; margin-top: 4px; }
        .digest-body li { margin-bottom: 4px; }
        .digest-footer { font-size: 0.75em; color: #888; }
      `;
      document.head.appendChild(style);
    }

  }

  getSummaryData(): string | null {
    if (!this.lastDigestText) return null;
    return `[Intelligence Digest]\n${this.lastDigestText}`;
  }

  applyAiDigest(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const data = payload as GetGlobalIntelDigestResponse;
    if (!data.digest) return;
    this.setDigest(data);
  }

  setDigest(data: GetGlobalIntelDigestResponse): void {
    if (!data?.digest) {
      this.lastDigestText = null;
      replaceChildren(this.contentEl, h('div', { className: 'digest-empty' }, 'No digest available.'));
      return;
    }
    this.lastDigestText = data.digest;
    void Promise.resolve(marked.parse(data.digest)).then((html) => {
      const safe = DOMPurify.sanitize(String(html));
      const contentDiv = document.createElement('div');
      contentDiv.className = 'digest-body';
      contentDiv.innerHTML = safe;
      replaceChildren(this.contentEl, contentDiv);
      if (data.generatedAt) {
        const ts = new Date(data.generatedAt).toLocaleString();
        const footerText = `Generated ${ts} · ${data.model || 'unknown'} via ${data.provider || 'unknown'}`;
        replaceChildren(this.footerEl, h('span', { className: 'digest-meta' }, footerText));
      }
    }).catch(() => {});
  }

  private async fetch(forceRefresh: boolean): Promise<void> {
    if (this.isLoading) return;
    this.isLoading = true;
    this.refreshBtn.disabled = true;
    replaceChildren(this.contentEl, h('div', { className: 'digest-loading' }, forceRefresh ? 'Synthesizing intelligence…' : 'Loading…'));
    replaceChildren(this.footerEl);

    try {
      if (!forceRefresh) {
        const cached = await fetchRelayPanel<GetGlobalIntelDigestResponse>('intelligence');
        if (cached?.digest) {
          this.setDigest(cached);
          return;
        }
      }
      const res = await client.getGlobalIntelDigest({ forceRefresh });
      if (!res.digest) {
        this.lastDigestText = null;
        replaceChildren(this.contentEl, h('div', { className: 'digest-empty' }, 'No digest available. Check LLM provider configuration.'));
        return;
      }

      this.lastDigestText = res.digest;
      const html = DOMPurify.sanitize(await marked.parse(res.digest));
      const contentDiv = document.createElement('div');
      contentDiv.className = 'digest-body';
      contentDiv.innerHTML = html;
      replaceChildren(this.contentEl, contentDiv);

      if (res.generatedAt) {
        const ts = new Date(res.generatedAt).toLocaleString();
        const footerText = `Generated ${ts} · ${res.model || 'unknown'} via ${res.provider || 'unknown'}`;
        replaceChildren(this.footerEl, h('span', { className: 'digest-meta' }, footerText));
      }
    } catch (err) {
      console.error('[GlobalDigestPanel] fetch error:', err);
      this.lastDigestText = null;
      replaceChildren(this.contentEl, h('div', { className: 'digest-error' }, 'Failed to load digest.'));
    } finally {
      this.isLoading = false;
      this.refreshBtn.disabled = false;
    }
  }
}
