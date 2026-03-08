'use strict';

// Extracted from scripts/ais-relay.cjs - military/strategic postures
// Fetches from OpenSky (via relay or direct) and computes theater posture levels

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const POSTURE_TIMEOUT_MS = 15_000;

const THEATER_QUERY_REGIONS = [
  { name: 'WESTERN', lamin: 10, lamax: 66, lomin: 9, lomax: 66 },
  { name: 'PACIFIC', lamin: 4, lamax: 44, lomin: 104, lomax: 133 },
];

const POSTURE_THEATERS = [
  { id: 'baltic', bounds: { north: 66, south: 54, east: 30, west: 9 }, thresholds: { critical: 15, elevated: 8 }, strikeIndicators: { minTankers: 2, minAwacs: 1, minFighters: 4 } },
  { id: 'eastern_med', bounds: { north: 42, south: 30, east: 40, west: 18 }, thresholds: { critical: 12, elevated: 6 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 } },
  { id: 'persian_gulf', bounds: { north: 30, south: 24, east: 60, west: 48 }, thresholds: { critical: 10, elevated: 5 }, strikeIndicators: { minTankers: 1, minAwacs: 0, minFighters: 2 } },
  { id: 'red_sea', bounds: { north: 30, south: 12, east: 44, west: 32 }, thresholds: { critical: 8, elevated: 4 }, strikeIndicators: { minTankers: 1, minAwacs: 0, minFighters: 2 } },
  { id: 'scs', bounds: { north: 25, south: 4, east: 122, west: 104 }, thresholds: { critical: 12, elevated: 6 }, strikeIndicators: { minTankers: 2, minAwacs: 1, minFighters: 4 } },
  { id: 'korea', bounds: { north: 44, south: 33, east: 133, west: 124 }, thresholds: { critical: 10, elevated: 5 }, strikeIndicators: { minTankers: 2, minAwacs: 1, minFighters: 4 } },
];

function isMilitaryCallsign(cs) {
  const c = (cs || '').trim().toUpperCase();
  return /^(RCH|EVAC|VALOR|SPAR|NAF|REACH|DUKE|VIPER|BLUE|COBRA|SNAKE|HAWK|EAGLE|WOLF|TIGER|BONE|HAMMER|SABRE|STRIKE|WILD|BULL|VIP|AF\d|NAVY|NAVY\d|MARINE|ARMY|ARMY\d)\d*$/.test(c) || /^[A-Z]{2}\d{2,}$/.test(c);
}

function isMilitaryHex(icao) {
  const h = (icao || '').toUpperCase();
  return /^[0-9A-F]{6}$/.test(h) && (h.startsWith('AE') || h.startsWith('AD') || h.startsWith('AC') || h.startsWith('43') || h.startsWith('48') || h.startsWith('39'));
}

module.exports = async function fetchStrategicPosture({ config, redis, log, http }) {
  log.debug('fetchStrategicPosture executing');
  const timestamp = new Date().toISOString();

  const relayBase = config?.WS_RELAY_URL || process.env.WS_RELAY_URL;
  const openskyBase = relayBase ? relayBase.replace(/^wss?:\/\//, 'https://').replace(/\/$/, '') : 'https://opensky-network.org/api/states/all';
  const openskyUrl = relayBase ? `${openskyBase}/opensky` : 'https://opensky-network.org/api/states/all';

  const headers = { Accept: 'application/json', 'User-Agent': USER_AGENT };
  const sharedSecret = config?.RELAY_SHARED_SECRET || process.env.RELAY_SHARED_SECRET;
  if (sharedSecret) {
    const authHeader = (config?.RELAY_AUTH_HEADER || process.env.RELAY_AUTH_HEADER || 'x-relay-key').toLowerCase();
    headers[authHeader] = sharedSecret;
    headers.Authorization = `Bearer ${sharedSecret}`;
  }

  let flights = [];
  let anySuccess = false;
  for (const region of THEATER_QUERY_REGIONS) {
    const params = `lamin=${region.lamin}&lamax=${region.lamax}&lomin=${region.lomin}&lomax=${region.lomax}`;
    const url = `${openskyUrl}?${params}`;
    try {
      const data = await http.fetchJson(url, {
        headers,
        timeout: POSTURE_TIMEOUT_MS,
      });
      anySuccess = true;
      const states = data?.states || [];
      for (const s of states) {
        const [icao24, callsign, , , , lon, lat, altitude, onGround, velocity, heading] = s;
        if (lat == null || lon == null || onGround) continue;
        if (!isMilitaryCallsign(callsign) && !isMilitaryHex(icao24)) continue;
        flights.push({
          id: icao24,
          callsign: (callsign || '').trim(),
          lat,
          lon,
          altitude: altitude ?? 0,
          heading: heading ?? 0,
          speed: velocity ?? 0,
        });
      }
    } catch (err) {
      log.warn('fetchStrategicPosture region fetch failed', { region: region.name, error: err?.message });
    }
  }

  if (!anySuccess && flights.length === 0) {
    return {
      timestamp,
      source: 'strategic-posture',
      data: { theaters: [] },
      status: 'error',
      errors: ['All OpenSky region fetches failed'],
    };
  }

  const seen = new Set();
  flights = flights.filter((f) => !seen.has(f.id) && seen.add(f.id));

  const theaters = POSTURE_THEATERS.map((t) => {
    const theaterFlights = flights.filter(
      (f) => f.lat >= t.bounds.south && f.lat <= t.bounds.north && f.lon >= t.bounds.west && f.lon <= t.bounds.east
    );
    const total = theaterFlights.length;
    const byType = { tankers: 0, awacs: 0, fighters: 0 };
    for (const f of theaterFlights) {
      const c = (f.callsign || '').toUpperCase();
      if (/RCH|TANK|KC|KC\d/.test(c)) byType.tankers++;
      else if (/E3|AWACS|E-\d/.test(c)) byType.awacs++;
      else byType.fighters++;
    }
    const postureLevel = total >= t.thresholds.critical ? 'critical' : total >= t.thresholds.elevated ? 'elevated' : 'normal';
    const strikeCapable =
      byType.tankers >= t.strikeIndicators.minTankers &&
      byType.awacs >= t.strikeIndicators.minAwacs &&
      byType.fighters >= t.strikeIndicators.minFighters;
    const ops = [];
    if (strikeCapable) ops.push('strike_capable');
    if (byType.tankers > 0) ops.push('aerial_refueling');
    if (byType.awacs > 0) ops.push('airborne_early_warning');
    return {
      theater: t.id,
      postureLevel,
      activeFlights: total,
      trackedVessels: 0,
      activeOperations: ops,
      assessedAt: Date.now(),
    };
  });

  return {
    timestamp,
    source: 'strategic-posture',
    data: { theaters },
    status: 'success',
  };
};
