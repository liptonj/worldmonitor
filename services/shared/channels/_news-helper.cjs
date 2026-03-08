'use strict';

const { parseString } = require('xml2js');
const { promisify } = require('util');
const parseXML = promisify(parseString);

const THREAT_LEVEL_UNSPECIFIED = 'THREAT_LEVEL_UNSPECIFIED';
const ITEMS_PER_FEED = 5;
const MAX_ITEMS_PER_CATEGORY = 20;
const FEED_TIMEOUT_MS = 8_000;

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

function parseRssItems(parsed, feedName, feedUrl) {
  const items = [];
  const channel = parsed?.rss?.channel?.[0] || parsed?.feed;
  if (!channel) return items;

  const rawItems = channel.item || channel['atom:item'] || [];
  const entries = parsed?.feed ? (parsed.feed.entry || []) : [];
  const isAtom = rawItems.length === 0 && entries.length > 0;
  const source = firstVal(channel.title) || feedName || feedUrl;

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
    const parsedDate = pubDateStr ? new Date(pubDateStr) : new Date();
    const publishedAt = Number.isNaN(parsedDate.getTime()) ? Date.now() : parsedDate.getTime();

    items.push({
      source: feedName || source,
      title,
      link: String(link),
      publishedAt,
      isAlert: false,
      threat: {
        level: THREAT_LEVEL_UNSPECIFIED,
        category: 'general',
        confidence: 0,
        source: 'keyword',
      },
      locationName: '',
    });
  }
  return items;
}

async function fetchAndParseFeed(feed, http, log) {
  const url = resolveFeedUrl(feed.url);
  if (!url) return { items: [], status: 'empty' };

  try {
    const xml = await http.fetchText(url, { timeout: FEED_TIMEOUT_MS });
    const parsed = await parseXML(xml, { explicitArray: true });
    const items = parseRssItems(parsed, feed.name, url);
    return { items, status: items.length > 0 ? 'ok' : 'empty' };
  } catch (err) {
    log.warn('news feed error', { feed: feed.name, url, error: err.message });
    return { items: [], status: 'timeout' };
  }
}

async function buildNewsDigest(feedsByCategory, { config, redis, log, http }) {
  const categories = {};
  const feedStatuses = {};

  for (const [category, feeds] of Object.entries(feedsByCategory)) {
    const categoryItems = [];

    for (const feed of feeds) {
      const { items, status } = await fetchAndParseFeed(feed, http, log);
      feedStatuses[feed.name] = status;
      for (const item of items) {
        categoryItems.push({ ...item, _category: category });
      }
    }

    if (categoryItems.length > 0) {
      categoryItems.sort((a, b) => b.publishedAt - a.publishedAt);
      const trimmed = categoryItems.slice(0, MAX_ITEMS_PER_CATEGORY);
      categories[category] = {
        items: trimmed.map(({ _category, ...item }) => item),
      };
    }
  }

  return {
    categories,
    feedStatuses,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { buildNewsDigest, resolveFeedUrl };
