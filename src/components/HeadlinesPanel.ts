import { Panel } from './Panel';
import { h, text } from '@/utils/dom-utils';
import { t } from '@/services/i18n';
import { SITE_VARIANT } from '@/config';
import type { NewsItem } from '@/types';

const MAX_ITEMS = 50;
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

export class HeadlinesPanel extends Panel {
  override readonly channelKeys = SITE_VARIANT === 'tech' ? ['news:tech'] : ['news:full'];

  private seenKeys = new Set<string>();
  private items: NewsItem[] = [];

  constructor() {
    super({
      id: 'headlines',
      title: t('panels.headlines'),
      showCount: true,
      trackActivity: true,
    });
    this.showLoading();
  }

  renderItems(allNews: NewsItem[]): void {
    const cutoff = Date.now() - DEDUP_WINDOW_MS;
    this.seenKeys.clear();
    this.items = [];

    const sorted = allNews
      .filter(item => item.pubDate.getTime() > cutoff)
      .sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());

    for (const item of sorted) {
      const key = item.link || item.title;
      if (this.seenKeys.has(key)) continue;
      this.seenKeys.add(key);
      this.items.push(item);
      if (this.items.length >= MAX_ITEMS) break;
    }

    this.setCount(this.items.length);
    this.renderList();
  }

  private renderList(): void {
    if (this.items.length === 0) {
      const empty = h('div', { className: 'panel-empty' });
      empty.appendChild(text(t('common.noDataShort')));
      this.content.replaceChildren(empty);
      return;
    }

    const list = h('div', { className: 'headlines-list' });

    for (const item of this.items) {
      const ago = this.timeAgo(item.pubDate);

      const row = h('div', { className: 'headline-row' });

      const meta = h('div', { className: 'headline-meta' });
      if (item.source) {
        const badge = h('span', { className: 'headline-source' });
        badge.appendChild(text(item.source));
        meta.appendChild(badge);
      }
      const timeEl = h('span', { className: 'headline-time' });
      timeEl.appendChild(text(ago));
      meta.appendChild(timeEl);
      row.appendChild(meta);

      if (item.link) {
        const link = h('a', {
          className: 'headline-title',
          href: item.link,
          target: '_blank',
          rel: 'noopener noreferrer',
        });
        link.appendChild(text(item.title));
        row.appendChild(link);
      } else {
        const span = h('span', { className: 'headline-title' });
        span.appendChild(text(item.title));
        row.appendChild(span);
      }

      list.appendChild(row);
    }

    this.content.replaceChildren(list);
  }

  private timeAgo(date: Date): string {
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }
}
