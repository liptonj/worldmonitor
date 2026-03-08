'use strict';

// Extracted from scripts/ais-relay.cjs - Technology events (Techmeme ICS + dev.events RSS + curated)

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const TIMEOUT_MS = 15_000;

const CITY_COORDS = {
  dubai: { lat: 25.2048, lng: 55.2708, country: 'UAE', virtual: false },
  'san francisco': { lat: 37.7749, lng: -122.4194, country: 'USA', virtual: false },
  'new york': { lat: 40.7128, lng: -74.006, country: 'USA', virtual: false },
  london: { lat: 51.5074, lng: -0.1278, country: 'UK', virtual: false },
  paris: { lat: 48.8566, lng: 2.3522, country: 'France', virtual: false },
  berlin: { lat: 52.52, lng: 13.405, country: 'Germany', virtual: false },
  amsterdam: { lat: 52.3676, lng: 4.9041, country: 'Netherlands', virtual: false },
  barcelona: { lat: 41.3851, lng: 2.1734, country: 'Spain', virtual: false },
  lisbon: { lat: 38.7223, lng: -9.1393, country: 'Portugal', virtual: false },
  toronto: { lat: 43.6532, lng: -79.3832, country: 'Canada', virtual: false },
  singapore: { lat: 1.3521, lng: 103.8198, country: 'Singapore', virtual: false },
  tokyo: { lat: 35.6762, lng: 139.6503, country: 'Japan', virtual: false },
  'tel aviv': { lat: 32.0853, lng: 34.7818, country: 'Israel', virtual: false },
  austin: { lat: 30.2672, lng: -97.7431, country: 'USA', virtual: false },
  'las vegas': { lat: 36.1699, lng: -115.1398, country: 'USA', virtual: false },
  online: { lat: 0, lng: 0, country: 'Virtual', virtual: true },
};

const CURATED_TECH_EVENTS = [
  { id: 'step-dubai-2026', title: 'STEP Dubai 2026', type: 'conference', location: 'Dubai Internet City, Dubai', coords: { lat: 25.0956, lng: 55.1548, country: 'UAE', original: 'Dubai Internet City, Dubai', virtual: false }, startDate: '2026-02-11', endDate: '2026-02-12', url: 'https://dubai.stepconference.com', source: 'curated', description: 'Intelligence Everywhere: The AI Economy - 8,000+ attendees, 400+ startups' },
  { id: 'gitex-global-2026', title: 'GITEX Global 2026', type: 'conference', location: 'Dubai World Trade Centre, Dubai', coords: { lat: 25.2285, lng: 55.2867, country: 'UAE', original: 'Dubai World Trade Centre, Dubai', virtual: false }, startDate: '2026-12-07', endDate: '2026-12-11', url: 'https://www.gitex.com', source: 'curated', description: "World's largest tech & startup show" },
  { id: 'token2049-dubai-2026', title: 'TOKEN2049 Dubai 2026', type: 'conference', location: 'Dubai, UAE', coords: { lat: 25.2048, lng: 55.2708, country: 'UAE', original: 'Dubai, UAE', virtual: false }, startDate: '2026-04-29', endDate: '2026-04-30', url: 'https://www.token2049.com', source: 'curated', description: 'Premier crypto event in Dubai' },
  { id: 'collision-2026', title: 'Collision 2026', type: 'conference', location: 'Toronto, Canada', coords: { lat: 43.6532, lng: -79.3832, country: 'Canada', original: 'Toronto, Canada', virtual: false }, startDate: '2026-06-22', endDate: '2026-06-25', url: 'https://collisionconf.com', source: 'curated', description: "North America's fastest growing tech conference" },
  { id: 'web-summit-2026', title: 'Web Summit 2026', type: 'conference', location: 'Lisbon, Portugal', coords: { lat: 38.7223, lng: -9.1393, country: 'Portugal', original: 'Lisbon, Portugal', virtual: false }, startDate: '2026-11-02', endDate: '2026-11-05', url: 'https://websummit.com', source: 'curated', description: "The world's premier tech conference" },
];

function normalizeLocation(loc) {
  if (!loc) return null;
  const n = loc.toLowerCase().trim().replace(/^hybrid:\s*/i, '');
  if (CITY_COORDS[n]) return { ...CITY_COORDS[n], original: loc };
  const parts = n.split(',');
  if (parts.length > 1 && CITY_COORDS[parts[0].trim()]) return { ...CITY_COORDS[parts[0].trim()], original: loc };
  for (const [key, c] of Object.entries(CITY_COORDS)) {
    if (n.includes(key) || key.includes(n)) return { ...c, original: loc };
  }
  return null;
}

