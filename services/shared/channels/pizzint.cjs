'use strict';

// Extracted from scripts/ais-relay.cjs - PIZZINT intelligence feeds (dashboard + GDELT tension pairs)
// APIs: pizzint.watch dashboard-data, pizzint.watch gdelt batch

const PIZZINT_API = 'https://www.pizzint.watch/api/dashboard-data';
const GDELT_URL = 'https://www.pizzint.watch/api/gdelt/batch?pairs=usa_russia,russia_ukraine,usa_china,china_taiwan,usa_iran,usa_venezuela&method=gpr';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const TIMEOUT_MS = 15_000;

module.exports = async function fetchPizzint({ config, redis, log, http }) {
  log.debug('fetchPizzint executing');
  const timestamp = new Date().toISOString();

  try {
    const raw = await http.fetchJson(PIZZINT_API, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      timeout: TIMEOUT_MS,
    });

    if (!raw?.success || !raw?.data) {
      return {
        timestamp,
        source: 'pizzint',
        data: { pizzint: null, tensionPairs: [] },
        status: 'error',
        errors: ['PIZZINT API returned invalid or empty response'],
      };
    }
    if (!Array.isArray(raw.data)) {
      return {
        timestamp,
        source: 'pizzint',
        data: { pizzint: null, tensionPairs: [] },
        status: 'error',
        errors: ['PIZZINT API data must be array'],
      };
    }

    const locs = raw.data.map((d) => ({
      placeId: d.place_id,
      name: d.name,
      address: d.address,
      currentPopularity: d.current_popularity,
      percentageOfUsual: d.percentage_of_usual ?? 0,
      isSpike: d.is_spike,
      spikeMagnitude: d.spike_magnitude ?? 0,
      dataSource: d.data_source,
      recordedAt: d.recorded_at,
      dataFreshness: d.data_freshness === 'fresh' ? 'DATA_FRESHNESS_FRESH' : 'DATA_FRESHNESS_STALE',
      isClosedNow: d.is_closed_now ?? false,
      lat: d.lat ?? 0,
      lng: d.lng ?? 0,
    }));
    const openLocs = locs.filter((l) => !l.isClosedNow);
    const activeSpikes = locs.filter((l) => l.isSpike).length;
    const avgPop = openLocs.length > 0 ? openLocs.reduce((s, l) => s + l.currentPopularity, 0) / openLocs.length : 0;
    let adjusted = avgPop + activeSpikes * 10;
    adjusted = Math.min(100, adjusted);
    let defconLevel = 5;
    let defconLabel = 'Normal Activity';
    if (adjusted >= 85) {
      defconLevel = 1;
      defconLabel = 'Maximum Activity';
    } else if (adjusted >= 70) {
      defconLevel = 2;
      defconLabel = 'High Activity';
    } else if (adjusted >= 50) {
      defconLevel = 3;
      defconLabel = 'Elevated Activity';
    } else if (adjusted >= 25) {
      defconLevel = 4;
      defconLabel = 'Above Normal';
    }
    const hasFresh = locs.some((l) => l.dataFreshness === 'DATA_FRESHNESS_FRESH');
    const pizzint = {
      defconLevel,
      defconLabel,
      aggregateActivity: Math.round(avgPop),
      activeSpikes,
      locationsMonitored: locs.length,
      locationsOpen: openLocs.length,
      updatedAt: Date.now(),
      dataFreshness: hasFresh ? 'DATA_FRESHNESS_FRESH' : 'DATA_FRESHNESS_STALE',
      locations: locs,
    };

    let tensionPairs = [];
    try {
      const gRaw = await http.fetchJson(GDELT_URL, {
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
        timeout: TIMEOUT_MS,
      });
      if (gRaw && typeof gRaw === 'object') {
        tensionPairs = Object.entries(gRaw).map(([pairKey, dataPoints]) => {
          const countries = pairKey.split('_');
          const arr = Array.isArray(dataPoints) ? dataPoints : [];
          const latest = arr[arr.length - 1];
          const prev = arr.length > 1 ? arr[arr.length - 2] : latest;
          const change = prev?.v > 0 ? ((latest?.v ?? 0) - prev.v) / prev.v * 100 : 0;
          const trend = change > 5 ? 'TREND_DIRECTION_RISING' : change < -5 ? 'TREND_DIRECTION_FALLING' : 'TREND_DIRECTION_STABLE';
          return {
            id: pairKey,
            countries,
            label: countries.map((c) => c.toUpperCase()).join(' - '),
            score: latest?.v ?? 0,
            trend,
            changePercent: Math.round(change * 10) / 10,
            region: 'global',
          };
        });
      }
    } catch {
      /* GDELT optional, continue with empty tensionPairs */
    }

    return {
      timestamp,
      source: 'pizzint',
      data: { pizzint, tensionPairs },
      status: 'success',
    };
  } catch (err) {
    log.error('fetchPizzint error', { error: err?.message ?? err });
    return {
      timestamp,
      source: 'pizzint',
      data: { pizzint: null, tensionPairs: [] },
      status: 'error',
      errors: [err?.message ?? String(err)],
    };
  }
};
