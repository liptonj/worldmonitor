export {
  type ThreatLevel,
  type EventCategory,
  type ThreatClassification,
  THREAT_COLORS,
  THREAT_PRIORITY,
  THREAT_LABELS,
  aggregateThreats,
} from './threat-types';

import type { ThreatLevel, EventCategory, ThreatClassification } from './threat-types';
import { getCSSColor } from '@/utils';

const THREAT_VAR_MAP: Record<ThreatLevel, string> = {
  critical: '--threat-critical',
  high: '--threat-high',
  medium: '--threat-medium',
  low: '--threat-low',
  info: '--threat-info',
};

export function getThreatColor(level: string): string {
  return getCSSColor(THREAT_VAR_MAP[level as ThreatLevel] || '--text-dim');
}

import { t } from '@/services/i18n';

export function getThreatLabel(level: ThreatLevel): string {
  return t(`components.threatLabels.${level}`);
}

type KeywordMap = Record<string, EventCategory>;

const CRITICAL_KEYWORDS: KeywordMap = {
  'nuclear strike': 'military',
  'nuclear attack': 'military',
  'nuclear war': 'military',
  'invasion': 'conflict',
  'declaration of war': 'conflict',
  'declares war': 'conflict',
  'all-out war': 'conflict',
  'full-scale war': 'conflict',
  'martial law': 'military',
  'coup': 'military',
  'coup attempt': 'military',
  'genocide': 'conflict',
  'ethnic cleansing': 'conflict',
  'chemical attack': 'terrorism',
  'biological attack': 'terrorism',
  'dirty bomb': 'terrorism',
  'mass casualty': 'conflict',
  'massive strikes': 'military',
  'military strikes': 'military',
  'retaliatory strikes': 'military',
  'launches strikes': 'military',
  'launch attacks on iran': 'military',
  'launch attack on iran': 'military',
  'attacks on iran': 'military',
  'strikes on iran': 'military',
  'strikes iran': 'military',
  'bombs iran': 'military',
  'attacks iran': 'military',
  'attack on iran': 'military',
  'attack iran': 'military',
  'attacked iran': 'military',
  'attack against iran': 'military',
  'bombing iran': 'military',
  'bombed iran': 'military',
  'war with iran': 'conflict',
  'war on iran': 'conflict',
  'war against iran': 'conflict',
  'iran retaliates': 'military',
  'iran strikes': 'military',
  'iran launches': 'military',
  'iran attacks': 'military',
  'pandemic declared': 'health',
  'health emergency': 'health',
  'nato article 5': 'military',
  'evacuation order': 'disaster',
  'meltdown': 'disaster',
  'nuclear meltdown': 'disaster',
  'major combat operations': 'military',
  'declared war': 'conflict',
};

const HIGH_KEYWORDS: KeywordMap = {
  'war': 'conflict',
  'armed conflict': 'conflict',
  'airstrike': 'conflict',
  'airstrikes': 'conflict',
  'air strike': 'conflict',
  'air strikes': 'conflict',
  'drone strike': 'conflict',
  'drone strikes': 'conflict',
  'strikes': 'conflict',
  'missile': 'military',
  'missile launch': 'military',
  'missiles fired': 'military',
  'troops deployed': 'military',
  'military escalation': 'military',
  'military operation': 'military',
  'ground offensive': 'military',
  'bombing': 'conflict',
  'bombardment': 'conflict',
  'shelling': 'conflict',
  'casualties': 'conflict',
  'killed in': 'conflict',
  'hostage': 'terrorism',
  'terrorist': 'terrorism',
  'terror attack': 'terrorism',
  'assassination': 'crime',
  'cyber attack': 'cyber',
  'ransomware': 'cyber',
  'data breach': 'cyber',
  'sanctions': 'economic',
  'embargo': 'economic',
  'earthquake': 'disaster',
  'tsunami': 'disaster',
  'hurricane': 'disaster',
  'typhoon': 'disaster',
  'strike on': 'conflict',
  'strikes on': 'conflict',
  'attack on': 'conflict',
  'attack against': 'conflict',
  'attacks on': 'conflict',
  'launched attack': 'conflict',
  'launched attacks': 'conflict',
  'launches attack': 'conflict',
  'launches attacks': 'conflict',
  'explosions': 'conflict',
  'military operations': 'military',
  'combat operations': 'military',
  'retaliatory strike': 'military',
  'retaliatory attack': 'military',
  'retaliatory attacks': 'military',
  'preemptive strike': 'military',
  'preemptive attack': 'military',
  'preventive attack': 'military',
  'preventative attack': 'military',
  'military offensive': 'military',
  'ballistic missile': 'military',
  'cruise missile': 'military',
  'air defense intercepted': 'military',
  'forces struck': 'conflict',
};

