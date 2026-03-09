/**
 * @deprecated Handlers are no longer methods on DataLoaderManager.
 * Use DataLoaderManager.getHandler(channel) to obtain a handler for a given channel.
 * Domain handlers live in src/data/*-handler.ts modules.
 */
export interface RelayPushHandlers {
  /** @deprecated Use getHandler('news:full') etc. */
  applyNewsDigest(payload: unknown): void;
  /** @deprecated Use getHandler('markets') */
  applyMarkets(payload: unknown): void;
  /** @deprecated Use getHandler('predictions') */
  applyPredictions(payload: unknown): void;
  /** @deprecated Use getHandler('fred') */
  applyFredData(payload: unknown): void;
  /** @deprecated Use getHandler('oil') */
  applyOilData(payload: unknown): void;
  /** @deprecated Use getHandler('bis') */
  applyBisData(payload: unknown): void;
  /** @deprecated Use getHandler('intelligence') */
  applyIntelligence(payload: unknown): void;
  /** @deprecated Use getHandler('pizzint') */
  applyPizzInt(payload: unknown): void;
  /** @deprecated Use getHandler('trade') */
  applyTradePolicy(payload: unknown): void;
  /** @deprecated Use getHandler('supply-chain') */
  applySupplyChain(payload: unknown): void;
  /** @deprecated Use getHandler('natural') */
  applyNatural(payload: unknown): void;
  /** @deprecated Use getHandler('climate') */
  applyClimate(payload: unknown): void;
  /** @deprecated Use getHandler('conflict') */
  applyConflict(payload: unknown): void;
  /** @deprecated Use getHandler('ucdp-events') */
  applyUcdpEvents(payload: unknown): void;
  /** @deprecated Use getHandler('cyber') */
  applyCyberThreats(payload: unknown): void;
  /** @deprecated Use getHandler('ais') */
  applyAisSignals(payload: unknown): void;
  /** @deprecated Use getHandler('cables') */
  applyCableHealth(payload: unknown): void;
  /** @deprecated Use getHandler('flights') */
  applyFlightDelays(payload: unknown): void;
  /** @deprecated Use getHandler('weather') */
  applyWeatherAlerts(payload: unknown): void;
  /** @deprecated Use getHandler('spending') */
  applySpending(payload: unknown): void;
  /** @deprecated Use getHandler('giving') */
  applyGiving(payload: unknown): void;
  /** @deprecated Use getHandler('telegram') */
  applyTelegramIntel(payload: unknown): void;
  /** @deprecated Use getHandler('oref') */
  applyOref(payload: unknown): void;
  /** @deprecated Use getHandler('iran-events') */
  applyIranEvents(payload: unknown): void;
  /** @deprecated Use getHandler('tech-events') */
  applyTechEvents(payload: unknown): void;
  /** @deprecated Use getHandler('gps-interference') */
  applyGpsInterference(payload: unknown): void;
  /** @deprecated Use getHandler('gulf-quotes') */
  applyGulfQuotes(payload: unknown): void;
  /** @deprecated Use getHandler('eonet') */
  applyEonet(payload: unknown): void;
  /** @deprecated Use getHandler('gdacs') */
  applyGdacs(payload: unknown): void;
}
