/**
 * Domain handlers for relay push channels.
 * Each module exports create*Handlers(ctx) returning Record<channel, handler>.
 */

export { createNewsHandlers } from './news-handler';
export { createMarketsHandlers } from './markets-handler';
export { createEconomicHandlers } from './economic-handler';
export { createIntelligenceHandlers } from './intelligence-handler';
export { createGeoHandlers } from './geo-handler';
export { createInfrastructureHandlers } from './infrastructure-handler';
export { createAiHandlers } from './ai-handler';
export { createConfigHandlers } from './config-handler';
export type { ChannelHandler, HandlerCallbacks } from './types';
