'use strict';

// Security advisories from government travel advisories and health organizations
// Sources: US State Dept, AU Smartraveller, NZ MFAT, UK FCDO, CDC, ECDC, WHO

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const TIMEOUT_MS = 15_000;
const MAX_ITEMS_PER_FEED = 15;

const ADVISORY_FEEDS = [
  // Travel advisories
  { name: 'US State Dept', sourceCountry: 'US', url: 'https://travel.state.gov/_res/rss/TAsTWs.xml', levelParser: 'us' },
  { name: 'AU Smartraveller', sourceCountry: 'AU', url: 'https://www.smartraveller.gov.au/countries/documents/index.rss', levelParser: 'au' },
  { name: 'AU DNT', sourceCountry: 'AU', url: 'https://www.smartraveller.gov.au/countries/documents/do-not-travel.rss', level: 'do-not-travel' },
  { name: 'AU Reconsider', sourceCountry: 'AU', url: 'https://www.smartraveller.gov.au/countries/documents/reconsider-your-need-to-travel.rss', level: 'reconsider' },
  { name: 'NZ MFAT', sourceCountry: 'NZ', url: 'https://www.safetravel.govt.nz/news/feed', levelParser: 'au' },
  { name: 'UK FCDO', sourceCountry: 'UK', url: 'https://www.gov.uk/foreign-travel-advice.atom' },
  // US Embassy alerts
  { name: 'US Embassy Thailand', sourceCountry: 'US', url: 'https://th.usembassy.gov/category/alert/feed/', targetCountry: 'TH' },
  { name: 'US Embassy UAE', sourceCountry: 'US', url: 'https://ae.usembassy.gov/category/alert/feed/', targetCountry: 'AE' },
  { name: 'US Embassy Germany', sourceCountry: 'US', url: 'https://de.usembassy.gov/category/alert/feed/', targetCountry: 'DE' },
  { name: 'US Embassy Ukraine', sourceCountry: 'US', url: 'https://ua.usembassy.gov/category/alert/feed/', targetCountry: 'UA' },
  { name: 'US Embassy Mexico', sourceCountry: 'US', url: 'https://mx.usembassy.gov/category/alert/feed/', targetCountry: 'MX' },
  { name: 'US Embassy India', sourceCountry: 'US', url: 'https://in.usembassy.gov/category/alert/feed/', targetCountry: 'IN' },
  { name: 'US Embassy Pakistan', sourceCountry: 'US', url: 'https://pk.usembassy.gov/category/alert/feed/', targetCountry: 'PK' },
  // Health advisories
  { name: 'CDC Travel Notices', sourceCountry: 'US', url: 'https://wwwnc.cdc.gov/travel/rss/notices.xml' },
  { name: 'ECDC Epidemiological Updates', sourceCountry: 'EU', url: 'https://www.ecdc.europa.eu/en/taxonomy/term/1310/feed' },
  { name: 'ECDC Risk Assessments', sourceCountry: 'EU', url: 'https://www.ecdc.europa.eu/en/taxonomy/term/1295/feed' },
  { name: 'WHO News', sourceCountry: 'INT', url: 'https://www.who.int/rss-feeds/news-english.xml' },
];

const US_LEVEL_RE = /Level (\d)/i;

function parseUsLevel(title) {
  const m = title.match(US_LEVEL_RE);
  if (!m) return 'info';
  switch (m[1]) {
    case '4': return 'do-not-travel';
    case '3': return 'reconsider';
    case '2': return 'caution';
    case '1': return 'normal';
    default: return 'info';
  }
}

function parseAuLevel(title) {
  const lower = title.toLowerCase();
  if (lower.includes('do not travel')) return 'do-not-travel';
  if (lower.includes('reconsider')) return 'reconsider';
  if (lower.includes('exercise a high degree of caution') || lower.includes('high degree')) return 'caution';
  return 'info';
}

