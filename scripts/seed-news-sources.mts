// scripts/seed-news-sources.mts
import { createClient } from '@supabase/supabase-js';
// Static feed data for seeding — runtime config comes from Supabase via feed-client
const { SOURCE_TIERS, FULL_FEEDS, TECH_FEEDS, FINANCE_FEEDS, HAPPY_FEEDS, INTEL_SOURCES } =
  await import('../src/config/feeds-seed.ts');

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

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
  dict: Record<
    string,
    Array<{
      name: string;
      url: string | Record<string, string>;
      type?: string;
      lang?: string;
    }>
  >,
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

addFeeds(FULL_FEEDS, 'full');
addFeeds(TECH_FEEDS, 'tech');
addFeeds(FINANCE_FEEDS, 'finance');
addFeeds(HAPPY_FEEDS, 'happy');

for (const f of INTEL_SOURCES) {
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

const records = [...feedMap.entries()].map(([name, data]) => ({
  name,
  url: data.url,
  tier: data.tier,
  variants: [...data.variants],
  category: data.category,
  source_type: data.source_type,
  lang: data.lang,
  proxy_mode:
    typeof data.url === 'string' && data.url.includes('rss-proxy')
      ? 'rss'
      : 'direct',
  enabled: true,
}));

console.log(`Seeding ${records.length} news sources…`);

for (let i = 0; i < records.length; i += 100) {
  const batch = records.slice(i, i + 100);
  const { error } = await supabase
    .schema('wm_admin')
    .from('news_sources')
    .upsert(batch, { onConflict: 'name' });

  if (error) {
    console.error('Batch failed:', error);
    process.exit(1);
  }
  console.log(
    `  Seeded batch ${Math.floor(i / 100) + 1} (${i}–${i + batch.length})`,
  );
}

console.log('Done.');
