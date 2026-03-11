import { Panel } from './Panel';
import { getBufferedAiPayload } from '@/data/ai-handler';
import { h, replaceChildren } from '@/utils/dom-utils';
import { escapeHtml } from '@/utils/sanitize';
import { t } from '@/services/i18n';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

interface ChannelSummary {
  channel: string;
  channelTitle: string;
  summary: string;
  themes: string[];
  sentiment: string;
  messageCount: number;
}

interface EarlyWarning {
  event: string;
  reportedBy: string[];
  confidence: 'high' | 'medium';
}

interface Change {
  type: 'new' | 'escalation' | 'de-escalation' | 'resolved';
  description: string;
}

interface TelegramSummaryData {
  channelSummaries: ChannelSummary[];
  crossChannelDigest: string;
  earlyWarnings: EarlyWarning[];
  changes: Change[];
  previousSummaryComparison: string;
  messageCount: number;
  channelCount: number;
  model: string;
  provider: string;
  generatedAt: string;
}

export class TelegramSummaryPanel extends Panel {
  override readonly channelKeys = ['ai:telegram-summary'];

  private contentEl!: HTMLElement;
  private footerEl!: HTMLElement;

  constructor() {
    super({
      id: 'telegram-summary',
      title: t('panels.telegramSummary') ?? 'Telegram Summary',
      showCount: false,
      trackActivity: true,
      infoTooltip: t('components.telegramSummary.infoTooltip') ?? 'AI-generated summaries of monitored Telegram channels with cross-channel digest and early warnings.',
    });
    this.contentEl = h('div', { className: 'telegram-summary-content' });
    this.footerEl = h('div', { className: 'telegram-summary-footer' });
    replaceChildren(this.content, this.contentEl, this.footerEl);

    const buffered = getBufferedAiPayload('ai:telegram-summary');
    if (buffered) this.applyTelegramSummary(buffered);
  }

  applyTelegramSummary(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const raw = payload as Record<string, unknown>;
    const data = (raw.data ?? raw) as TelegramSummaryData;

    if (!data.channelSummaries && !data.crossChannelDigest) {
      replaceChildren(this.contentEl, h('div', { className: 'summary-empty' }, 'Waiting for Telegram summary...'));
      return;
    }

    const sections: HTMLElement[] = [];

    if (data.earlyWarnings?.length) {
      const warningItems = data.earlyWarnings.map((w) =>
        h('li', { className: `warning-item warning-${w.confidence}` },
          h('span', { className: 'warning-event' }, escapeHtml(w.event)),
          h('span', { className: 'warning-sources' }, ` (${(w.reportedBy ?? []).join(', ')} — ${w.confidence} confidence)`),
        ),
      );
      sections.push(
        h('div', { className: 'summary-section early-warnings' },
          h('h4', {}, 'Early Warnings'),
          h('ul', {}, ...warningItems),
        ),
      );
    }

    if (data.crossChannelDigest) {
      const digestDiv = document.createElement('div');
      digestDiv.className = 'cross-channel-digest';
      void Promise.resolve(marked.parse(data.crossChannelDigest)).then((html) => {
        digestDiv.innerHTML = DOMPurify.sanitize(String(html));
      }).catch(() => {
        digestDiv.textContent = data.crossChannelDigest;
      });
      sections.push(
        h('div', { className: 'summary-section' },
          h('h4', {}, 'Situational Overview'),
          digestDiv,
        ),
      );
    }

    if (data.changes?.length) {
      const changeItems = data.changes.map((c) =>
        h('li', { className: `change-item change-${c.type}` },
          h('span', { className: 'change-badge' }, c.type.toUpperCase()),
          h('span', {}, ` ${escapeHtml(c.description)}`),
        ),
      );
      sections.push(
        h('div', { className: 'summary-section changes' },
          h('h4', {}, 'Changes Since Last Update'),
          data.previousSummaryComparison
            ? h('p', { className: 'change-comparison' }, escapeHtml(data.previousSummaryComparison))
            : h('span'),
          h('ul', {}, ...changeItems),
        ),
      );
    }

    if (data.channelSummaries?.length) {
      const channelCards = data.channelSummaries.map((cs) =>
        h('details', { className: 'channel-card' },
          h('summary', { className: 'channel-card-header' },
            h('span', { className: 'channel-name' }, escapeHtml(cs.channelTitle || cs.channel)),
            h('span', { className: `channel-sentiment sentiment-${cs.sentiment}` }, cs.sentiment ?? ''),
            h('span', { className: 'channel-count' }, `${cs.messageCount ?? 0} msgs`),
          ),
          h('div', { className: 'channel-card-body' },
            h('p', {}, escapeHtml(cs.summary ?? '')),
            Array.isArray(cs.themes) && cs.themes.length > 0
              ? h('div', { className: 'channel-themes' }, ...cs.themes.map((th) => h('span', { className: 'theme-tag' }, escapeHtml(th))))
              : h('span'),
          ),
        ),
      );
      sections.push(
        h('div', { className: 'summary-section channel-summaries' },
          h('h4', {}, `Channel Summaries (${data.channelCount ?? 0})`),
          ...channelCards,
        ),
      );
    }

    replaceChildren(this.contentEl, ...sections);

    if (data.generatedAt) {
      const ts = new Date(data.generatedAt).toLocaleString();
      const meta = `Generated ${ts} · ${data.model || 'unknown'} · ${data.messageCount ?? 0} messages across ${data.channelCount ?? 0} channels`;
      replaceChildren(this.footerEl, h('span', { className: 'summary-meta' }, meta));
    }

    this.setDataBadge('live');
  }
}
