'use strict';

// Extracted from scripts/ais-relay.cjs - Undersea cable monitoring
// API: NGA broadcast warnings

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const NGA_URL = 'https://msi.nga.mil/api/publications/broadcast-warn?output=json&status=A';
const TIMEOUT_MS = 10_000;

const CABLE_KEYWORDS = ['CABLE', 'CABLESHIP', 'CABLE SHIP', 'CABLE LAYING', 'CABLE OPERATIONS', 'SUBMARINE CABLE', 'UNDERSEA CABLE', 'FIBER OPTIC', 'TELECOMMUNICATIONS CABLE'];
const FAULT_KEYWORDS = /FAULT|BREAK|CUT|DAMAGE|SEVERED|RUPTURE|OUTAGE|FAILURE/i;
const CABLE_NAME_MAP = { 'MAREA': 'marea', 'GRACE HOPPER': 'grace_hopper', 'HAVFRUE': 'havfrue', 'FASTER': 'faster', 'SOUTHERN CROSS': 'southern_cross', 'CURIE': 'curie', 'SEA-ME-WE': 'seamewe6', 'SEAMEWE': 'seamewe6', 'SMW6': 'seamewe6', 'FLAG': 'flag', '2AFRICA': '2africa', 'WACS': 'wacs', 'EASSY': 'eassy', 'SAM-1': 'sam1', 'SAM1': 'sam1', 'ELLALINK': 'ellalink', 'APG': 'apg', 'INDIGO': 'indigo', 'SJC': 'sjc', 'FARICE': 'farice', 'FALCON': 'falcon' };
const CABLE_LANDINGS = {
  marea: [[36.85, -75.98], [43.26, -2.93]],
  grace_hopper: [[40.57, -73.97], [50.83, -4.55], [43.26, -2.93]],
  havfrue: [[40.22, -74.01], [58.15, 8.0], [55.56, 8.13]],
  faster: [[43.37, -124.22], [34.95, 139.95], [34.32, 136.85]],
  southern_cross: [[-33.87, 151.21], [-36.85, 174.76], [33.74, -118.27]],
  curie: [[33.74, -118.27], [-33.05, -71.62]],
  seamewe6: [[1.35, 103.82], [19.08, 72.88], [25.13, 56.34], [21.49, 39.19], [29.97, 32.55], [43.3, 5.37]],
  flag: [[50.04, -5.66], [31.2, 29.92], [25.2, 55.27], [19.08, 72.88], [1.35, 103.82], [35.69, 139.69]],
  '2africa': [[50.83, -4.55], [38.72, -9.14], [14.69, -17.44], [6.52, 3.38], [-33.93, 18.42], [-4.04, 39.67], [21.49, 39.19], [31.26, 32.3]],
  wacs: [[-33.93, 18.42], [6.52, 3.38], [14.69, -17.44], [38.72, -9.14], [51.51, -0.13]],
  eassy: [[-29.85, 31.02], [-25.97, 32.58], [-6.8, 39.28], [-4.04, 39.67], [11.59, 43.15]],
  sam1: [[-22.91, -43.17], [-34.6, -58.38], [26.36, -80.08]],
  ellalink: [[38.72, -9.14], [-3.72, -38.52]],
  apg: [[35.69, 139.69], [25.15, 121.44], [22.29, 114.17], [1.35, 103.82]],
  indigo: [[-31.95, 115.86], [1.35, 103.82], [-6.21, 106.85]],
  sjc: [[35.69, 139.69], [36.07, 120.32], [1.35, 103.82], [22.29, 114.17]],
  farice: [[64.13, -21.9], [62.01, -6.77], [55.95, -3.19]],
  falcon: [[25.13, 56.34], [23.59, 58.38], [26.23, 50.59], [29.38, 47.98]],
};
const MONTH_MAP = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

function isCableRelated(text) {
  return CABLE_KEYWORDS.some((kw) => (text || '').toUpperCase().includes(kw));
}

function parseCoordinates(text) {
  const coords = [];
  const dms = /(\d{1,3})-(\d{1,2}(?:\.\d+)?)\s*([NS])\s+(\d{1,3})-(\d{1,2}(?:\.\d+)?)\s*([EW])/gi;
  let m;
  while ((m = dms.exec(text)) !== null) {
    let lat = parseInt(m[1], 10) + parseFloat(m[2]) / 60;
    let lon = parseInt(m[4], 10) + parseFloat(m[5]) / 60;
    if (m[3].toUpperCase() === 'S') lat = -lat;
    if (m[6].toUpperCase() === 'W') lon = -lon;
    if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) coords.push([lat, lon]);
  }
  return coords;
}

function matchCableByName(text) {
  const upper = (text || '').toUpperCase();
  for (const [name, id] of Object.entries(CABLE_NAME_MAP)) {
    if (upper.includes(name)) return id;
  }
  return null;
}

function findNearestCable(lat, lon) {
  let bestId = null;
  let bestDist = Infinity;
  const MAX_DIST_KM = 555;
  const cosLat = Math.cos(lat * Math.PI / 180);
  for (const [cableId, landings] of Object.entries(CABLE_LANDINGS)) {
    for (const [lLat, lLon] of landings) {
      const dLat = (lat - lLat) * 111;
      const dLon = (lon - lLon) * 111 * cosLat;
      const distKm = Math.sqrt(dLat ** 2 + dLon ** 2);
      if (distKm < bestDist && distKm < MAX_DIST_KM) {
        bestDist = distKm;
        bestId = cableId;
      }
    }
  }
  return bestId ? { cableId: bestId, distanceKm: bestDist } : null;
}

