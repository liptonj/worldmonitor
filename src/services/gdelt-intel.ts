import type { Hotspot } from '@/types';
import { t } from '@/services/i18n';
import { fetchRelayPanel, RELAY_HTTP_BASE, getRelayFetchHeaders } from '@/services/relay-http';

export interface GdeltArticle {
  title: string;
  url: string;
  source: string;
  date: string;
  image?: string;
  language?: string;
  tone?: number;
}

export interface IntelTopic {
  id: string;
  name: string;
  query: string;
  icon: string;
  description: string;
}

export interface TopicIntelligence {
  topic: IntelTopic;
  articles: GdeltArticle[];
  fetchedAt: Date;
}

export const INTEL_TOPICS: IntelTopic[] = [
  {
    id: 'military',
    name: 'Military Activity',
    query: '(military exercise OR troop deployment OR airstrike OR "naval exercise") sourcelang:eng',
    icon: '⚔️',
    description: 'Military exercises, deployments, and operations',
  },
  {
    id: 'cyber',
    name: 'Cyber Threats',
    query: '(cyberattack OR ransomware OR hacking OR "data breach" OR APT) sourcelang:eng',
    icon: '🔓',
    description: 'Cyber attacks, ransomware, and digital threats',
  },
  {
    id: 'nuclear',
    name: 'Nuclear',
    query: '(nuclear OR uranium enrichment OR IAEA OR "nuclear weapon" OR plutonium) sourcelang:eng',
    icon: '☢️',
    description: 'Nuclear programs, IAEA inspections, proliferation',
  },
  {
    id: 'sanctions',
    name: 'Sanctions',
    query: '(sanctions OR embargo OR "trade war" OR tariff OR "economic pressure") sourcelang:eng',
    icon: '🚫',
    description: 'Economic sanctions and trade restrictions',
  },
  {
    id: 'intelligence',
    name: 'Intelligence',
    query: '(espionage OR spy OR intelligence agency OR covert OR surveillance) sourcelang:eng',
    icon: '🕵️',
    description: 'Espionage, intelligence operations, surveillance',
  },
  {
    id: 'maritime',
    name: 'Maritime Security',
    query: '(naval blockade OR piracy OR "strait of hormuz" OR "south china sea" OR warship) sourcelang:eng',
    icon: '🚢',
    description: 'Naval operations, maritime chokepoints, sea lanes',
  },
];

export const POSITIVE_GDELT_TOPICS: IntelTopic[] = [
  {
    id: 'science-breakthroughs',
    name: 'Science Breakthroughs',
    query: '(breakthrough OR discovery OR "new treatment" OR "clinical trial success") sourcelang:eng',
    icon: '',
    description: 'Scientific discoveries and medical advances',
  },
  {
    id: 'climate-progress',
    name: 'Climate Progress',
    query: '(renewable energy record OR "solar installation" OR "wind farm" OR "emissions decline" OR "green hydrogen") sourcelang:eng',
    icon: '',
    description: 'Renewable energy milestones and climate wins',
  },
  {
    id: 'conservation-wins',
    name: 'Conservation Wins',
    query: '(species recovery OR "population rebound" OR "conservation success" OR "habitat restored" OR "marine sanctuary") sourcelang:eng',
    icon: '',
    description: 'Wildlife recovery and habitat restoration',
  },
  {
    id: 'humanitarian-progress',
    name: 'Humanitarian Progress',
    query: '(poverty decline OR "literacy rate" OR "vaccination campaign" OR "peace agreement" OR "humanitarian aid") sourcelang:eng',
    icon: '',
    description: 'Poverty reduction, education, and peace',
  },
  {
    id: 'innovation',
    name: 'Innovation',
    query: '("clean technology" OR "AI healthcare" OR "3D printing" OR "electric vehicle" OR "fusion energy") sourcelang:eng',
    icon: '',
    description: 'Technology for good and clean innovation',
  },
];

export function getIntelTopics(): IntelTopic[] {
  return INTEL_TOPICS.map(topic => ({
    ...topic,
    name: t(`intel.topics.${topic.id}.name`),
    description: t(`intel.topics.${topic.id}.description`),
  }));
}

// ---- Relay GDELT cached data ----

interface GdeltTopicCache {
  articles: GdeltArticle[];
  query: string;
  fetchedAt: string;
  error?: string;
}

interface GdeltPanelData {
  data?: Record<string, GdeltTopicCache>;
  status?: string;
  timestamp?: string;
}

const CACHE_TTL = 5 * 60 * 1000;
const panelCache: { data: GdeltPanelData | null; timestamp: number } = { data: null, timestamp: 0 };

