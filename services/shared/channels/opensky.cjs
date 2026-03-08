'use strict';

// Extracted from scripts/ais-relay.cjs - OpenSky Network aircraft tracking
// API: OpenSky Network (https://opensky-network.org/api/states/all)
// Anonymous access supported; optional bbox for regional fetch.

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const OPENSKY_TIMEOUT_MS = 15_000;

// Default bbox: Europe (lamin, lomin, lamax, lomax)
const DEFAULT_BBOX = [35, -10, 71, 40];

function parseBbox(bboxStr) {
  if (!bboxStr || typeof bboxStr !== 'string') return DEFAULT_BBOX;
  const parts = bboxStr.split(/[,\s]+/).map((p) => parseFloat(p.trim()));
  if (parts.length >= 4 && parts.every(Number.isFinite)) return parts;
  return DEFAULT_BBOX;
}

function transformState(s) {
  if (!Array.isArray(s) || s.length < 10) return null;
  const [icao24, callsign, originCountry, timePosition, lastContact, lon, lat, baroAltitude, onGround, velocity] = s;
  return {
    icao24: icao24 || '',
    callsign: (callsign || '').trim(),
    originCountry: originCountry || '',
    longitude: typeof lon === 'number' ? lon : null,
    latitude: typeof lat === 'number' ? lat : null,
    baroAltitude: typeof baroAltitude === 'number' ? baroAltitude : null,
    onGround: !!onGround,
    velocity: typeof velocity === 'number' ? velocity : null,
  };
}

module.exports = async function fetchOpensky({ config, redis, log, http }) {
  log.debug('fetchOpensky executing');
  const timestamp = new Date().toISOString();

  const bboxStr = config?.OPENSKY_BBOX || process.env.OPENSKY_BBOX;
  const [lamin, lomin, lamax, lomax] = parseBbox(bboxStr);

  let url = 'https://opensky-network.org/api/states/all';
  if (lamin != null && lomin != null && lamax != null && lomax != null) {
    url += `?lamin=${lamin}&lomin=${lomin}&lamax=${lamax}&lomax=${lomax}`;
  }

  try {
    const raw = await http.fetchJson(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      timeout: OPENSKY_TIMEOUT_MS,
    });

    const states = (raw?.states || []).map(transformState).filter(Boolean);

    return {
      timestamp,
      source: 'opensky',
      data: {
        time: raw?.time ?? Date.now(),
        states,
      },
      status: 'success',
    };
  } catch (err) {
    log.error('fetchOpensky error', { error: err?.message ?? err });
    return {
      timestamp,
      source: 'opensky',
      data: { time: Date.now(), states: [] },
      status: 'error',
      errors: [err?.message ?? String(err)],
    };
  }
};
