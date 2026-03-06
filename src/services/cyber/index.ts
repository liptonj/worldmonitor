import {
  type CyberThreat as ProtoCyberThreat,
  type ListCyberThreatsResponse,
} from '@/generated/client/worldmonitor/cyber/v1/service_client';
import type {
  CyberThreat,
  CyberThreatType,
  CyberThreatSource,
  CyberThreatSeverity,
  CyberThreatIndicatorType,
} from '@/types';
import { getHydratedData } from '@/services/bootstrap';

// ---- Proto enum -> legacy string adapters ----

const THREAT_TYPE_REVERSE: Record<string, CyberThreatType> = {
  CYBER_THREAT_TYPE_C2_SERVER: 'c2_server',
  CYBER_THREAT_TYPE_MALWARE_HOST: 'malware_host',
  CYBER_THREAT_TYPE_PHISHING: 'phishing',
  CYBER_THREAT_TYPE_MALICIOUS_URL: 'malicious_url',
};

const SOURCE_REVERSE: Record<string, CyberThreatSource> = {
  CYBER_THREAT_SOURCE_FEODO: 'feodo',
  CYBER_THREAT_SOURCE_URLHAUS: 'urlhaus',
  CYBER_THREAT_SOURCE_C2INTEL: 'c2intel',
  CYBER_THREAT_SOURCE_OTX: 'otx',
  CYBER_THREAT_SOURCE_ABUSEIPDB: 'abuseipdb',
};

const INDICATOR_TYPE_REVERSE: Record<string, CyberThreatIndicatorType> = {
  CYBER_THREAT_INDICATOR_TYPE_IP: 'ip',
  CYBER_THREAT_INDICATOR_TYPE_DOMAIN: 'domain',
  CYBER_THREAT_INDICATOR_TYPE_URL: 'url',
};

const SEVERITY_REVERSE: Record<string, CyberThreatSeverity> = {
  CRITICALITY_LEVEL_LOW: 'low',
  CRITICALITY_LEVEL_MEDIUM: 'medium',
  CRITICALITY_LEVEL_HIGH: 'high',
  CRITICALITY_LEVEL_CRITICAL: 'critical',
};

// ---- Adapter: proto CyberThreat -> legacy CyberThreat ----

function toCyberThreat(proto: ProtoCyberThreat): CyberThreat {
  return {
    id: proto.id,
    type: THREAT_TYPE_REVERSE[proto.type] || 'malicious_url',
    source: SOURCE_REVERSE[proto.source] || 'feodo',
    indicator: proto.indicator,
    indicatorType: INDICATOR_TYPE_REVERSE[proto.indicatorType] || 'ip',
    lat: proto.location?.latitude ?? 0,
    lon: proto.location?.longitude ?? 0,
    country: proto.country || undefined,
    severity: SEVERITY_REVERSE[proto.severity] || 'low',
    malwareFamily: proto.malwareFamily || undefined,
    tags: proto.tags,
    firstSeen: proto.firstSeenAt ? new Date(proto.firstSeenAt).toISOString() : undefined,
    lastSeen: proto.lastSeenAt ? new Date(proto.lastSeenAt).toISOString() : undefined,
  };
}

// ---- Exported Functions ----

export function fetchCyberThreats(_options: { limit?: number; days?: number } = {}): CyberThreat[] {
  const hydrated = getHydratedData('cyber') as ListCyberThreatsResponse | undefined;
  return hydrated?.threats?.map(toCyberThreat) ?? [];
}

/** Convert proto ListCyberThreatsResponse to client CyberThreat[]. Used by applyCyberThreats WS handler. */
export function adaptCyberThreatsResponse(resp: ListCyberThreatsResponse): CyberThreat[] {
  return (resp.threats ?? []).map(toCyberThreat);
}
