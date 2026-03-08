'use strict';

// Extracted from scripts/ais-relay.cjs - Supply chain chokepoint indicators
// API: NGA broadcast warnings (AIS disruptions from relay state not available in standalone)

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const NGA_URL = 'https://msi.nga.mil/api/publications/broadcast-warn?output=json&status=A';
const TIMEOUT_MS = 15_000;

const SUPPLY_CHAIN_CHOKEPOINTS = [
  { id: 'suez', name: 'Suez Canal', lat: 30.45, lon: 32.35, areaKeywords: ['suez', 'red sea'], routes: ['China-Europe (Suez)', 'Gulf-Europe Oil', 'Qatar LNG-Europe'] },
  { id: 'malacca', name: 'Malacca Strait', lat: 1.43, lon: 103.5, areaKeywords: ['malacca', 'singapore strait'], routes: ['China-Middle East Oil', 'China-Europe (via Suez)', 'Japan-Middle East Oil'] },
  { id: 'hormuz', name: 'Strait of Hormuz', lat: 26.56, lon: 56.25, areaKeywords: ['hormuz', 'persian gulf', 'arabian gulf'], routes: ['Gulf Oil Exports', 'Qatar LNG', 'Iran Exports'] },
  { id: 'bab_el_mandeb', name: 'Bab el-Mandeb', lat: 12.58, lon: 43.33, areaKeywords: ['bab el-mandeb', 'bab al-mandab', 'mandeb', 'aden'], routes: ['Suez-Indian Ocean', 'Gulf-Europe Oil', 'Red Sea Transit'] },
  { id: 'panama', name: 'Panama Canal', lat: 9.08, lon: -79.68, areaKeywords: ['panama'], routes: ['US East Coast-Asia', 'US East Coast-South America', 'Atlantic-Pacific Bulk'] },
  { id: 'taiwan', name: 'Taiwan Strait', lat: 24.0, lon: 119.5, areaKeywords: ['taiwan strait', 'formosa'], routes: ['China-Japan Trade', 'Korea-Southeast Asia', 'Pacific Semiconductor'] },
];
const SEVERITY_SCORE = { AIS_DISRUPTION_SEVERITY_LOW: 1, AIS_DISRUPTION_SEVERITY_ELEVATED: 2, AIS_DISRUPTION_SEVERITY_HIGH: 3 };

function computeDisruptionScore(warningCount, congestionSeverity) {
  return Math.min(100, warningCount * 15 + congestionSeverity * 30);
}
function scoreToStatus(score) {
  if (score < 20) return 'green';
  if (score < 50) return 'yellow';
  return 'red';
}

module.exports = async function fetchSupplyChain({ config, redis, log, http }) {
  log.debug('fetchSupplyChain executing');
  const timestamp = new Date().toISOString();

  let warnings = [];
  try {
    const data = await http.fetchJson(NGA_URL, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      timeout: TIMEOUT_MS,
    });
    const raw = Array.isArray(data) ? data : (data?.broadcast_warn ?? data?.warnings ?? []);
    warnings = raw.map((w) => ({
      id: `${w.navArea || ''}-${w.msgYear || ''}-${w.msgNumber || ''}`,
      text: w.text || '',
      area: `${w.navArea || ''}${w.subregion || ''}`,
    }));
  } catch (err) {
    log.warn('fetchSupplyChain NGA fetch failed', { error: err?.message ?? err });
  }

  const disruptions = [];
  const disruptionsMapped = disruptions.map((d) => ({
    ...d,
    type: d.type === 'chokepoint_congestion' ? 'AIS_DISRUPTION_TYPE_CHOKEPOINT_CONGESTION' : d.type,
    severity: d.severity === 'high' ? 'AIS_DISRUPTION_SEVERITY_HIGH' : d.severity === 'elevated' ? 'AIS_DISRUPTION_SEVERITY_ELEVATED' : d.severity === 'low' ? 'AIS_DISRUPTION_SEVERITY_LOW' : 'AIS_DISRUPTION_SEVERITY_UNSPECIFIED',
  }));

  const chokepoints = SUPPLY_CHAIN_CHOKEPOINTS.map((cp) => {
    const matchedWarnings = warnings.filter((w) => cp.areaKeywords.some((kw) => (w.text || '').toLowerCase().includes(kw) || (w.area || '').toLowerCase().includes(kw)));
    const matchedDisruptions = disruptionsMapped.filter((d) => d.type === 'AIS_DISRUPTION_TYPE_CHOKEPOINT_CONGESTION' && cp.areaKeywords.some((kw) => (d.region || '').toLowerCase().includes(kw) || (d.name || '').toLowerCase().includes(kw)));
    const maxSeverity = matchedDisruptions.reduce((max, d) => Math.max(max, SEVERITY_SCORE[d.severity] ?? 0), 0);
    const disruptionScore = computeDisruptionScore(matchedWarnings.length, maxSeverity);
    const status = scoreToStatus(disruptionScore);
    const congestionLevel = maxSeverity >= 3 ? 'high' : maxSeverity >= 2 ? 'elevated' : maxSeverity >= 1 ? 'low' : 'normal';
    const descriptions = [];
    if (matchedWarnings.length > 0) descriptions.push(`${matchedWarnings.length} active navigational warning(s)`);
    if (matchedDisruptions.length > 0) descriptions.push('AIS congestion detected');
    if (descriptions.length === 0) descriptions.push('No active disruptions');
    return { id: cp.id, name: cp.name, lat: cp.lat, lon: cp.lon, disruptionScore, status, activeWarnings: matchedWarnings.length, congestionLevel, affectedRoutes: cp.routes, description: descriptions.join('; ') };
  });

  const data = Array.isArray(chokepoints) ? chokepoints : [];
  return {
    timestamp,
    source: 'supply-chain',
    data,
    status: 'success',
  };
};
