import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { t } from '@/services/i18n';

export class SummarizeViewModal {
  private element: HTMLElement;
  private contentEl: HTMLElement;
  private footerEl: HTMLElement;
  private closeBtn: HTMLButtonElement;
  private escHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') this.hide();
  };

  constructor() {
    this.element = document.createElement('div');
    this.element.className = 'summarize-view-modal-overlay';
    this.element.setAttribute('aria-modal', 'true');
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
    document.addEventListener('keydown', this.escHandler);
  }

  show(): void {
    if (!document.body.contains(this.element)) {
      document.body.appendChild(this.element);
    }
    this.element.classList.add('active');
    document.addEventListener('keydown', this.escHandler);
  }

  hide(): void {
    this.element.classList.remove('active');
    document.removeEventListener('keydown', this.escHandler);
  }

  setLoading(): void {
    this.contentEl.innerHTML = `<div class="summarize-view-loading">${t('modals.summarizeView.analyzing')}</div>`;
    this.footerEl.innerHTML = '';
  }

  setError(message: string): void {
    this.contentEl.innerHTML = `<div class="summarize-view-error">${message}</div>`;
    this.footerEl.innerHTML = '';
  }

  setEmpty(): void {
    this.contentEl.innerHTML = `<div class="summarize-view-empty">${t('modals.summarizeView.openPanelsFirst')}</div>`;
    this.footerEl.innerHTML = '';
  }

  async setContent(summary: string, model?: string, generatedAt?: string): Promise<void> {
    const html = DOMPurify.sanitize(await marked.parse(summary));
    const contentDiv = document.createElement('div');
    contentDiv.className = 'summarize-view-body';
    contentDiv.innerHTML = html;
    this.contentEl.innerHTML = '';
    this.contentEl.appendChild(contentDiv);

    const footerParts: string[] = [];
    if (model) footerParts.push(model);
    if (generatedAt) {
      const ts = new Date(generatedAt).toLocaleString();
      footerParts.push(ts);
    }
    this.footerEl.textContent = footerParts.join(' · ');
  }
}
