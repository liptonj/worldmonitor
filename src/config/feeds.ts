// src/config/feeds.ts — DEPRECATED: all data now comes from Supabase via feed-client.ts
// This file re-exports the feed-client API for backward compatibility during transition.

export {
  getFeeds,
  getIntelSources,
  getSourceTier,
  getSourceType,
  getSourcePropagandaRisk,
  isStateAffiliatedSource,
  getSourcePanelId,
  computeDefaultDisabledSources,
  getTotalFeedCount,
  areFeedsLoaded,
  getSourceTiersMap,
  getSourceTypesMap,
  getLocaleBoostedSources,
  SOURCE_REGION_MAP,
  ALERT_KEYWORDS,
  ALERT_EXCLUSIONS,
  type SourceType,
  type PropagandaRisk,
  type SourceRiskProfile,
} from '@/services/feed-client';

// Static maps for variant configs (tech/finance) — seed data lives in feeds-seed.ts
export { SOURCE_TIERS, SOURCE_TYPES } from './feeds-seed';
