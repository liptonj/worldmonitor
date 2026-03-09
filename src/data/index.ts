/**
 * Domain handlers for relay push channels.
 * Each module exports create*Handlers(ctx) returning Record<channel, handler>.
 * Domain loaders export load* methods for DataLoaderManager delegation.
 */

export { createNewsHandlers } from './news-handler';
export { newsLoader } from './news-loader';
export { marketsLoader } from './markets-loader';
export { geoLoader } from './geo-loader';
export { intelligenceLoader } from './intelligence-loader';
export { infrastructureLoader } from './infrastructure-loader';
export { economicLoader } from './economic-loader';
export type { DataLoaderBridge } from './loader-bridge';
export { createMarketsHandlers } from './markets-handler';
export { createEconomicHandlers } from './economic-handler';
export { createIntelligenceHandlers } from './intelligence-handler';
export { createGeoHandlers } from './geo-handler';
export { createInfrastructureHandlers } from './infrastructure-handler';
export { createAiHandlers } from './ai-handler';
export { createConfigHandlers } from './config-handler';
export type { ChannelHandler, HandlerCallbacks } from './types';
