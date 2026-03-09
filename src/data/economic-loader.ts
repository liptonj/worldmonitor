/**
 * Economic domain loader — loadGiving.
 */

import type { DataLoaderBridge } from './loader-bridge';
import { fetchGivingSummary } from '@/services/giving';
import { dataFreshness } from '@/services/data-freshness';

export const economicLoader = {
  async loadGiving(bridge: DataLoaderBridge): Promise<void> {
    try {
      const result = await fetchGivingSummary();
      if (result.ok && result.data) {
        bridge.getHandler('giving')?.(result.data);
      }
    } catch (error) {
      console.error('[App] Giving summary fetch failed:', error);
      dataFreshness.recordError('giving', String(error));
    }
  },
};
