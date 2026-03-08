'use strict';

// Extracted from scripts/ais-relay.cjs - fetchAcledConflictEvents
// API: ACLED (Armed Conflict Location & Event Data Project)

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const PHASE3C_TIMEOUT_MS = 15_000;

module.exports = async function fetchConflict({ config, redis, log, http }) {
  log.debug('fetchConflict executing');
  const timestamp = new Date().toISOString();

  const token = config?.ACLED_ACCESS_TOKEN || process.env.ACLED_ACCESS_TOKEN;
  if (!token) {
    log.warn('fetchConflict: ACLED_ACCESS_TOKEN not set');
    return {
      timestamp,
      source: 'conflict',
      data: { events: [] },
      status: 'error',
      errors: ['ACLED_ACCESS_TOKEN not configured'],
    };
  }

  try {
    const endDate = new Date().toISOString().slice(0, 10);
    const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const params = new URLSearchParams({
      event_date: `${startDate}|${endDate}`,
      event_date_where: 'BETWEEN',
      limit: '500',
      _format: 'json',
    });
    const url = `https://acleddata.com/api/acled/read?${params}`;

    const data = await http.fetchJson(url, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'User-Agent': USER_AGENT,
      },
      timeout: PHASE3C_TIMEOUT_MS,
    });

    const events = (data?.data || []).map((e) => ({
      id: String(e.data_id || e.event_id_cnty || ''),
      eventType: (e.event_type || '').toLowerCase().replace(/\s+/g, '_'),
      subEventType: e.sub_event_type || '',
      country: e.country || '',
      admin1: e.admin1 || '',
      location: {
        latitude: parseFloat(e.latitude) || 0,
        longitude: parseFloat(e.longitude) || 0,
      },
      occurredAt: e.event_date ? new Date(e.event_date).getTime() : 0,
      fatalities: parseInt(e.fatalities, 10) || 0,
      actors: [e.actor1, e.actor2].filter(Boolean),
      source: e.source || 'ACLED',
    }));

    return {
      timestamp,
      source: 'conflict',
      data: { events },
      status: 'success',
    };
  } catch (err) {
    log.error('fetchConflict error', { error: err?.message ?? err });
    return {
      timestamp,
      source: 'conflict',
      data: { events: [] },
      status: 'error',
      errors: [err?.message ?? String(err)],
    };
  }
};
