'use strict';

// GDELT Doc API fetcher - Pre-caches all intel topics
// API: GDELT Project Doc API (global events database)

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const GDELT_TIMEOUT_MS = 12_000;
const GDELT_API_URL = 'https://api.gdeltproject.org/api/v2/doc/doc';

const INTEL_TOPICS = [
  {
    id: 'military',
    query: '(military exercise OR troop deployment OR airstrike OR "naval exercise") sourcelang:eng',
  },
  {
    id: 'cyber',
    query: '(cyberattack OR ransomware OR hacking OR "data breach" OR APT) sourcelang:eng',
  },
  {
    id: 'nuclear',
    query: '(nuclear OR uranium enrichment OR IAEA OR "nuclear weapon" OR plutonium) sourcelang:eng',
  },
  {
    id: 'sanctions',
    query: '(sanctions OR embargo OR "trade war" OR tariff OR "economic pressure") sourcelang:eng',
  },
  {
    id: 'intelligence',
    query: '(espionage OR spy OR intelligence agency OR covert OR surveillance) sourcelang:eng',
  },
  {
    id: 'maritime',
    query: '(naval blockade OR piracy OR "strait of hormuz" OR "south china sea" OR warship) sourcelang:eng',
  },
];

const POSITIVE_TOPICS = [
  {
    id: 'science-breakthroughs',
    query: '(breakthrough OR discovery OR "new treatment" OR "clinical trial success") sourcelang:eng',
  },
  {
    id: 'climate-progress',
    query: '(renewable energy record OR "solar installation" OR "wind farm" OR "emissions decline" OR "green hydrogen") sourcelang:eng',
  },
  {
    id: 'conservation-wins',
    query: '(species recovery OR "population rebound" OR "conservation success" OR "habitat restored" OR "marine sanctuary") sourcelang:eng',
  },
  {
    id: 'humanitarian-progress',
    query: '(poverty decline OR "literacy rate" OR "vaccination campaign" OR "peace agreement" OR "humanitarian aid") sourcelang:eng',
  },
  {
    id: 'innovation',
    query: '("clean technology" OR "AI healthcare" OR "3D printing" OR "electric vehicle" OR "fusion energy") sourcelang:eng',
  },
];

const ALL_TOPICS = [...INTEL_TOPICS, ...POSITIVE_TOPICS];

async function fetchTopicArticles(http, log, topic, maxRecords, timespan) {
  const gdeltUrl = new URL(GDELT_API_URL);
  gdeltUrl.searchParams.set('query', topic.query);
  gdeltUrl.searchParams.set('mode', 'artlist');
  gdeltUrl.searchParams.set('maxrecords', String(maxRecords));
  gdeltUrl.searchParams.set('format', 'json');
  gdeltUrl.searchParams.set('sort', 'date');
  gdeltUrl.searchParams.set('timespan', timespan);

  const raw = await http.fetchJson(gdeltUrl.toString(), {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    timeout: GDELT_TIMEOUT_MS,
  });

  return (raw?.articles || []).map((a) => ({
    title: a.title || '',
    url: a.url || '',
    source: a.domain || a.source?.domain || '',
    date: a.seendate || '',
    image: a.socialimage || '',
    language: a.language || '',
    tone: typeof a.tone === 'number' ? a.tone : 0,
  }));
}

module.exports = async function fetchGdelt({ config, redis, log, http }) {
  log.debug('fetchGdelt executing - fetching all topics');
  const timestamp = new Date().toISOString();

  const maxRecords = Math.min(parseInt(config?.GDELT_MAX_RECORDS || process.env.GDELT_MAX_RECORDS || '10', 10) || 10, 20);
  const timespan = config?.GDELT_TIMESPAN || process.env.GDELT_TIMESPAN || '24h';

  const results = {};
  const errors = [];

  for (const topic of ALL_TOPICS) {
    try {
      const articles = await fetchTopicArticles(http, log, topic, maxRecords, timespan);
      results[topic.id] = {
        articles,
        query: topic.query,
        fetchedAt: timestamp,
      };
      log.debug(`Fetched GDELT topic: ${topic.id}`, { count: articles.length });
    } catch (err) {
      log.error(`fetchGdelt error for topic ${topic.id}`, { error: err?.message ?? err });
      errors.push({ topic: topic.id, error: err?.message ?? String(err) });
      results[topic.id] = {
        articles: [],
        query: topic.query,
        fetchedAt: timestamp,
        error: err?.message ?? String(err),
      };
    }
  }

  return {
    timestamp,
    source: 'gdelt',
    data: results,
    status: errors.length === 0 ? 'success' : errors.length === ALL_TOPICS.length ? 'error' : 'partial',
    errors: errors.length > 0 ? errors : undefined,
  };
};

module.exports.INTEL_TOPICS = INTEL_TOPICS;
module.exports.POSITIVE_TOPICS = POSITIVE_TOPICS;
module.exports.ALL_TOPICS = ALL_TOPICS;
