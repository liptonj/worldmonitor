// scripts/generate-seed-sql.mts
// Generates SQL INSERT statements for wm_admin.news_sources from the static feed data
import {
  FULL_FEEDS,
  TECH_FEEDS,
  FINANCE_FEEDS,
  HAPPY_FEEDS,
  INTEL_SOURCES,
  SOURCE_TIERS,
} from '../src/config/feeds-seed.ts';

type FeedEntry = {
  name: string;
  url: string | Record<string, string>;
  lang?: string;
  type?: string;
};

const feedMap = new Map<
  string,
  {
    url: string | Record<string, string>;
    tier: number;
    variants: Set<string>;
    category: string;
    source_type: string | null;
    lang: string;
  }
>();

function addFeeds(
  dict: Record<string, FeedEntry[]>,
  variant: string,
): void {
  for (const [category, feeds] of Object.entries(dict)) {
    for (const f of feeds) {
      if (!feedMap.has(f.name)) {
        feedMap.set(f.name, {
          url: f.url,
          tier: SOURCE_TIERS[f.name] ?? 3,
          variants: new Set([variant]),
          category,
          source_type: null,
          lang: f.lang ?? 'en',
        });
      } else {
        feedMap.get(f.name)!.variants.add(variant);
      }
    }
  }
}

addFeeds(FULL_FEEDS as Record<string, FeedEntry[]>, 'full');
addFeeds(TECH_FEEDS as Record<string, FeedEntry[]>, 'tech');
addFeeds(FINANCE_FEEDS as Record<string, FeedEntry[]>, 'finance');
addFeeds(HAPPY_FEEDS as Record<string, FeedEntry[]>, 'happy');

for (const f of INTEL_SOURCES as FeedEntry[]) {
  if (!feedMap.has(f.name)) {
    feedMap.set(f.name, {
      url: f.url,
      tier: SOURCE_TIERS[f.name] ?? 3,
      variants: new Set(['full']),
      category: 'intel',
      source_type: (f as { type?: string }).type ?? null,
      lang: (f as { lang?: string }).lang ?? 'en',
    });
  }
}

const esc = (s: string) => s.replace(/'/g, "''");

const rows: string[] = [];
for (const [name, data] of feedMap) {
  const urlJson = esc(JSON.stringify(data.url));
  const proxyMode =
    typeof data.url === 'string' && data.url.includes('rss-proxy')
      ? 'rss'
      : 'direct';
  const variants = `{${[...data.variants].join(',')}}`;
  const st = data.source_type ? `'${esc(data.source_type)}'` : 'NULL';
  rows.push(
    `('${esc(name)}','${urlJson}'::jsonb,${data.tier},'{${[...data.variants].join(',')}}','${esc(data.category)}','${esc(data.lang)}','${proxyMode}',${st},true)`,
  );
}

const sql = `INSERT INTO wm_admin.news_sources
  (name, url, tier, variants, category, lang, proxy_mode, source_type, enabled)
VALUES
${rows.join(',\n')}
ON CONFLICT (name) DO UPDATE SET
  url        = EXCLUDED.url,
  tier       = EXCLUDED.tier,
  variants   = EXCLUDED.variants,
  category   = EXCLUDED.category,
  lang       = EXCLUDED.lang,
  proxy_mode = EXCLUDED.proxy_mode,
  source_type = EXCLUDED.source_type,
  enabled    = true;`;

process.stdout.write(sql);