async function fetchGdeltPanel(): Promise<GdeltPanelData | null> {
  if (panelCache.data && Date.now() - panelCache.timestamp < CACHE_TTL) {
    return panelCache.data;
  }
  try {
    // Note: GDELT is a direct proxy endpoint (/gdelt), not a relay panel channel
    const resp = await fetch(`${RELAY_HTTP_BASE}/gdelt`, {
      headers: getRelayFetchHeaders(),
    });
    if (!resp.ok) {
      throw new Error(`GDELT fetch failed: ${resp.status}`);
    }
    const data = await resp.json() as GdeltPanelData;
    if (data) {
      panelCache.data = data;
      panelCache.timestamp = Date.now();
    }
    return data;
  } catch (err) {
    console.warn(`[GDELT-Intel] Panel fetch failed: ${err instanceof Error ? err.message : err}`);
    return panelCache.data;
  }
}

/** Fetch articles for a specific topic from pre-cached GDELT data */
export async function fetchGdeltArticlesForTopic(topicId: string): Promise<GdeltArticle[]> {
  const panel = await fetchGdeltPanel();
  const topicData = panel?.data?.[topicId];
  return topicData?.articles || [];
}

/** Legacy: Fetch GDELT articles by query - falls back to proxy for dynamic queries */
export async function fetchGdeltArticles(
  query: string,
  maxrecords = 10,
  timespan = '24h'
): Promise<GdeltArticle[]> {
  // Check if this matches a known topic query - use cache
  const panel = await fetchGdeltPanel();
  if (panel?.data) {
    for (const [_topicId, topicData] of Object.entries(panel.data)) {
      if (topicData.query === query) {
        return topicData.articles.slice(0, maxrecords);
      }
    }
  }

  // Fallback to proxy for custom queries (e.g., hotspot context)
  try {
    const params = new URLSearchParams({
      query,
      max_records: String(maxrecords),
      timespan,
    });
    const resp = await fetch(`${RELAY_HTTP_BASE}/gdelt?${params}`, {
      headers: getRelayFetchHeaders(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) throw new Error(`GDELT relay ${resp.status}`);
    const data = await resp.json() as { articles?: GdeltArticle[] };
    return data.articles || [];
  } catch (err) {
    console.warn(`[GDELT-Intel] Relay fetch failed: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

export async function fetchHotspotContext(hotspot: Hotspot): Promise<GdeltArticle[]> {
  const query = hotspot.keywords.slice(0, 5).join(' OR ');
  return fetchGdeltArticles(query, 8, '48h');
}

export async function fetchTopicIntelligence(topic: IntelTopic): Promise<TopicIntelligence> {
  const articles = await fetchGdeltArticlesForTopic(topic.id);
  return {
    topic,
    articles,
    fetchedAt: new Date(),
  };
}

export async function fetchAllTopicIntelligence(): Promise<TopicIntelligence[]> {
  // All topics are pre-cached - fetch panel once and extract all
  const panel = await fetchGdeltPanel();
  if (!panel?.data) return [];
  
  return INTEL_TOPICS.map(topic => ({
    topic,
    articles: panel.data?.[topic.id]?.articles || [],
    fetchedAt: new Date(panel.data?.[topic.id]?.fetchedAt || Date.now()),
  }));
}

export function formatArticleDate(dateStr: string): string {
  if (!dateStr) return '';
  try {
    // GDELT returns compact format: "20260111T093000Z"
    const year = dateStr.slice(0, 4);
    const month = dateStr.slice(4, 6);
    const day = dateStr.slice(6, 8);
    const hour = dateStr.slice(9, 11);
    const min = dateStr.slice(11, 13);
    const sec = dateStr.slice(13, 15);
    const date = new Date(`${year}-${month}-${day}T${hour}:${min}:${sec}Z`);
    if (isNaN(date.getTime())) return '';

    const now = Date.now();
    const diff = now - date.getTime();

    if (diff < 0) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return `${Math.floor(diff / 86400000)}d ago`;
  } catch {
    return '';
  }
}

export function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch {
    return '';
  }
}

// ---- Positive GDELT queries (Happy variant) ----

export async function fetchPositiveGdeltArticles(topicId: string): Promise<GdeltArticle[]> {
  return fetchGdeltArticlesForTopic(topicId);
}

export async function fetchPositiveTopicIntelligence(topic: IntelTopic): Promise<TopicIntelligence> {
  const articles = await fetchGdeltArticlesForTopic(topic.id);
  return { topic, articles, fetchedAt: new Date() };
}

export async function fetchAllPositiveTopicIntelligence(): Promise<TopicIntelligence[]> {
  // All topics are pre-cached - fetch panel once and extract all
  const panel = await fetchGdeltPanel();
  if (!panel?.data) return [];
  
  return POSITIVE_GDELT_TOPICS.map(topic => ({
    topic,
    articles: panel.data?.[topic.id]?.articles || [],
    fetchedAt: new Date(panel.data?.[topic.id]?.fetchedAt || Date.now()),
  }));
}
