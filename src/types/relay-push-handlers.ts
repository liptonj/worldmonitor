/**
 * Interface for relay push data handlers.
 * Implemented by DataLoaderManager to process real-time relay updates.
 */
export interface RelayPushHandlers {
  applyNewsDigest(payload: unknown): void;
  applyMarkets(payload: unknown): void;
  applyPredictions(payload: unknown): void;
  applyFredData(payload: unknown): void;
  applyOilData(payload: unknown): void;
  applyBisData(payload: unknown): void;
  applyIntelligence(payload: unknown): void;
  applyPizzInt(payload: unknown): void;
  applyTradePolicy(payload: unknown): void;
  applySupplyChain(payload: unknown): void;
  applyNatural(payload: unknown): void;
  applyClimate(payload: unknown): void;
  applyConflict(payload: unknown): void;
  applyUcdpEvents(payload: unknown): void;
  applyCyberThreats(payload: unknown): void;
  applyAisSignals(payload: unknown): void;
  applyCableHealth(payload: unknown): void;
  applyFlightDelays(payload: unknown): void;
  applyWeatherAlerts(payload: unknown): void;
  applySpending(payload: unknown): void;
  applyGiving(payload: unknown): void;
  applyTelegramIntel(payload: unknown): void;
  applyOref(payload: unknown): void;
  applyIranEvents(payload: unknown): void;
  applyTechEvents(payload: unknown): void;
  applyGpsInterference(payload: unknown): void;
  applyGulfQuotes(payload: unknown): void;
  applyEonet(payload: unknown): void;
  applyGdacs(payload: unknown): void;
}