function parseIssueDate(dateStr) {
  const m = (dateStr || '').match(/(\d{2})(\d{4})Z\s+([A-Z]{3})\s+(\d{4})/i);
  if (!m) return 0;
  const d = new Date(Date.UTC(parseInt(m[4], 10), MONTH_MAP[m[3].toUpperCase()] ?? 0, parseInt(m[1], 10), parseInt(m[2].slice(0, 2), 10), parseInt(m[2].slice(2, 4), 10)));
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

function processNgaSignals(warnings) {
  const signals = [];
  const cableWarnings = (warnings || []).filter((w) => isCableRelated(w.text || ''));
  for (const warning of cableWarnings) {
    const text = warning.text || '';
    const ts = parseIssueDate(warning.issueDate);
    const coords = parseCoordinates(text);
    let cableId = matchCableByName(text);
    let joinMethod = 'name';
    let distanceKm = 0;
    if (!cableId && coords.length > 0) {
      const centLat = coords.reduce((s, c) => s + c[0], 0) / coords.length;
      const centLon = coords.reduce((s, c) => s + c[1], 0) / coords.length;
      const nearest = findNearestCable(centLat, centLon);
      if (nearest) { cableId = nearest.cableId; joinMethod = 'geometry'; distanceKm = Math.round(nearest.distanceKm); }
    }
    if (!cableId) continue;
    const isFault = FAULT_KEYWORDS.test(text);
    const summaryText = text.slice(0, 150) + (text.length > 150 ? '...' : '');
    if (isFault) {
      signals.push({ cableId, ts, severity: 1.0, confidence: joinMethod === 'name' ? 0.9 : Math.max(0.4, 0.8 - distanceKm / 500), ttlSeconds: 5 * 86400, kind: 'operator_fault', evidence: [{ source: 'NGA', summary: `Fault/damage: ${summaryText}`, ts }] });
    } else {
      signals.push({ cableId, ts, severity: 0.6, confidence: joinMethod === 'name' ? 0.8 : Math.max(0.3, 0.7 - distanceKm / 500), ttlSeconds: 3 * 86400, kind: 'cable_advisory', evidence: [{ source: 'NGA', summary: `Advisory: ${summaryText}`, ts }] });
    }
  }
  return signals;
}

function computeHealthMap(signals) {
  const now = Date.now();
  const byCable = {};
  for (const sig of signals) {
    if (!byCable[sig.cableId]) byCable[sig.cableId] = [];
    byCable[sig.cableId].push(sig);
  }
  const healthMap = {};
  for (const [cableId, cableSignals] of Object.entries(byCable)) {
    const effectiveSignals = [];
    for (const sig of cableSignals) {
      const ageMs = now - sig.ts;
      const recencyWeight = Math.max(0, Math.min(1, 1 - (ageMs / 1000) / sig.ttlSeconds));
      if (recencyWeight <= 0) continue;
      const effective = sig.severity * sig.confidence * recencyWeight;
      effectiveSignals.push({ ...sig, effective, recencyWeight });
    }
    if (effectiveSignals.length === 0) continue;
    effectiveSignals.sort((a, b) => b.effective - a.effective);
    const top = effectiveSignals[0];
    const hasOperatorFault = effectiveSignals.some((s) => s.kind === 'operator_fault' && s.effective >= 0.5);
    const hasRepairActivity = effectiveSignals.some((s) => s.kind === 'repair_activity' && s.effective >= 0.4);
    let status;
    if (top.effective >= 0.8 && hasOperatorFault) status = 'CABLE_HEALTH_STATUS_FAULT';
    else if (top.effective >= 0.8 && hasRepairActivity) status = 'CABLE_HEALTH_STATUS_DEGRADED';
    else if (top.effective >= 0.5) status = 'CABLE_HEALTH_STATUS_DEGRADED';
    else status = 'CABLE_HEALTH_STATUS_OK';
    healthMap[cableId] = {
      status,
      score: Math.round(top.effective * 100) / 100,
      confidence: Math.round(top.confidence * top.recencyWeight * 100) / 100,
      lastUpdated: top.ts,
      evidence: effectiveSignals.slice(0, 3).flatMap((s) => s.evidence).slice(0, 3),
    };
  }
  return healthMap;
}

module.exports = async function fetchCables({ config, redis, log, http }) {
  log.debug('fetchCables executing');
  const timestamp = new Date().toISOString();

  try {
    const data = await http.fetchJson(NGA_URL, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: TIMEOUT_MS,
    });
    const raw = Array.isArray(data) ? data : data?.warnings ?? data?.broadcast_warn ?? [];
    const warnings = raw.map((w) => ({ text: w.text || w.message || '', issueDate: w.issueDate || w.issue_date || w.msgDate || '' }));
    const signals = processNgaSignals(warnings);
    const cables = computeHealthMap(signals);
    const dataArray = Object.entries(cables).map(([id, h]) => ({ id, ...h }));
    const out = Array.isArray(dataArray) ? dataArray : [];
    return {
      timestamp,
      source: 'cables',
      data: out,
      status: 'success',
    };
  } catch (err) {
    log.error('fetchCables error', { error: err?.message ?? err });
    return {
      timestamp,
      source: 'cables',
      data: [],
      status: 'error',
      errors: [err?.message ?? String(err)],
    };
  }
};
