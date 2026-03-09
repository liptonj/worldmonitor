/**
 * Shared types for domain handler modules.
 */

/** Handler for a single relay push channel. Receives payload, applies to context. */
export type ChannelHandler = (payload: unknown) => void;

/** Options passed when creating handlers that need callbacks beyond AppContext. */
export interface HandlerCallbacks {
  /** Called after news digest is fully processed (happy variant). */
  onNewsDigestProcessed?: () => void | Promise<void>;
  /** Called after predictions are rendered (for correlation analysis). */
  onPredictionsRendered?: () => void | Promise<void>;
  /** Called when natural/fires data is applied (for loadFirmsData cache). */
  onNaturalApplied?: (data: import('@/generated/client/worldmonitor/wildfire/v1/service_client').ListFireDetectionsResponse) => void;
}
