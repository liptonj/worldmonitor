'use strict';

// Extracted from scripts/ais-relay.cjs - Flight tracking and delay anomalies
// APIs: FAA airport status, AviationStack (optional)

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const FAA_URL = 'https://nasstatus.faa.gov/api/airport-status-information';
const FAA_AIRPORTS = ['JFK', 'LAX', 'ORD', 'ATL', 'DFW', 'DEN', 'SFO', 'SEA', 'MIA', 'BOS', 'EWR', 'IAH', 'PHX', 'LAS'];
const FAA_TIMEOUT_MS = 15_000;
const AVIATIONSTACK_TIMEOUT_MS = 5_000;

const MONITORED_AIRPORTS = [
  { iata: 'JFK', icao: 'KJFK', name: 'John F. Kennedy International', city: 'New York', country: 'USA', lat: 40.6413, lon: -73.7781, region: 'americas' },
  { iata: 'LAX', icao: 'KLAX', name: 'Los Angeles International', city: 'Los Angeles', country: 'USA', lat: 33.9416, lon: -118.4085, region: 'americas' },
  { iata: 'ORD', icao: 'KORD', name: "O'Hare International", city: 'Chicago', country: 'USA', lat: 41.9742, lon: -87.9073, region: 'americas' },
  { iata: 'ATL', icao: 'KATL', name: 'Hartsfield-Jackson Atlanta', city: 'Atlanta', country: 'USA', lat: 33.6407, lon: -84.4277, region: 'americas' },
  { iata: 'DFW', icao: 'KDFW', name: 'Dallas/Fort Worth International', city: 'Dallas', country: 'USA', lat: 32.8998, lon: -97.0403, region: 'americas' },
  { iata: 'DEN', icao: 'KDEN', name: 'Denver International', city: 'Denver', country: 'USA', lat: 39.8561, lon: -104.6737, region: 'americas' },
  { iata: 'SFO', icao: 'KSFO', name: 'San Francisco International', city: 'San Francisco', country: 'USA', lat: 37.6213, lon: -122.379, region: 'americas' },
  { iata: 'SEA', icao: 'KSEA', name: 'Seattle-Tacoma International', city: 'Seattle', country: 'USA', lat: 47.4502, lon: -122.3088, region: 'americas' },
  { iata: 'MIA', icao: 'KMIA', name: 'Miami International', city: 'Miami', country: 'USA', lat: 25.7959, lon: -80.287, region: 'americas' },
  { iata: 'BOS', icao: 'KBOS', name: 'Boston Logan International', city: 'Boston', country: 'USA', lat: 42.3656, lon: -71.0096, region: 'americas' },
  { iata: 'EWR', icao: 'KEWR', name: 'Newark Liberty International', city: 'Newark', country: 'USA', lat: 40.6895, lon: -74.1745, region: 'americas' },
  { iata: 'IAH', icao: 'KIAH', name: 'George Bush Intercontinental', city: 'Houston', country: 'USA', lat: 29.9902, lon: -95.3368, region: 'americas' },
  { iata: 'PHX', icao: 'KPHX', name: 'Phoenix Sky Harbor', city: 'Phoenix', country: 'USA', lat: 33.4373, lon: -112.0078, region: 'americas' },
  { iata: 'LAS', icao: 'KLAS', name: 'Harry Reid International', city: 'Las Vegas', country: 'USA', lat: 36.084, lon: -115.1537, region: 'americas' },
  { iata: 'LHR', icao: 'EGLL', name: 'London Heathrow', city: 'London', country: 'UK', lat: 51.47, lon: -0.4543, region: 'europe' },
  { iata: 'CDG', icao: 'LFPG', name: 'Paris Charles de Gaulle', city: 'Paris', country: 'France', lat: 49.0097, lon: 2.5479, region: 'europe' },
  { iata: 'FRA', icao: 'EDDF', name: 'Frankfurt Airport', city: 'Frankfurt', country: 'Germany', lat: 50.0379, lon: 8.5622, region: 'europe' },
  { iata: 'DXB', icao: 'OMDB', name: 'Dubai International', city: 'Dubai', country: 'UAE', lat: 25.2532, lon: 55.3657, region: 'mena' },
  { iata: 'HND', icao: 'RJTT', name: 'Tokyo Haneda', city: 'Tokyo', country: 'Japan', lat: 35.5494, lon: 139.7798, region: 'apac' },
  { iata: 'SIN', icao: 'WSSS', name: 'Singapore Changi', city: 'Singapore', country: 'Singapore', lat: 1.3644, lon: 103.9915, region: 'apac' },
];

