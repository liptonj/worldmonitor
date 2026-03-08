'use strict';

// Extracted from scripts/ais-relay.cjs - GPS interference/spoofing detection
// API: gpsjam.org H3 hex data

const USER_AGENT = 'Mozilla/5.0 (compatible; WorldMonitor/1.0)';
const MANIFEST_TIMEOUT_MS = 10_000;
const HEX_TIMEOUT_MS = 15_000;
const MIN_AIRCRAFT = 3;

module.exports = async function fetchGpsInterference({ config, redis, log, http }) {
  log.debug('fetchGpsInterference executing');
  const timestamp = new Date().toISOString();

  try {
    const manifest = await http.fetchText('https://gpsjam.org/data/manifest.csv', {
      headers: { 'User-Agent': USER_AGENT },
      timeout: MANIFEST_TIMEOUT_MS,
    });
    const lines = manifest.trim().split('\n');
    const latestDate = lines[lines.length - 1]?.split(',')[0];
    if (!latestDate) throw new Error('No manifest date');

    const csv = await http.fetchText(`https://gpsjam.org/data/${latestDate}-h3_4.csv`, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: HEX_TIMEOUT_MS,
    });
    const rows = csv.trim().split('\n');
    const hexes = [];
    for (let i = 1; i < rows.length; i++) {
      const parts = rows[i].split(',');
      if (parts.length < 3) continue;
      const hex = parts[0];
      const good = parseInt(parts[1], 10);
      const bad = parseInt(parts[2], 10);
      const total = good + bad;
      if (total < MIN_AIRCRAFT) continue;
      const pct = (bad / total) * 100;
      let level;
      if (pct > 10) level = 'high';
      else if (pct >= 2) level = 'medium';
      else continue;
      hexes.push({ h3: hex, pct: Math.round(pct * 10) / 10, good, bad, total, level });
    }
    hexes.sort((a, b) => {
      if (a.level !== b.level) return a.level === 'high' ? -1 : 1;
      return b.pct - a.pct;
    });

    const data = Array.isArray(hexes) ? hexes : [];
    return {
      timestamp,
      source: 'gps-interference',
      data,
      status: 'success',
    };
  } catch (err) {
    log.error('fetchGpsInterference error', { error: err?.message ?? err });
    return {
      timestamp,
      source: 'gps-interference',
      data: [],
      status: 'error',
      errors: [err?.message ?? String(err)],
    };
  }
};
