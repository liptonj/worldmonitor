'use strict';

// Extracted from scripts/ais-relay.cjs - NASA FIRMS fire detections
// API: NASA FIRMS (Fire Information for Resource Management System)

const TIMEOUT_MS = 15_000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

const FIRMS_SOURCE = 'VIIRS_SNPP_NRT';
const MONITORED_REGIONS = {
  Ukraine: '22,44,40,53',
  Russia: '20,50,180,82',
  Iran: '44,25,63,40',
  'Israel/Gaza': '34,29,36,34',
  Syria: '35,32,42,37',
  Taiwan: '119,21,123,26',
  'North Korea': '124,37,131,43',
  'Saudi Arabia': '34,16,56,32',
  Turkey: '26,36,45,42',
};

function mapFireConfidence(c) {
  const v = (c || '').toLowerCase();
  if (v === 'h') return 'FIRE_CONFIDENCE_HIGH';
  if (v === 'n') return 'FIRE_CONFIDENCE_NOMINAL';
  if (v === 'l') return 'FIRE_CONFIDENCE_LOW';
  return 'FIRE_CONFIDENCE_UNSPECIFIED';
}

function parseFirmsCsv(csv) {
  if (typeof csv !== 'string') return [];
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',').map((v) => v.trim());
    if (vals.length < headers.length) continue;
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = vals[idx];
    });
    rows.push(row);
  }
  return rows;
}

function parseDetectedAt(acqDate, acqTime) {
  const padded = String(acqTime || '').padStart(4, '0');
  return new Date(`${acqDate || '1970-01-01'}T${padded.slice(0, 2)}:${padded.slice(2)}:00Z`).getTime();
}

module.exports = async function fetchNatural({ config, redis, log, http }) {
  log.debug('fetchNatural executing');
  const timestamp = new Date().toISOString();

  const apiKey = config?.NASA_FIRMS_API_KEY || config?.FIRMS_API_KEY || process.env.NASA_FIRMS_API_KEY || process.env.FIRMS_API_KEY;
  if (!apiKey) {
    log.warn('fetchNatural: NASA_FIRMS_API_KEY not set');
    return {
      timestamp,
      source: 'natural',
      data: { fireDetections: [], pagination: undefined },
      status: 'error',
      errors: ['NASA_FIRMS_API_KEY not configured'],
    };
  }

  try {
    const entries = Object.entries(MONITORED_REGIONS);
    const results = await Promise.allSettled(
      entries.map(async ([regionName, bbox]) => {
        const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${apiKey}/${FIRMS_SOURCE}/${bbox}/1`;
        const csv = await http.fetchText(url, {
          headers: { Accept: 'text/csv', 'User-Agent': USER_AGENT },
          timeout: TIMEOUT_MS,
        });
        const rows = parseFirmsCsv(csv);
        return { regionName, rows };
      })
    );

    const allRejected = results.every((r) => r.status === 'rejected');
    if (allRejected) {
      const firstReason = results.find((r) => r.status === 'rejected')?.reason;
      throw firstReason || new Error('All FIRMS region fetches failed');
    }

    const fireDetections = [];
    for (const r of results) {
      if (r.status === 'fulfilled') {
        const { regionName, rows } = r.value;
        for (const row of rows) {
          fireDetections.push({
            id: `${row.latitude ?? ''}-${row.longitude ?? ''}-${row.acq_date ?? ''}-${row.acq_time ?? ''}`,
            location: {
              latitude: parseFloat(row.latitude ?? '0') || 0,
              longitude: parseFloat(row.longitude ?? '0') || 0,
            },
            brightness: parseFloat(row.bright_ti4 ?? '0') || 0,
            frp: parseFloat(row.frp ?? '0') || 0,
            confidence: mapFireConfidence(row.confidence),
            satellite: row.satellite || '',
            detectedAt: parseDetectedAt(row.acq_date, row.acq_time),
            region: regionName,
            dayNight: row.daynight || '',
          });
        }
      }
    }

    return {
      timestamp,
      source: 'natural',
      data: { fireDetections, pagination: undefined },
      status: 'success',
    };
  } catch (err) {
    log.error('fetchNatural error', { error: err?.message ?? err });
    return {
      timestamp,
      source: 'natural',
      data: { fireDetections: [], pagination: undefined },
      status: 'error',
      errors: [err?.message ?? String(err)],
    };
  }
};