function toProtoRegion(r) {
  const map = { americas: 'AIRPORT_REGION_AMERICAS', europe: 'AIRPORT_REGION_EUROPE', apac: 'AIRPORT_REGION_APAC', mena: 'AIRPORT_REGION_MENA', africa: 'AIRPORT_REGION_AFRICA' };
  return map[r] || 'AIRPORT_REGION_UNSPECIFIED';
}
function toProtoDelayType(t) {
  const map = { ground_stop: 'FLIGHT_DELAY_TYPE_GROUND_STOP', ground_delay: 'FLIGHT_DELAY_TYPE_GROUND_DELAY', departure_delay: 'FLIGHT_DELAY_TYPE_DEPARTURE_DELAY', arrival_delay: 'FLIGHT_DELAY_TYPE_ARRIVAL_DELAY', general: 'FLIGHT_DELAY_TYPE_GENERAL', closure: 'FLIGHT_DELAY_TYPE_CLOSURE' };
  return map[t] || 'FLIGHT_DELAY_TYPE_GENERAL';
}
function toProtoSeverity(s) {
  const map = { normal: 'FLIGHT_DELAY_SEVERITY_NORMAL', minor: 'FLIGHT_DELAY_SEVERITY_MINOR', moderate: 'FLIGHT_DELAY_SEVERITY_MODERATE', major: 'FLIGHT_DELAY_SEVERITY_MAJOR', severe: 'FLIGHT_DELAY_SEVERITY_SEVERE' };
  return map[s] || 'FLIGHT_DELAY_SEVERITY_NORMAL';
}
function determineSeverity(avgDelay) {
  if (avgDelay >= 60) return 'severe';
  if (avgDelay >= 45) return 'major';
  if (avgDelay >= 30) return 'moderate';
  if (avgDelay >= 15) return 'minor';
  return 'normal';
}
function parseFaaXml(xml) {
  const delays = new Map();
  let root;
  try {
    const m = xml.match(/<AIRPORT_STATUS_INFORMATION[^>]*>([\s\S]*?)<\/AIRPORT_STATUS_INFORMATION>/);
    if (!m) return delays;
    root = m[1];
  } catch { return delays; }
  const groundDelayRe = /<Ground_Delay>[\s\S]*?<ARPT>([A-Z]{3})<\/ARPT>[\s\S]*?<Reason>([^<]*)<\/Reason>[\s\S]*?<Avg>(\d*)<\/Avg>/g;
  let gd;
  while ((gd = groundDelayRe.exec(root)) !== null) {
    delays.set(gd[1], { airport: gd[1], reason: gd[2] || 'Ground delay', avgDelay: parseInt(gd[3], 10) || 30, type: 'ground_delay' });
  }
  const groundStopRe = /<Ground_Stop>[\s\S]*?<ARPT>([A-Z]{3})<\/ARPT>[\s\S]*?<Reason>([^<]*)<\/Reason>/g;
  let gs;
  while ((gs = groundStopRe.exec(root)) !== null) {
    delays.set(gs[1], { airport: gs[1], reason: gs[2] || 'Ground stop', avgDelay: 60, type: 'ground_stop' });
  }
  const delayRe = /<Delay>[\s\S]*?<ARPT>([A-Z]{3})<\/ARPT>[\s\S]*?<Reason>([^<]*)<\/Reason>[\s\S]*?<Arrival_Delay>[\s\S]*?<Min>(\d*)<\/Min>[\s\S]*?<Max>(\d*)<\/Max>/g;
  let d;
  while ((d = delayRe.exec(root)) !== null) {
    const min = parseInt(d[3], 10) || 15;
    const max = parseInt(d[4], 10) || 30;
    if (!delays.has(d[1])) delays.set(d[1], { airport: d[1], reason: d[2] || 'Delays', avgDelay: Math.round((min + max) / 2), type: 'general' });
  }
  return delays;
}

