import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';
import { type ClimateAnomaly, getSeverityIcon, formatDelta } from '@/services/climate';
import { t } from '@/services/i18n';
import { convertTemp, getTempUnitLabel, convertPrecip, getPrecipUnitLabel } from '@/utils/display-prefs';

export class ClimateAnomalyPanel extends Panel {
  private anomalies: ClimateAnomaly[] = [];
  private onZoneClick?: (lat: number, lon: number) => void;

  private displayPrefsHandler = (): void => {
    this.renderContent();
  };

  constructor() {
    super({
      id: 'climate',
      title: t('panels.climate'),
      showCount: true,
      trackActivity: true,
      infoTooltip: t('components.climate.infoTooltip'),
    });
    this.showLoading(t('common.loadingClimateData'));
    window.addEventListener('display-prefs-changed', this.displayPrefsHandler);
  }

  public setZoneClickHandler(handler: (lat: number, lon: number) => void): void {
    this.onZoneClick = handler;
  }

  public setAnomalies(anomalies: ClimateAnomaly[]): void {
    this.anomalies = anomalies;
    this.setCount(anomalies.length);
    this.renderContent();
  }

  private renderContent(): void {
    if (this.anomalies.length === 0) {
      this.setContent(`<div class="panel-empty">${t('components.climate.noAnomalies')}</div>`);
      return;
    }

    const sorted = [...this.anomalies].sort((a, b) => {
      const severityOrder = { extreme: 0, moderate: 1, normal: 2 };
      return (severityOrder[a.severity] || 2) - (severityOrder[b.severity] || 2);
    });

    const rows = sorted.map(a => {
      const icon = getSeverityIcon(a);
      const tempClass = a.tempDelta > 0 ? 'climate-warm' : 'climate-cold';
      const precipClass = a.precipDelta > 0 ? 'climate-wet' : 'climate-dry';
      const sevClass = `severity-${a.severity}`;
      const rowClass = a.severity === 'extreme' ? ' climate-extreme-row' : '';

      return `<tr class="climate-row${rowClass}" data-lat="${a.lat}" data-lon="${a.lon}">
        <td class="climate-zone"><span class="climate-icon">${icon}</span>${escapeHtml(a.zone)}</td>
        <td class="climate-num ${tempClass}">${formatDelta(convertTemp(a.tempDelta), getTempUnitLabel())}</td>
        <td class="climate-num ${precipClass}">${formatDelta(convertPrecip(a.precipDelta), getPrecipUnitLabel())}</td>
        <td><span class="climate-badge ${sevClass}">${t(`components.climate.severity.${a.severity}`)}</span></td>
      </tr>`;
    }).join('');

    this.setContent(`
      <div class="climate-panel-content">
        <table class="climate-table">
          <thead>
            <tr>
              <th>${t('components.climate.zone')}</th>
              <th>${t('components.climate.temp')}</th>
              <th>${t('components.climate.precip')}</th>
              <th>${t('components.climate.severityLabel')}</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `);

    this.content.querySelectorAll('.climate-row').forEach(el => {
      el.addEventListener('click', () => {
        const lat = Number((el as HTMLElement).dataset.lat);
        const lon = Number((el as HTMLElement).dataset.lon);
        if (Number.isFinite(lat) && Number.isFinite(lon)) this.onZoneClick?.(lat, lon);
      });
    });
  }

  public destroy(): void {
    window.removeEventListener('display-prefs-changed', this.displayPrefsHandler);
    super.destroy();
  }
}