function getLevel(feed, title) {
  if (feed.level) return feed.level;
  if (feed.levelParser === 'us') return parseUsLevel(title);
  if (feed.levelParser === 'au') return parseAuLevel(title);
  return 'info';
}

function parseRssFeed(text, feed) {
  const items = [];
  const isAtom = text.includes('<feed') && text.includes('xmlns="http://www.w3.org/2005/Atom"');
  
  if (isAtom) {
    const entryMatches = text.matchAll(/<entry>([\s\S]*?)<\/entry>/g);
    for (const match of entryMatches) {
      const entry = match[1];
      const title = entry.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1]?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() || '';
      const linkMatch = entry.match(/<link[^>]*href="([^"]+)"/);
      const link = linkMatch?.[1] || '';
      const updated = entry.match(/<updated>([\s\S]*?)<\/updated>/)?.[1] || entry.match(/<published>([\s\S]*?)<\/published>/)?.[1] || '';
      const pubDate = updated ? new Date(updated).toISOString() : new Date().toISOString();
      
      if (title) {
        items.push({
          title,
          link,
          pubDate,
          source: feed.name,
          sourceCountry: feed.sourceCountry,
          level: getLevel(feed, title),
          country: feed.targetCountry || extractCountryFromTitle(title),
        });
      }
      if (items.length >= MAX_ITEMS_PER_FEED) break;
    }
  } else {
    const itemMatches = text.matchAll(/<item>([\s\S]*?)<\/item>/g);
    for (const match of itemMatches) {
      const item = match[1];
      const title = item.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1]?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() || '';
      const link = item.match(/<link[^>]*>([\s\S]*?)<\/link>/)?.[1]?.trim() || '';
      const pubDateStr = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || '';
      const pubDate = pubDateStr ? new Date(pubDateStr).toISOString() : new Date().toISOString();
      
      if (title) {
        items.push({
          title,
          link,
          pubDate,
          source: feed.name,
          sourceCountry: feed.sourceCountry,
          level: getLevel(feed, title),
          country: feed.targetCountry || extractCountryFromTitle(title),
        });
      }
      if (items.length >= MAX_ITEMS_PER_FEED) break;
    }
  }
  
  return items;
}

function extractCountryFromTitle(title) {
  const parts = title.split(/\s*[–—-]\s*/);
  if (parts.length >= 2) {
    const firstPart = parts[0].trim();
    if (firstPart.length <= 30 && !firstPart.includes(' Travel ')) {
      return firstPart;
    }
  }
  return undefined;
}

module.exports = async function fetchSecurityAdvisories({ config, redis, log, http }) {
  log.debug('fetchSecurityAdvisories executing');
  const timestamp = new Date().toISOString();

  try {
    const results = await Promise.allSettled(
      ADVISORY_FEEDS.map(async (feed) => {
        try {
          const text = await http.fetchText(feed.url, {
            headers: { 
              'User-Agent': USER_AGENT,
              Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
            },
            timeout: TIMEOUT_MS,
          });
          return parseRssFeed(text, feed);
        } catch (err) {
          log.debug(`Feed ${feed.name} failed`, { error: err?.message });
          return [];
        }
      })
    );

    let allItems = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        allItems.push(...result.value);
      }
    }

    // Deduplicate by title
    const seen = new Set();
    allItems = allItems.filter((item) => {
      const key = item.title.toLowerCase().trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Sort by date descending
    allItems.sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime());

    // Limit to most recent 100
    const items = allItems.slice(0, 100);

    log.info('fetchSecurityAdvisories complete', { count: items.length });

    return {
      timestamp,
      source: 'security-advisories',
      data: { items },
      status: 'success',
    };
  } catch (err) {
    log.error('fetchSecurityAdvisories error', { error: err?.message ?? err });
    return {
      timestamp,
      source: 'security-advisories',
      data: { items: [] },
      status: 'error',
      errors: [err?.message ?? String(err)],
    };
  }
};
