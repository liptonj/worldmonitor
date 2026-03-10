/**
 * Config domain handler — config:news-sources, config:feature-flags.
 * ctx is unused; kept for consistency with other create*Handlers(ctx) signatures.
 */

import type { AppContext } from '@/app/app-context';
import { applyNewsSources } from '@/services/feed-client';
import { applyFeatureFlags } from '@/services/feature-flag-client';
import type { ChannelHandler } from './types';

export function createConfigHandlers(_ctx: AppContext): Record<string, ChannelHandler> {
  return {
    'config:news-sources': (payload) => {
      if (!payload) { console.warn('[wm:config:news-sources] null/undefined payload'); return; }
      applyNewsSources(payload);
    },
    'config:feature-flags': (payload) => {
      if (!payload) { console.warn('[wm:config:feature-flags] null/undefined payload'); return; }
      applyFeatureFlags(payload);
    },
  };
}
