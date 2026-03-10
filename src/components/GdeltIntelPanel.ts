import { Panel } from './Panel';
import { sanitizeUrl } from '@/utils/sanitize';
import { t } from '@/services/i18n';
import { h, replaceChildren } from '@/utils/dom-utils';
import {
  getIntelTopics,
  fetchTopicIntelligence,
  formatArticleDate,
  extractDomain,
  type GdeltArticle,
  type IntelTopic,
  type TopicIntelligence,
} from '@/services/gdelt-intel';

type RelayTopicCache = { articles: GdeltArticle[]; query: string; fetchedAt: string };

export class GdeltIntelPanel extends Panel {
  override readonly channelKeys = ['gdelt'];

  private activeTopic: IntelTopic = getIntelTopics()[0]!;
  private topicData = new Map<string, TopicIntelligence>();
  private tabsEl: HTMLElement | null = null;
  private _relayCache: Record<string, RelayTopicCache> | null = null;

  constructor() {
    super({
      id: 'gdelt-intel',
      title: t('panels.gdeltIntel'),
      showCount: true,
      trackActivity: true,
      infoTooltip: t('components.gdeltIntel.infoTooltip'),
    });
    this.createTabs();
    this.loadActiveTopic();
  }

  private createTabs(): void {
    this.tabsEl = h('div', { className: 'gdelt-intel-tabs' },
      ...getIntelTopics().map(topic =>
        h('button', {
          className: `gdelt-intel-tab ${topic.id === this.activeTopic.id ? 'active' : ''}`,
          dataset: { topicId: topic.id },
          title: topic.description,
          onClick: () => this.selectTopic(topic),
        },
          h('span', { className: 'tab-icon' }, topic.icon),
          h('span', { className: 'tab-label' }, topic.name),
        ),
      ),
    );

    this.element.insertBefore(this.tabsEl, this.content);
  }

  private selectTopic(topic: IntelTopic): void {
    if (topic.id === this.activeTopic.id) return;

    this.activeTopic = topic;

    this.tabsEl?.querySelectorAll('.gdelt-intel-tab').forEach(tab => {
      tab.classList.toggle('active', (tab as HTMLElement).dataset.topicId === topic.id);
    });

    const cached = this.topicData.get(topic.id);
    if (cached && Date.now() - cached.fetchedAt.getTime() < 5 * 60 * 1000) {
      this.renderArticles(cached.articles);
    } else {
      this.loadActiveTopic();
    }
  }

  public applyRelayData(payload: unknown): void {
    if (!payload || typeof payload !== 'object') {
      this.refresh();
      return;
    }
    const raw = payload as { data?: Record<string, RelayTopicCache> };
    if (!raw.data || typeof raw.data !== 'object') {
      this.refresh();
      return;
    }
    this._relayCache = raw.data;
    const topicData = this._relayCache[this.activeTopic.id];
    if (topicData && Array.isArray(topicData.articles)) {
      this.renderArticles(topicData.articles);
      this.setCount(topicData.articles.length);
    } else {
      this.refresh();
    }
  }

  private async loadActiveTopic(): Promise<void> {
    if (this._relayCache) {
      const cached = this._relayCache[this.activeTopic.id];
      if (cached && Array.isArray(cached.articles)) {
        this.renderArticles(cached.articles);
        this.setCount(cached.articles.length);
        return;
      }
    }

    this.showLoading();

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const data = await fetchTopicIntelligence(this.activeTopic);
        this.topicData.set(this.activeTopic.id, data);

        if (data.articles.length === 0 && attempt < 2) {
          this.showRetrying();
          await new Promise(r => setTimeout(r, 15_000));
          continue;
        }

        this.renderArticles(data.articles);
        this.setCount(data.articles.length);
        return;
      } catch (error) {
        if (this.isAbortError(error)) return;
        console.error(`[GdeltIntelPanel] Load error (attempt ${attempt + 1}):`, error);
        if (attempt < 2) {
          this.showRetrying();
          await new Promise(r => setTimeout(r, 15_000));
          continue;
        }
        this.showError(t('common.failedIntelFeed'));
      }
    }
  }

  private renderArticles(articles: GdeltArticle[]): void {
    if (articles.length === 0) {
      replaceChildren(this.content, h('div', { className: 'empty-state' }, t('components.gdelt.empty')));
      return;
    }

    replaceChildren(this.content,
      h('div', { className: 'gdelt-intel-articles' },
        ...articles.map(article => this.buildArticle(article)),
      ),
    );
  }

  private buildArticle(article: GdeltArticle): HTMLElement {
    const domain = article.source || extractDomain(article.url);
    const timeAgo = formatArticleDate(article.date);
    const toneClass = article.tone ? (article.tone < -2 ? 'tone-negative' : article.tone > 2 ? 'tone-positive' : '') : '';

    return h('a', {
      href: sanitizeUrl(article.url),
      target: '_blank',
      rel: 'noopener',
      className: `gdelt-intel-article ${toneClass}`.trim(),
    },
      h('div', { className: 'article-header' },
        h('span', { className: 'article-source' }, domain),
        h('span', { className: 'article-time' }, timeAgo),
      ),
      h('div', { className: 'article-title' }, article.title),
    );
  }

  public async refresh(): Promise<void> {
    await this.loadActiveTopic();
  }

  public async refreshAll(): Promise<void> {
    this.topicData.clear();
    await this.loadActiveTopic();
  }
}
