import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { t } from '@/services/i18n';

const PROGRESS_STEPS = [
  { delay: 0, text: 'Collecting panel data…' },
  { delay: 3_000, text: 'Connecting to AI model…' },
  { delay: 8_000, text: 'Generating summary…' },
  { delay: 18_000, text: 'Almost there…' },
];

export class SummarizeViewModal {
  private element: HTMLElement;
  private contentEl: HTMLElement;
  private footerEl: HTMLElement;
  private closeBtn: HTMLButtonElement;
  private progressTimers: ReturnType<typeof setTimeout>[] = [];
  private elapsedTimer: ReturnType<typeof setInterval> | null = null;
  private escHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') this.hide();
  };

  constructor() {
    this.element = document.createElement('div');
    this.element.className = 'summarize-view-modal-overlay';
    this.element.setAttribute('aria-modal', 'true');
    this.element.setAttribute('role', 'dialog');
    this.element.setAttribute('aria-label', t('modals.summarizeView.title'));

    this.element.innerHTML = `
      <div class="summarize-view-modal">
        <div class="summarize-view-modal-header">
          <span class="summarize-view-modal-title">✨ ${t('modals.summarizeView.title')}</span>
          <button type="button" class="summarize-view-modal-close" aria-label="${t('modals.summarizeView.close')}">×</button>
        </div>
        <div class="summarize-view-modal-content"></div>
        <div class="summarize-view-modal-footer"></div>
      </div>
    `;

    this.contentEl = this.element.querySelector('.summarize-view-modal-content') as HTMLElement;
    this.footerEl = this.element.querySelector('.summarize-view-modal-footer') as HTMLElement;
    this.closeBtn = this.element.querySelector('.summarize-view-modal-close') as HTMLButtonElement;

    this.closeBtn.addEventListener('click', () => this.hide());
    this.element.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).classList.contains('summarize-view-modal-overlay')) {
        this.hide();
      }
    });
  }

  show(): void {
    if (!document.body.contains(this.element)) {
      document.body.appendChild(this.element);
    }
    this.element.classList.add('active');
    document.addEventListener('keydown', this.escHandler);
  }

  showRelayData(): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cached = (window as any).__wmLatestPanelSummary as { summary?: string; approach?: string; generatedAt?: string } | undefined;
    if (cached?.summary) {
      void this.setContent(cached.summary, cached.approach, cached.generatedAt);
      return;
    }

    this.showWaiting();

    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ summary?: string; approach?: string; generatedAt?: string }>).detail;
      if (detail?.summary) {
        void this.setContent(detail.summary, detail.approach, detail.generatedAt);
        document.removeEventListener('wm:panel-summary-updated', handler);
      }
    };
    document.addEventListener('wm:panel-summary-updated', handler);
  }

  private showWaiting(): void {
    this.clearProgress();
    this.contentEl.innerHTML = `<div class="summarize-view-loading"><div class="summarize-view-status">AI summary is being prepared\u2026</div></div>`;
    this.footerEl.innerHTML = '';
  }

  hide(): void {
    this.element.classList.remove('active');
    document.removeEventListener('keydown', this.escHandler);
    this.clearProgress();
  }

  setLoading(): void {
    this.clearProgress();
    this.contentEl.innerHTML = `
      <div class="summarize-view-loading">
        <div class="summarize-view-spinner"></div>
        <div class="summarize-view-status">${PROGRESS_STEPS[0]?.text ?? ''}</div>
        <div class="summarize-view-elapsed"></div>
      </div>
    `;
    this.footerEl.innerHTML = '';

    const statusEl = this.contentEl.querySelector('.summarize-view-status') as HTMLElement;
    const elapsedEl = this.contentEl.querySelector('.summarize-view-elapsed') as HTMLElement;
    const startTime = Date.now();

    for (const step of PROGRESS_STEPS) {
      if (step.delay === 0) continue;
      const timer = setTimeout(() => {
        if (statusEl) statusEl.textContent = step.text;
      }, step.delay);
      this.progressTimers.push(timer);
    }

    this.elapsedTimer = setInterval(() => {
      const secs = Math.floor((Date.now() - startTime) / 1000);
      if (elapsedEl) elapsedEl.textContent = `${secs}s`;
    }, 1000);
  }

  updateStatus(text: string): void {
    const statusEl = this.contentEl.querySelector('.summarize-view-status');
    if (statusEl) statusEl.textContent = text;
  }

  setError(message: string): void {
    this.clearProgress();
    this.contentEl.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'summarize-view-error';
    div.textContent = message;
    this.contentEl.appendChild(div);
    this.footerEl.innerHTML = '';
  }

  setEmpty(): void {
    this.clearProgress();
    this.contentEl.innerHTML = `<div class="summarize-view-empty">${t('modals.summarizeView.openPanelsFirst')}</div>`;
    this.footerEl.innerHTML = '';
  }

  async setContent(summary: string, model?: string, generatedAt?: string): Promise<void> {
    this.clearProgress();
    const html = DOMPurify.sanitize(await marked.parse(summary));
    const contentDiv = document.createElement('div');
    contentDiv.className = 'summarize-view-body';
    contentDiv.innerHTML = html;
    this.contentEl.innerHTML = '';
    this.contentEl.appendChild(contentDiv);
    this.setFooter(model, generatedAt);
  }

  startStreaming(): void {
    this.clearProgress();
    this.contentEl.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'summarize-view-body summarize-view-streaming';
    this.contentEl.appendChild(div);
    this.footerEl.innerHTML = '';
  }

  appendStreamChunk(text: string): void {
    const div = this.contentEl.querySelector('.summarize-view-streaming');
    if (div) div.textContent += text;
  }

  async finalizeStream(model?: string, generatedAt?: string): Promise<void> {
    const div = this.contentEl.querySelector('.summarize-view-streaming');
    if (!div) return;
    const raw = div.textContent ?? '';
    const html = DOMPurify.sanitize(await marked.parse(raw));
    div.innerHTML = html;
    div.classList.remove('summarize-view-streaming');
    this.setFooter(model, generatedAt);
  }

  private setFooter(model?: string, generatedAt?: string): void {
    const parts: string[] = [];
    if (model) parts.push(model);
    if (generatedAt) {
      const ts = new Date(generatedAt).toLocaleString();
      parts.push(ts);
    }
    this.footerEl.textContent = parts.join(' · ');
  }

  private clearProgress(): void {
    for (const t of this.progressTimers) clearTimeout(t);
    this.progressTimers = [];
    if (this.elapsedTimer) {
      clearInterval(this.elapsedTimer);
      this.elapsedTimer = null;
    }
  }
}