const MEDIUM_KEYWORDS: KeywordMap = {
  'protest': 'protest',
  'protests': 'protest',
  'riot': 'protest',
  'riots': 'protest',
  'unrest': 'protest',
  'demonstration': 'protest',
  'strike action': 'protest',
  'military exercise': 'military',
  'naval exercise': 'military',
  'arms deal': 'military',
  'weapons sale': 'military',
  'diplomatic crisis': 'diplomatic',
  'ambassador recalled': 'diplomatic',
  'expel diplomats': 'diplomatic',
  'trade war': 'economic',
  'tariff': 'economic',
  'recession': 'economic',
  'inflation': 'economic',
  'market crash': 'economic',
  'flood': 'disaster',
  'flooding': 'disaster',
  'wildfire': 'disaster',
  'volcano': 'disaster',
  'eruption': 'disaster',
  'outbreak': 'health',
  'epidemic': 'health',
  'infection spread': 'health',
  'oil spill': 'environmental',
  'pipeline explosion': 'infrastructure',
  'blackout': 'infrastructure',
  'power outage': 'infrastructure',
  'internet outage': 'infrastructure',
  'derailment': 'infrastructure',
};

const LOW_KEYWORDS: KeywordMap = {
  'election': 'diplomatic',
  'vote': 'diplomatic',
  'referendum': 'diplomatic',
  'summit': 'diplomatic',
  'treaty': 'diplomatic',
  'agreement': 'diplomatic',
  'negotiation': 'diplomatic',
  'talks': 'diplomatic',
  'peacekeeping': 'diplomatic',
  'humanitarian aid': 'diplomatic',
  'ceasefire': 'diplomatic',
  'peace treaty': 'diplomatic',
  'climate change': 'environmental',
  'emissions': 'environmental',
  'pollution': 'environmental',
  'deforestation': 'environmental',
  'drought': 'environmental',
  'vaccine': 'health',
  'vaccination': 'health',
  'disease': 'health',
  'virus': 'health',
  'public health': 'health',
  'covid': 'health',
  'interest rate': 'economic',
  'gdp': 'economic',
  'unemployment': 'economic',
  'regulation': 'economic',
};

const TECH_HIGH_KEYWORDS: KeywordMap = {
  'major outage': 'infrastructure',
  'service down': 'infrastructure',
  'global outage': 'infrastructure',
  'zero-day': 'cyber',
  'critical vulnerability': 'cyber',
  'supply chain attack': 'cyber',
  'mass layoff': 'economic',
};

const TECH_MEDIUM_KEYWORDS: KeywordMap = {
  'outage': 'infrastructure',
  'breach': 'cyber',
  'hack': 'cyber',
  'vulnerability': 'cyber',
  'layoff': 'economic',
  'layoffs': 'economic',
  'antitrust': 'economic',
  'monopoly': 'economic',
  'ban': 'economic',
  'shutdown': 'infrastructure',
};

const TECH_LOW_KEYWORDS: KeywordMap = {
  'ipo': 'economic',
  'funding': 'economic',
  'acquisition': 'economic',
  'merger': 'economic',
  'launch': 'tech',
  'release': 'tech',
  'update': 'tech',
  'partnership': 'economic',
  'startup': 'tech',
  'ai model': 'tech',
  'open source': 'tech',
};

const EXCLUSIONS = [
  'protein', 'couples', 'relationship', 'dating', 'diet', 'fitness',
  'recipe', 'cooking', 'shopping', 'fashion', 'celebrity', 'movie',
  'tv show', 'sports', 'game', 'concert', 'festival', 'wedding',
  'vacation', 'travel tips', 'life hack', 'self-care', 'wellness',
  'strikes deal', 'strikes agreement', 'strikes partnership',
];

const SHORT_KEYWORDS = new Set([
  'war', 'coup', 'ban', 'vote', 'riot', 'riots', 'hack', 'talks', 'ipo', 'gdp',
  'virus', 'disease', 'flood', 'strikes',
]);

const TRAILING_BOUNDARY_KEYWORDS = new Set([
  'attack iran', 'attacked iran', 'attack on iran', 'attack against iran',
  'attacks on iran', 'launch attacks on iran', 'launch attack on iran',
  'bombing iran', 'bombed iran', 'strikes iran', 'attacks iran',
  'bombs iran', 'war on iran', 'war with iran', 'war against iran',
  'iran retaliates', 'iran strikes', 'iran launches', 'iran attacks',
]);

const keywordRegexCache = new Map<string, RegExp>();

function getKeywordRegex(kw: string): RegExp {
  let re = keywordRegexCache.get(kw);
  if (!re) {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (SHORT_KEYWORDS.has(kw)) {
      re = new RegExp(`\\b${escaped}\\b`);
    } else if (TRAILING_BOUNDARY_KEYWORDS.has(kw)) {
      re = new RegExp(`${escaped}(?![\\w-])`);
    } else {
      re = new RegExp(escaped);
    }
    keywordRegexCache.set(kw, re);
  }
  return re;
}

function matchKeywords(
  titleLower: string,
  keywords: KeywordMap
): { keyword: string; category: EventCategory } | null {
  for (const [kw, cat] of Object.entries(keywords)) {
    if (getKeywordRegex(kw).test(titleLower)) {
      return { keyword: kw, category: cat };
    }
  }
  return null;
}