function parseTechEventsICS(icsText) {
  const events = [];
  const blocks = (icsText || '').split('BEGIN:VEVENT').slice(1);
  for (const block of blocks) {
    const summary = block.match(/SUMMARY:(.+)/)?.[1]?.trim();
    const location = block.match(/LOCATION:(.+)/)?.[1]?.trim() || '';
    const dtstart = block.match(/DTSTART;VALUE=DATE:(\d+)/)?.[1];
    const dtend = block.match(/DTEND;VALUE=DATE:(\d+)/)?.[1];
    const url = block.match(/URL:(.+)/)?.[1]?.trim() || '';
    const uid = block.match(/UID:(.+)/)?.[1]?.trim() || '';
    if (!summary || !dtstart) continue;
    const startDate = `${dtstart.slice(0, 4)}-${dtstart.slice(4, 6)}-${dtstart.slice(6, 8)}`;
    const endDate = dtend ? `${dtend.slice(0, 4)}-${dtend.slice(4, 6)}-${dtend.slice(6, 8)}` : startDate;
    let type = 'other';
    if (summary.startsWith('Earnings:')) type = 'earnings';
    else if (summary.startsWith('IPO')) type = 'ipo';
    else if (location) type = 'conference';
    const coords = normalizeLocation(location || null);
    events.push({ id: uid, title: summary, type, location, coords: coords ?? undefined, startDate, endDate, url, source: 'techmeme', description: '' });
  }
  return events.sort((a, b) => a.startDate.localeCompare(b.startDate));
}

function parseDevEventsRSS(rssText) {
  const events = [];
  const itemMatches = (rssText || '').matchAll(/<item>([\s\S]*?)<\/item>/g);
  for (const match of itemMatches) {
    const item = match[1];
    const title = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/);
    const link = item.match(/<link>(.*?)<\/link>/)?.[1] ?? '';
    const desc = item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>|<description>(.*?)<\/description>/s);
    const guid = item.match(/<guid[^>]*>(.*?)<\/guid>/)?.[1] ?? '';
    const titleStr = title ? (title[1] ?? title[2]) : null;
    if (!titleStr) continue;
    const dateMatch = (desc?.[1] ?? desc?.[2] ?? '').match(/on\s+(\w+\s+\d{1,2},?\s+\d{4})/i);
    let startDate = null;
    if (dateMatch) {
      const d = new Date(dateMatch[1]);
      if (!isNaN(d.getTime())) startDate = d.toISOString().slice(0, 10);
    }
    if (!startDate) continue;
    const eventDate = new Date(startDate);
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    if (eventDate < now) continue;
    let location = null;
    const locMatch = (desc?.[1] ?? desc?.[2] ?? '').match(/(?:in|at)\s+([A-Za-z\s]+,\s*[A-Za-z\s]+)(?:\.|$)/i);
    if (locMatch) location = locMatch[1].trim();
    if ((desc?.[1] ?? desc?.[2] ?? '').toLowerCase().includes('online')) location = 'Online';
    const coords = location && location !== 'Online' ? normalizeLocation(location) : (location === 'Online' ? { lat: 0, lng: 0, country: 'Virtual', original: 'Online', virtual: true } : null);
    events.push({ id: guid || `dev-events-${titleStr.slice(0, 20)}`, title: titleStr, type: 'conference', location: location || '', coords: coords ?? undefined, startDate, endDate: startDate, url: link, source: 'dev.events', description: '' });
  }
  return events;
}

module.exports = async function fetchTechEvents({ config, redis, log, http }) {
  log.debug('fetchTechEvents executing');
  const timestamp = new Date().toISOString();

  try {
    const [icsRes, rssRes] = await Promise.allSettled([
      http.fetchText('https://www.techmeme.com/newsy_events.ics', {
        headers: { 'User-Agent': USER_AGENT },
        timeout: TIMEOUT_MS,
      }).catch(() => ''),
      http.fetchText('https://dev.events/rss.xml', {
        headers: { 'User-Agent': USER_AGENT },
        timeout: TIMEOUT_MS,
      }).catch(() => ''),
    ]);

    let events = [];
    if (icsRes.status === 'fulfilled' && icsRes.value) events.push(...parseTechEventsICS(icsRes.value));
    if (rssRes.status === 'fulfilled' && rssRes.value) events.push(...parseDevEventsRSS(rssRes.value));

    const now = new Date();
    now.setHours(0, 0, 0, 0);
    for (const c of CURATED_TECH_EVENTS) {
      if (new Date(c.startDate) >= now) events.push(c);
    }

    const seen = new Set();
    events = events.filter((e) => {
      const key = e.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30) + (e.startDate || '').slice(0, 4);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    events.sort((a, b) => (a.startDate || '').localeCompare(b.startDate || ''));

    const data = Array.isArray(events) ? events : [];
    return {
      timestamp,
      source: 'tech-events',
      data,
      status: 'success',
    };
  } catch (err) {
    log.error('fetchTechEvents error', { error: err?.message ?? err });
    return {
      timestamp,
      source: 'tech-events',
      data: [],
      status: 'error',
      errors: [err?.message ?? String(err)],
    };
  }
};
