/**
 * Sync data freshness enabled state with map layer toggles.
 * Moved from DataLoaderManager to satisfy "orchestrator only" spec.
 */

import type { MapLayers } from '@/types';
import { LAYER_TO_SOURCE } from '@/config';
import { dataFreshness, type DataSourceId } from '@/services/data-freshness';
import { isAisConfigured } from '@/services/maritime';
import { isOutagesConfigured } from '@/services/infrastructure';

export function syncDataFreshnessWithLayers(mapLayers: MapLayers): void {
  for (const [layer, sourceIds] of Object.entries(LAYER_TO_SOURCE)) {
    const enabled = mapLayers[layer as keyof MapLayers] ?? false;
    for (const sourceId of sourceIds) {
      dataFreshness.setEnabled(sourceId as DataSourceId, enabled);
    }
  }
  if (!isAisConfigured()) dataFreshness.setEnabled('ais', false);
  if (isOutagesConfigured() === false) dataFreshness.setEnabled('outages', false);
}