// Compound escalation: HIGH military/conflict + critical geopolitical target → CRITICAL
// Handles headlines like "strikes by US and Israel on Iran" where words aren't adjacent
const ESCALATION_ACTIONS = /\b(attack|attacks|attacked|strike|strikes|struck|bomb|bombs|bombed|bombing|shell|shelled|shelling|missile|missiles|intercept|intercepted|retaliates|retaliating|retaliation|killed|casualties|offensive|invaded|invades)\b/;
const ESCALATION_TARGETS = /\b(iran|tehran|isfahan|tabriz|russia|moscow|china|beijing|taiwan|taipei|north korea|pyongyang|nato|us base|us forces|american forces|us military)\b/;

function shouldEscalateToCritical(lower: string, matchCat: EventCategory): boolean {
  if (matchCat !== 'conflict' && matchCat !== 'military') return false;
  return ESCALATION_ACTIONS.test(lower) && ESCALATION_TARGETS.test(lower);
}

export function classifyByKeyword(title: string, variant = 'full'): ThreatClassification {
  const lower = title.toLowerCase();

  if (EXCLUSIONS.some(ex => lower.includes(ex))) {
    return { level: 'info', category: 'general', confidence: 0.3, source: 'keyword' };
  }

  const isTech = variant === 'tech';

  // Priority cascade: critical → high → medium → low → info
  let match = matchKeywords(lower, CRITICAL_KEYWORDS);
  if (match) return { level: 'critical', category: match.category, confidence: 0.9, source: 'keyword' };

  match = matchKeywords(lower, HIGH_KEYWORDS);
  if (match) {
    // Compound escalation: military action + critical geopolitical target → CRITICAL
    if (shouldEscalateToCritical(lower, match.category)) {
      return { level: 'critical', category: match.category, confidence: 0.85, source: 'keyword' };
    }
    return { level: 'high', category: match.category, confidence: 0.8, source: 'keyword' };
  }

  if (isTech) {
    match = matchKeywords(lower, TECH_HIGH_KEYWORDS);
    if (match) return { level: 'high', category: match.category, confidence: 0.75, source: 'keyword' };
  }

  match = matchKeywords(lower, MEDIUM_KEYWORDS);
  if (match) return { level: 'medium', category: match.category, confidence: 0.7, source: 'keyword' };

  if (isTech) {
    match = matchKeywords(lower, TECH_MEDIUM_KEYWORDS);
    if (match) return { level: 'medium', category: match.category, confidence: 0.65, source: 'keyword' };
  }

  match = matchKeywords(lower, LOW_KEYWORDS);
  if (match) return { level: 'low', category: match.category, confidence: 0.6, source: 'keyword' };

  if (isTech) {
    match = matchKeywords(lower, TECH_LOW_KEYWORDS);
    if (match) return { level: 'low', category: match.category, confidence: 0.55, source: 'keyword' };
  }

  return { level: 'info', category: 'general', confidence: 0.3, source: 'keyword' };
}

// ── Relay-pushed classifications (from ai:classifications channel) ────────────
// The relay pre-classifies headlines via Ollama and pushes them as:
// { [fnv1a(title.toLowerCase())]: { level, category, title, generatedAt } }
// Check this cache before making any API calls.

const VALID_LEVELS: Record<string, ThreatLevel> = {
  critical: 'critical', high: 'high', medium: 'medium', low: 'low', info: 'info',
};

// FNV-1a hash — must match simpleHash() in ais-relay.cjs
function fnv1aHash(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

type RelayClassification = {
  level: string;
  category: string;
  title?: string;
  generatedAt?: string;
};

function getRelayClassifications(): Record<string, RelayClassification> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (window as any).__wmRelayClassifications as Record<string, RelayClassification> ?? {};
}

function lookupRelayClassification(title: string): ThreatClassification | null {
  const cache = getRelayClassifications();
  const hash = fnv1aHash(title.toLowerCase());
  const entry = cache[hash];
  if (!entry) return null;
  const level = VALID_LEVELS[entry.level] ?? null;
  if (!level) return null;
  return {
    level,
    category: entry.category as EventCategory,
    confidence: 0.9,
    source: 'llm',
  };
}

// ── classifyWithAI: relay-first, no Vercel fallback ─────────────────────────
// Classifications come from the relay's `ai:classifications` push (pre-computed
// by the Ollama cron). If the relay hasn't classified a headline yet, return
// null — the keyword fallback in classifyThreat() will cover it.

export function classifyWithAI(
  title: string,
  _variant: string
): Promise<ThreatClassification | null> {
  // Fast path: relay has already classified this headline
  const relayResult = lookupRelayClassification(title);
  if (relayResult) return Promise.resolve(relayResult);

  // Not in relay cache yet — return null, let keyword classification handle it.
  // The relay will classify it within the next 5-minute cron window and push
  // the result via the ai:classifications WebSocket channel.
  return Promise.resolve(null);
}
