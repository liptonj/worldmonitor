'use strict';

// Extracted from scripts/ais-relay.cjs - strategic risk indicators (ACLED + composite scoring)
// API: ACLED (Armed Conflict Location & Event Data Project)

const PHASE3C_TIMEOUT_MS = 15_000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

const COUNTRY_KEYWORDS = {
  US: ['united states', 'usa', 'america', 'washington', 'biden', 'trump', 'pentagon'],
  RU: ['russia', 'moscow', 'kremlin', 'putin'],
  CN: ['china', 'beijing', 'xi jinping', 'prc'],
  UA: ['ukraine', 'kyiv', 'zelensky', 'donbas'],
  IR: ['iran', 'tehran', 'khamenei', 'irgc'],
  IL: ['israel', 'tel aviv', 'netanyahu', 'idf', 'gaza'],
  TW: ['taiwan', 'taipei'],
  KP: ['north korea', 'pyongyang', 'kim jong'],
  SA: ['saudi arabia', 'riyadh'],
  TR: ['turkey', 'ankara', 'erdogan'],
  PL: ['poland', 'warsaw'],
  DE: ['germany', 'berlin'],
  FR: ['france', 'paris', 'macron'],
  GB: ['britain', 'uk', 'london'],
  IN: ['india', 'delhi', 'modi'],
  PK: ['pakistan', 'islamabad'],
  SY: ['syria', 'damascus'],
  YE: ['yemen', 'sanaa', 'houthi'],
  MM: ['myanmar', 'burma'],
  VE: ['venezuela', 'caracas', 'maduro'],
};

const TIER1_COUNTRIES = { US: 'US', RU: 'RU', CN: 'CN', UA: 'UA', IR: 'IR', IL: 'IL', TW: 'TW', KP: 'KP', SA: 'SA', TR: 'TR', PL: 'PL', DE: 'DE', FR: 'FR', GB: 'GB', IN: 'IN', PK: 'PK', SY: 'SY', YE: 'YE', MM: 'MM', VE: 'VE' };
const BASELINE_RISK = { US: 5, RU: 35, CN: 25, UA: 50, IR: 40, IL: 45, TW: 30, KP: 45, SA: 20, TR: 25, PL: 10, DE: 5, FR: 10, GB: 5, IN: 20, PK: 35, SY: 50, YE: 50, MM: 45, VE: 40 };
const EVENT_MULTIPLIER = { US: 0.3, RU: 2.0, CN: 2.5, UA: 0.8, IR: 2.0, IL: 0.7, TW: 1.5, KP: 3.0, SA: 2.0, TR: 1.2, PL: 0.8, DE: 0.5, FR: 0.6, GB: 0.5, IN: 0.8, PK: 1.5, SY: 0.7, YE: 0.7, MM: 1.8, VE: 1.8 };

function normalizeCountryName(text) {
  const lower = (text || '').toLowerCase();
  for (const [code, keywords] of Object.entries(COUNTRY_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) return code;
  }
  return null;
}

module.exports = async function fetchStrategicRisk({ config, redis, log, http }) {
  log.debug('fetchStrategicRisk executing');
  const timestamp = new Date().toISOString();

  const token = config?.ACLED_ACCESS_TOKEN || process.env.ACLED_ACCESS_TOKEN;
  if (!token) {
    log.warn('fetchStrategicRisk: ACLED_ACCESS_TOKEN not set');
    return {
      timestamp,
      source: 'strategic-risk',
      data: { ciiScores: [], strategicRisks: [] },
      status: 'error',
      errors: ['ACLED_ACCESS_TOKEN not configured'],
    };
  }

  try {
    const endDate = new Date().toISOString().slice(0, 10);
    const startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const params = new URLSearchParams({
      event_type: 'Protests|Riots',
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

    if (!data || !Array.isArray(data.data)) {
      return {
        timestamp,
        source: 'strategic-risk',
        data: { ciiScores: [], strategicRisks: [] },
        status: 'error',
        errors: ['ACLED API returned invalid or empty response'],
      };
    }

    const protests = data.data.map((e) => ({ country: e.country || '', event_type: e.event_type || '' }));

    const countryEvents = new Map();
    for (const e of protests) {
      const code = normalizeCountryName(e.country);
      if (code && TIER1_COUNTRIES[code]) {
        const c = countryEvents.get(code) || { protests: 0, riots: 0 };
        if (e.event_type === 'Riots') c.riots++;
        else c.protests++;
        countryEvents.set(code, c);
      }
    }

    const ciiScores = [];
    for (const [code] of Object.entries(TIER1_COUNTRIES)) {
      const events = countryEvents.get(code) || { protests: 0, riots: 0 };
      const baseline = BASELINE_RISK[code] || 20;
      const mult = EVENT_MULTIPLIER[code] || 1.0;
      const unrest = Math.min(100, Math.round((events.protests + events.riots * 2) * mult * 2));
      const security = Math.min(100, baseline + events.riots * mult * 5);
      const information = Math.min(100, (events.protests + events.riots) * mult * 3);
      const composite = Math.min(100, Math.round(baseline + (unrest * 0.4 + security * 0.35 + information * 0.25) * 0.5));
      ciiScores.push({
        region: code,
        staticBaseline: baseline,
        dynamicScore: composite - baseline,
        combinedScore: composite,
        trend: 'TREND_DIRECTION_STABLE',
        components: { newsActivity: information, ciiContribution: unrest, geoConvergence: 0, militaryActivity: 0 },
        computedAt: Date.now(),
      });
    }
    ciiScores.sort((a, b) => b.combinedScore - a.combinedScore);

    const top5 = ciiScores.slice(0, 5);
    const weights = top5.map((_, i) => 1 - i * 0.15);
    const totalWeight = weights.reduce((s, w) => s + w, 0);
    const weightedSum = top5.reduce((s, sc, i) => s + sc.combinedScore * weights[i], 0);
    const overallScore = Math.min(100, Math.round((weightedSum / totalWeight) * 0.7 + 15));
    const strategicRisks = [
      {
        region: 'global',
        level: overallScore >= 70 ? 'SEVERITY_LEVEL_HIGH' : overallScore >= 40 ? 'SEVERITY_LEVEL_MEDIUM' : 'SEVERITY_LEVEL_LOW',
        score: overallScore,
        factors: top5.map((s) => s.region),
        trend: 'TREND_DIRECTION_STABLE',
      },
    ];

    return {
      timestamp,
      source: 'strategic-risk',
      data: { ciiScores, strategicRisks },
      status: 'success',
    };
  } catch (err) {
    log.error('fetchStrategicRisk error', { error: err?.message ?? err });
    return {
      timestamp,
      source: 'strategic-risk',
      data: { ciiScores: [], strategicRisks: [] },
      status: 'error',
      errors: [err?.message ?? String(err)],
    };
  }
};
