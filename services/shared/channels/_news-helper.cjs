'use strict';

const { parseString } = require('xml2js');
const { promisify } = require('util');
const parseXML = promisify(parseString);

const ITEMS_PER_FEED = 5;
const FEED_TIMEOUT_MS = 8_000;

// Keyword classification — extracted from scripts/ais-relay.cjs lines 7313–7326
const NEWS_CRITICAL_KW = {
  'nuclear strike': 'military',
  'nuclear attack': 'military',
  invasion: 'conflict',
  coup: 'military',
  genocide: 'conflict',
  'mass casualty': 'conflict',
};
const NEWS_HIGH_KW = {
  war: 'conflict',
  airstrike: 'conflict',
  missile: 'military',
  bombing: 'conflict',
  hostage: 'terrorism',
  'cyber attack': 'cyber',
  earthquake: 'disaster',
};
const NEWS_MEDIUM_KW = {
  protest: 'protest',
  riot: 'protest',
  'military exercise': 'military',
  'trade war': 'economic',
  recession: 'economic',
  flood: 'disaster',
};
const NEWS_LOW_KW = {
  election: 'diplomatic',
  summit: 'diplomatic',
  treaty: 'diplomatic',
  ceasefire: 'diplomatic',
};
const NEWS_EXCLUSIONS = ['protein', 'couples', 'dating', 'recipe', 'celebrity', 'sports', 'movie', 'vacation'];

function classifyNewsTitle(title, variant) {
  const lower = (title || '').toLowerCase();
  if (NEWS_EXCLUSIONS.some((ex) => lower.includes(ex))) {
    return { level: 'info', category: 'general', confidence: 0.3 };
  }
  for (const [kw, cat] of Object.entries(NEWS_CRITICAL_KW)) {
    if (lower.includes(kw)) return { level: 'critical', category: cat, confidence: 0.9 };
  }
  for (const [kw, cat] of Object.entries(NEWS_HIGH_KW)) {
    if (lower.includes(kw)) return { level: 'high', category: cat, confidence: 0.8 };
  }
  for (const [kw, cat] of Object.entries(NEWS_MEDIUM_KW)) {
    if (lower.includes(kw)) return { level: 'medium', category: cat, confidence: 0.7 };
  }
  for (const [kw, cat] of Object.entries(NEWS_LOW_KW)) {
    if (lower.includes(kw)) return { level: 'low', category: cat, confidence: 0.6 };
  }
  return { level: 'info', category: 'general', confidence: 0.3 };
}

function resolveFeedUrl(url) {
  if (typeof url === 'string') return url;
  if (url && typeof url === 'object') {
    return url.en || url['en'] || Object.values(url)[0] || '';
  }
  return '';
}

function firstVal(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return (v[0] != null ? String(v[0]) : '').trim();
  return String(v).trim();
}

function parseRssItems(parsed, feedName, feedUrl, variant) {
  const items = [];
  const channel = parsed?.rss?.channel?.[0] || parsed?.feed;
  if (!channel) return items;

  const rawItems = channel.item || channel['atom:item'] || [];
  const entries = parsed?.feed ? (parsed.feed.entry || []) : [];
  const isAtom = rawItems.length === 0 && entries.length > 0;
  const sourceName = firstVal(channel.title) || feedName || feedUrl;

  const list = isAtom ? entries : rawItems;
  for (let i = 0; i < Math.min(list.length, ITEMS_PER_FEED); i++) {
    const item = list[i];
    const title = firstVal(item.title);
    if (!title) continue;

    let link = '';
    if (isAtom && item.link) {
      const raw = Array.isArray(item.link) ? item.link[0] : item.link;
      link = raw && typeof raw === 'object' && raw.$ ? (raw.$.href || '') : firstVal(item.link);
    } else {
      link = firstVal(item.link);
    }

    const pubDateStr = firstVal(item.pubDate) || firstVal(item.published) || firstVal(item.updated);
    const description = firstVal(item.description) || firstVal(item.summary) || '';
    const parsedDate = pubDateStr ? new Date(pubDateStr) : new Date();
    const publishedAt = Number.isNaN(parsedDate.getTime()) ? Date.now() : parsedDate.getTime();

    const threat = classifyNewsTitle(title, variant);
    const isAlert = threat.level === 'critical' || threat.level === 'high';

    items.push({
      title,
      link: String(link),
      pubDate: pubDateStr || new Date().toISOString(),
      description,
      source: feedName || sourceName,
      publishedAt,
      isAlert,
      threat: {
        level: threat.level,
        category: threat.category,
        confidence: threat.confidence,
        source: 'keyword',
      },
    });
  }
  return items;
}

async function fetchAndParseFeed(feed, variant, http, log) {
  const url = resolveFeedUrl(feed.url);
  if (!url) return { items: [], error: null };

  try {
    const xml = await http.fetchText(url, { timeout: FEED_TIMEOUT_MS });
    const parsed = await parseXML(xml, { explicitArray: true });
    const items = parseRssItems(parsed, feed.name, url, variant);
    return { items, error: null };
  } catch (err) {
    log.warn('news feed error', { feed: feed.name, url, error: err.message });
    return { items: [], error: { feed: url, error: err.message } };
  }
}

/**
 * Build news digest in worker channel format (matches markets.cjs pattern).
 * Returns { timestamp, source, data, status, errors }.
 */
async function buildNewsDigest(feedsByCategory, source, { config, redis, log, http }) {
  const timestamp = new Date().toISOString();
  const articles = [];
  const errors = [];

  for (const feeds of Object.values(feedsByCategory)) {
    for (const feed of feeds) {
      const { items, error } = await fetchAndParseFeed(feed, source.replace('news:', ''), http, log);
      if (error) errors.push(error);
      articles.push(...items);
    }
  }

  articles.sort((a, b) => b.publishedAt - a.publishedAt);

  return {
    timestamp,
    source,
    data: articles,
    status: articles.length > 0 ? 'success' : 'error',
    errors: errors.length > 0 ? errors : undefined,
  };
}

module.exports = { buildNewsDigest, resolveFeedUrl, classifyNewsTitle };
