import {
  type CableHealthRecord as ProtoCableHealthRecord,
} from '@/generated/client/worldmonitor/infrastructure/v1/service_client';
import type { CableHealthRecord, CableHealthResponse, CableHealthStatus } from '@/types';
import { getHydratedData } from '@/services/bootstrap';

const STATUS_REVERSE: Record<string, CableHealthStatus> = {
  CABLE_HEALTH_STATUS_FAULT: 'fault',
  CABLE_HEALTH_STATUS_DEGRADED: 'degraded',
  CABLE_HEALTH_STATUS_OK: 'ok',
  CABLE_HEALTH_STATUS_UNSPECIFIED: 'unknown',
};

function toRecord(proto: ProtoCableHealthRecord): CableHealthRecord {
  return {
    status: STATUS_REVERSE[proto.status] || 'unknown',
    score: proto.score,
    confidence: proto.confidence,
    lastUpdated: proto.lastUpdated ? new Date(proto.lastUpdated).toISOString() : new Date().toISOString(),
    evidence: proto.evidence.map((e) => ({
      source: e.source,
      summary: e.summary,
      ts: e.ts ? new Date(e.ts).toISOString() : new Date().toISOString(),
    })),
  };
}

// ---- Local cache ----

let cachedResponse: CableHealthResponse | null = null;

// ---- Public API ----

export function fetchCableHealth(): CableHealthResponse {
  if (cachedResponse) return cachedResponse;
  const hydrated = getHydratedData('cables');
  const fromBootstrap = hydrated ? parseCableHealthPayload(hydrated) : null;
  if (fromBootstrap) cachedResponse = fromBootstrap;
  return fromBootstrap ?? { generatedAt: new Date().toISOString(), cables: {} };
}

export function getCableHealthRecord(cableId: string): CableHealthRecord | undefined {
  return cachedResponse?.cables[cableId];
}

export function getCableHealthMap(): Record<string, CableHealthRecord> {
  return cachedResponse?.cables ?? {};
}

export function setCableHealthCache(data: CableHealthResponse): void {
  cachedResponse = data;
}

/** Parse relay-push payload (raw API response) to CableHealthResponse. */
export function parseCableHealthPayload(payload: unknown): CableHealthResponse | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = payload as { cables?: Record<string, ProtoCableHealthRecord>; generatedAt?: number };
  if (!raw.cables || typeof raw.cables !== 'object') return null;
  const cables: Record<string, CableHealthRecord> = {};
  for (const [id, proto] of Object.entries(raw.cables)) {
    cables[id] = toRecord(proto);
  }
  return {
    generatedAt: raw.generatedAt ? new Date(raw.generatedAt).toISOString() : new Date().toISOString(),
    cables,
  };
}