module.exports = async function fetchFlights({ config, redis, log, http }) {
  log.debug('fetchFlights executing');
  const timestamp = new Date().toISOString();

  try {
    const faaAlerts = [];
    const faaXml = await http.fetchText(FAA_URL, {
      headers: { Accept: 'application/xml', 'User-Agent': USER_AGENT },
      timeout: FAA_TIMEOUT_MS,
    }).catch(() => '');
    const faaDelays = faaXml ? parseFaaXml(faaXml) : new Map();

    for (const iata of FAA_AIRPORTS) {
      const airport = MONITORED_AIRPORTS.find((a) => a.iata === iata);
      if (!airport) continue;
      const d = faaDelays.get(iata);
      if (d) {
        faaAlerts.push({
          id: `faa-${iata}`,
          iata,
          icao: airport.icao,
          name: airport.name,
          city: airport.city,
          country: airport.country,
          location: { latitude: airport.lat, longitude: airport.lon },
          region: toProtoRegion(airport.region),
          delayType: toProtoDelayType(d.type),
          severity: toProtoSeverity(determineSeverity(d.avgDelay)),
          avgDelayMinutes: d.avgDelay,
          delayedFlightsPct: 0,
          cancelledFlights: 0,
          totalFlights: 0,
          reason: d.reason,
          source: 'FLIGHT_DELAY_SOURCE_FAA',
          updatedAt: Date.now(),
        });
      }
    }

    const apiKey = config?.AVIATIONSTACK_API_KEY || config?.AVIATIONSTACK_API || process.env.AVIATIONSTACK_API_KEY || process.env.AVIATIONSTACK_API;
    let intlAlerts = [];
    if (apiKey) {
      const nonUs = MONITORED_AIRPORTS.filter((a) => a.country !== 'USA');
      for (const airport of nonUs.slice(0, 10)) {
        try {
          const url = `https://api.aviationstack.com/v1/flights?access_key=${apiKey}&dep_iata=${airport.iata}&limit=50`;
          const json = await http.fetchJson(url, { headers: { 'User-Agent': USER_AGENT }, timeout: AVIATIONSTACK_TIMEOUT_MS });
          if (json?.error) continue;
          const flights = json?.data ?? [];
          let delayed = 0, cancelled = 0, totalDelay = 0;
          for (const f of flights) {
            if (f.flight_status === 'cancelled') cancelled++;
            if (f.departure?.delay && f.departure.delay > 0) { delayed++; totalDelay += f.departure.delay; }
          }
          const total = flights.length;
          if (total < 5) continue;
          const cancelledPct = (cancelled / total) * 100;
          const avgDelay = delayed > 0 ? Math.round(totalDelay / delayed) : 0;
          let severity = 'normal', reason = 'Normal operations';
          if (cancelledPct >= 50 && total >= 10) { severity = 'major'; reason = `${Math.round(cancelledPct)}% flights cancelled`; }
          else if (cancelledPct >= 20 && total >= 10) { severity = 'moderate'; reason = `${Math.round(cancelledPct)}% flights cancelled`; }
          else if (avgDelay > 0) { severity = determineSeverity(avgDelay); reason = `Avg ${avgDelay}min delay`; }
          if (severity === 'normal') continue;
          intlAlerts.push({
            id: `avstack-${airport.iata}`,
            iata: airport.iata,
            icao: airport.icao,
            name: airport.name,
            city: airport.city,
            country: airport.country,
            location: { latitude: airport.lat, longitude: airport.lon },
            region: toProtoRegion(airport.region),
            delayType: toProtoDelayType(avgDelay >= 60 ? 'ground_delay' : 'general'),
            severity: toProtoSeverity(severity),
            avgDelayMinutes: avgDelay,
            delayedFlightsPct: Math.round((delayed / total) * 100),
            cancelledFlights: cancelled,
            totalFlights: total,
            reason,
            source: 'FLIGHT_DELAY_SOURCE_COMPUTED',
            updatedAt: Date.now(),
          });
        } catch { /* skip airport on error */ }
      }
    }

    const allAlerts = [...faaAlerts, ...intlAlerts];
    const alertedIatas = new Set(allAlerts.map((a) => a.iata));
    for (const airport of MONITORED_AIRPORTS) {
      if (!alertedIatas.has(airport.iata)) {
        allAlerts.push({
          id: `status-${airport.iata}`,
          iata: airport.iata,
          icao: airport.icao,
          name: airport.name,
          city: airport.city,
          country: airport.country,
          location: { latitude: airport.lat, longitude: airport.lon },
          region: toProtoRegion(airport.region),
          delayType: 'FLIGHT_DELAY_TYPE_GENERAL',
          severity: 'FLIGHT_DELAY_SEVERITY_NORMAL',
          avgDelayMinutes: 0,
          delayedFlightsPct: 0,
          cancelledFlights: 0,
          totalFlights: 0,
          reason: 'Normal operations',
          source: 'FLIGHT_DELAY_SOURCE_COMPUTED',
          updatedAt: Date.now(),
        });
      }
    }

    const data = Array.isArray(allAlerts) ? allAlerts : [];
    return {
      timestamp,
      source: 'flights',
      data,
      status: 'success',
    };
  } catch (err) {
    log.error('fetchFlights error', { error: err?.message ?? err });
    return {
      timestamp,
      source: 'flights',
      data: [],
      status: 'error',
      errors: [err?.message ?? String(err)],
    };
  }
};
