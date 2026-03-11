import { Panel } from './Panel';
import type { NewsItem } from '@/types';
import { generateSummary } from '@/services/summarization';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';

/**
 * GoodThingsDigestPanel -- Displays the top 5 positive stories of the day,
 * each with an AI-generated summary of 50 words or less.
 *
 * Progressive rendering: titles render immediately as numbered cards,
 * then AI summaries fill in from the relay cache. Cards showing
 * "Summary pending..." auto-update when new summaries arrive via WebSocket.
 */
export class GoodThingsDigestPanel extends Panel {
  private cardElements: HTMLElement[] = [];
  private pendingItems: Array<{ idx: number; item: NewsItem }> = [];
  private summaryUpdateListener: (() => void) | null = null;

  constructor() {
    super({ id: 'digest', title: '5 Good Things', trackActivity: false });
    this.content.innerHTML = '<p class="digest-placeholder">Loading today\u2019s digest\u2026</p>';
  }

  public setStories(items: NewsItem[]): void {
    this.cleanupSummaryListener();
    this.pendingItems = [];

    const top5 = items.slice(0, 5);

    if (top5.length === 0) {
      this.content.innerHTML = '<p class="digest-placeholder">No stories available</p>';
      this.cardElements = [];
      return;
    }

    this.content.innerHTML = '';
    const list = document.createElement('div');
    list.className = 'digest-list';
    this.cardElements = [];

    for (let i = 0; i < top5.length; i++) {
      const item = top5[i]!;
      const card = document.createElement('div');
      card.className = 'digest-card';
      card.innerHTML = `
        <span class="digest-card-number">${i + 1}</span>
        <div class="digest-card-body">
          <a class="digest-card-title" href="${sanitizeUrl(item.link)}" target="_blank" rel="noopener">
            ${escapeHtml(item.title)}
          </a>
          <span class="digest-card-source">${escapeHtml(item.source)}</span>
          <p class="digest-card-summary digest-card-summary--loading">Summarizing\u2026</p>
        </div>
      `;
      list.appendChild(card);
      this.cardElements.push(card);
    }
    this.content.appendChild(list);

    for (let idx = 0; idx < top5.length; idx++) {
      const item = top5[idx]!;
      const result = generateSummary([item.title, item.source], undefined, item.locationName);
      if (result?.summary) {
        this.updateCardSummary(idx, result.summary);
      } else {
        this.pendingItems.push({ idx, item });
      }
    }

    if (this.pendingItems.length > 0) {
      this.summaryUpdateListener = () => this.retryPendingSummaries();
      document.addEventListener('wm:article-summaries-updated', this.summaryUpdateListener);
    }
  }

  private retryPendingSummaries(): void {
    const stillPending: Array<{ idx: number; item: NewsItem }> = [];
    for (const entry of this.pendingItems) {
      const result = generateSummary([entry.item.title, entry.item.source], undefined, entry.item.locationName);
      if (result?.summary) {
        this.updateCardSummary(entry.idx, result.summary);
      } else {
        stillPending.push(entry);
      }
    }
    this.pendingItems = stillPending;
    if (stillPending.length === 0) {
      this.cleanupSummaryListener();
    }
  }

  private updateCardSummary(idx: number, summary: string): void {
    const card = this.cardElements[idx];
    if (!card) return;
    const summaryEl = card.querySelector('.digest-card-summary');
    if (!summaryEl) return;
    summaryEl.textContent = summary;
    summaryEl.classList.remove('digest-card-summary--loading');
  }

  private cleanupSummaryListener(): void {
    if (this.summaryUpdateListener) {
      document.removeEventListener('wm:article-summaries-updated', this.summaryUpdateListener);
      this.summaryUpdateListener = null;
    }
  }

  public destroy(): void {
    this.cleanupSummaryListener();
    this.cardElements = [];
    this.pendingItems = [];
    super.destroy();
  }
}
