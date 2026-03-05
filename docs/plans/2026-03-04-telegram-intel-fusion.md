# Telegram Intelligence Fusion Engine — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform raw Telegram OSINT posts into enriched, cross-referenced intelligence with situation cards, news lead-time tracking, channel credibility scoring, and an OSINT map layer.

**Architecture:** The relay server (`scripts/ais-relay.cjs`) handles all LLM enrichment and fusion logic server-side, storing hot data in Upstash Redis and archiving to Supabase. The frontend reads enriched data via the existing `/telegram/feed` endpoint and renders badges, situation cards, and a new OSINT map layer. Ollama (Qwen3 at `ollama.5ls.us`) powers enrichment, news matching, and fusion assessments.

**Tech Stack:** Node.js (CJS relay), Upstash Redis REST, Supabase (PostgreSQL), Ollama/Qwen3-14B, TypeScript (frontend), deck.gl (map layer)

---

## Context & Conventions

### Relay server (`scripts/ais-relay.cjs`)
- Single CJS file (~145K chars). All new logic added as functions in this file.
- Uses Upstash Redis REST via `upstashGet(key)` / `upstashSet(key, value, ttlSeconds)`.
- Telegram items stored in-memory as `telegramState.items[]`.
- Current item shape: `{ id, source, channel, channelTitle, url, ts, text, topic, tags, earlySignal }`.
- Headlines sent to Vercel via `ingestTelegramHeadlines(messages)` hitting `/api/cron/ingest-headlines`.
- Env vars for Ollama: `OLLAMA_API_URL`, `OLLAMA_MODEL`, `OLLAMA_CF_ACCESS_CLIENT_ID`, `OLLAMA_CF_ACCESS_CLIENT_SECRET`.

### Supabase
- Migrations go in `supabase/migrations/YYYYMMDDHHMMSS_name.sql`.
- Follow existing pattern: `create table`, `create index`, RLS policies.
- Skill reference: @create-migration, @create-rls-policies

### Frontend
- TypeScript. `TelegramItem` defined in `src/services/telegram-intel.ts`.
- Panel component: `src/components/TelegramIntelPanel.ts` (vanilla DOM, no React).
- Map: deck.gl via `src/components/DeckGLMap.ts`. Layers toggle via `MapLayers` in `src/types/index.ts`.
- Layer config: `src/config/panels.ts` (`FULL_MAP_LAYERS`, `LAYER_TO_SOURCE`).

### Ollama LLM budget

| Task | Mode | max_tokens | Prompt suffix |
|------|------|------------|---------------|
| Enrichment | `/nothink` | 150 | Append ` /nothink` to user message |
| Fusion assessment | `/think` | 1500 | Append ` /think` to user message |
| News matching | `/think` | 500 | Append ` /think` to user message |

### Rate limits (relay-side)
- Enrichment: ≤30 items per 60s poll cycle
- Fusion assessment: ≤5 per 5 minutes
- News matching: ≤10 per 5 minutes

---

## Task 1: Supabase Migrations

**Files:**
- Create: `supabase/migrations/20260305000001_telegram_news_matches.sql`
- Create: `supabase/migrations/20260305000002_telegram_channel_scores.sql`
- Create: `supabase/migrations/20260305000003_telegram_situation_cards.sql`

### Step 1: Create telegram_news_matches migration

Create `supabase/migrations/20260305000001_telegram_news_matches.sql`:

```sql
create table if not exists public.telegram_news_matches (
  id uuid primary key default gen_random_uuid(),
  telegram_item_id text not null,
  telegram_channel text not null,
  telegram_text text not null,
  telegram_ts timestamptz not null,
  news_headline text not null,
  news_source text,
  news_ts timestamptz not null,
  lead_time_minutes integer not null,
  match_method text not null check (match_method in ('entity_overlap', 'llm_semantic', 'sensor_fusion')),
  confidence text not null check (confidence in ('high', 'medium', 'low')),
  corroborating_source_count integer default 0,
  created_at timestamptz default now()
);

create index idx_telegram_matches_channel on public.telegram_news_matches(telegram_channel);
create index idx_telegram_matches_created on public.telegram_news_matches(created_at desc);
create index idx_telegram_matches_item on public.telegram_news_matches(telegram_item_id);

alter table public.telegram_news_matches enable row level security;

create policy "anon_read_telegram_news_matches"
  on public.telegram_news_matches for select
  to anon, authenticated
  using (true);

create policy "service_insert_telegram_news_matches"
  on public.telegram_news_matches for insert
  to service_role
  with check (true);
```

### Step 2: Create telegram_channel_scores migration

Create `supabase/migrations/20260305000002_telegram_channel_scores.sql`:

```sql
create table if not exists public.telegram_channel_scores (
  handle text primary key,
  label text,
  topic text,
  region text,
  total_posts integer default 0,
  confirmed_by_news integer default 0,
  confirmed_by_sensors integer default 0,
  unconfirmed_after_24h integer default 0,
  avg_lead_time_minutes numeric,
  min_lead_time_minutes numeric,
  reliability_score numeric default 50.0,
  last_scored_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.telegram_channel_scores enable row level security;

create policy "anon_read_channel_scores"
  on public.telegram_channel_scores for select
  to anon, authenticated
  using (true);

create policy "service_upsert_channel_scores"
  on public.telegram_channel_scores for all
  to service_role
  using (true)
  with check (true);
```

### Step 3: Create telegram_situation_cards migration

Create `supabase/migrations/20260305000003_telegram_situation_cards.sql`:

```sql
create table if not exists public.telegram_situation_cards (
  id uuid primary key default gen_random_uuid(),
  telegram_item_id text not null,
  channel_handle text not null,
  confidence text not null check (confidence in ('high', 'medium', 'low')),
  threat_level text not null check (threat_level in ('critical', 'high', 'medium', 'low', 'info')),
  narrative_arc text not null check (narrative_arc in ('emerging', 'developing', 'confirmed', 'escalating', 'de-escalating')),
  assessment_text text not null,
  watch_items jsonb default '[]'::jsonb,
  location_name text,
  lat numeric,
  lon numeric,
  corroborating_sources jsonb not null default '[]'::jsonb,
  lead_time_minutes integer,
  lead_time_status text not null check (lead_time_status in ('exclusive', 'possibly_related', 'confirmed')),
  news_headline text,
  news_matched_at timestamptz,
  model text not null,
  expires_at timestamptz not null,
  created_at timestamptz default now()
);

create index idx_situation_cards_channel on public.telegram_situation_cards(channel_handle);
create index idx_situation_cards_created on public.telegram_situation_cards(created_at desc);
create index idx_situation_cards_expires on public.telegram_situation_cards(expires_at);

alter table public.telegram_situation_cards enable row level security;

create policy "anon_read_situation_cards"
  on public.telegram_situation_cards for select
  to anon, authenticated
  using (true);

create policy "service_insert_situation_cards"
  on public.telegram_situation_cards for insert
  to service_role
  with check (true);
```

### Step 4: Apply migrations locally

Run: `npx supabase db push` (or `npx supabase migration up` depending on setup)
Expected: 3 tables created successfully

### Step 5: Commit

```bash
git add supabase/migrations/20260305000001_telegram_news_matches.sql \
        supabase/migrations/20260305000002_telegram_channel_scores.sql \
        supabase/migrations/20260305000003_telegram_situation_cards.sql
git commit -m "feat: add telegram intel fusion database tables"
```

---

## Task 2: Relay — Ollama Enrichment

**Files:**
- Modify: `scripts/ais-relay.cjs` (add enrichment functions after `normalizeTelegramMessage`)

### Step 1: Add Ollama config constants and helper

Add after the existing `TELEGRAM_MAX_TEXT_CHARS` constant block (around line 239):

```javascript
// ─────────────────────────────────────────────────────────────
// Telegram Ollama Enrichment
// ─────────────────────────────────────────────────────────────
const OLLAMA_API_URL = (process.env.OLLAMA_API_URL || 'https://ollama.5ls.us').replace(/\/$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3-wm';
const OLLAMA_CF_CLIENT_ID = process.env.OLLAMA_CF_ACCESS_CLIENT_ID || '';
const OLLAMA_CF_CLIENT_SECRET = process.env.OLLAMA_CF_ACCESS_CLIENT_SECRET || '';
const ENRICHMENT_MAX_PER_CYCLE = 30;
const ENRICHMENT_ENABLED = Boolean(OLLAMA_API_URL && OLLAMA_MODEL);

let enrichmentStats = {
  totalEnriched: 0,
  totalFailed: 0,
  lastEnrichedAt: 0,
  lastError: null,
};
```

### Step 2: Add the Ollama chat helper

```javascript
async function ollamaChat(messages, maxTokens, thinkMode) {
  const suffix = thinkMode ? ' /think' : ' /nothink';
  const lastMsg = messages[messages.length - 1];
  if (lastMsg && lastMsg.role === 'user') {
    lastMsg.content = lastMsg.content + suffix;
  }

  const headers = { 'Content-Type': 'application/json' };
  if (OLLAMA_CF_CLIENT_ID) headers['CF-Access-Client-Id'] = OLLAMA_CF_CLIENT_ID;
  if (OLLAMA_CF_CLIENT_SECRET) headers['CF-Access-Client-Secret'] = OLLAMA_CF_CLIENT_SECRET;

  const body = JSON.stringify({
    model: OLLAMA_MODEL,
    messages,
    stream: false,
    options: { num_predict: maxTokens },
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), thinkMode ? 60_000 : 30_000);

  try {
    const res = await fetch(`${OLLAMA_API_URL}/api/chat`, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Ollama ${res.status}: ${text.slice(0, 200)}`);
    }

    const json = await res.json();
    const content = json?.message?.content || '';
    return content;
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}
```

### Step 3: Add the enrichment function

```javascript
const ENRICHMENT_PROMPT = `Extract from this OSINT post. Return ONLY valid JSON, no markdown:
{"location":"specific place name or null","lat":null,"lon":null,"entities":["entity1"],"eventType":"strike|protest|disaster|diplomatic|military|cyber|maritime|nuclear|infrastructure|other","urgency":"critical|high|medium|low","summary":"one sentence max 20 words"}

Post: "{TEXT}"`;

async function enrichTelegramItem(item) {
  if (!ENRICHMENT_ENABLED) return null;
  if (!item || !item.text || item.text.length < 20) return null;

  try {
    const prompt = ENRICHMENT_PROMPT.replace('{TEXT}', item.text.slice(0, 600).replace(/"/g, '\\"'));
    const raw = await ollamaChat(
      [{ role: 'user', content: prompt }],
      150,
      false
    );

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      location: parsed.location || null,
      lat: typeof parsed.lat === 'number' ? parsed.lat : null,
      lon: typeof parsed.lon === 'number' ? parsed.lon : null,
      entities: Array.isArray(parsed.entities) ? parsed.entities.slice(0, 10) : [],
      eventType: parsed.eventType || 'other',
      urgency: ['critical', 'high', 'medium', 'low'].includes(parsed.urgency) ? parsed.urgency : 'low',
      summary: typeof parsed.summary === 'string' ? parsed.summary.slice(0, 100) : '',
      enrichedAt: new Date().toISOString(),
    };
  } catch (e) {
    enrichmentStats.totalFailed++;
    enrichmentStats.lastError = e?.message || String(e);
    console.warn('[Relay] Enrichment failed for', item.id, ':', enrichmentStats.lastError);
    return null;
  }
}
```

### Step 4: Add batch enrichment integrated into poll cycle

```javascript
async function enrichNewItems(newItems) {
  if (!ENRICHMENT_ENABLED || !newItems.length) return;

  const toEnrich = newItems
    .filter(item => !item.enrichment && item.text && item.text.length >= 20)
    .slice(0, ENRICHMENT_MAX_PER_CYCLE);

  if (!toEnrich.length) return;

  let enriched = 0;
  for (const item of toEnrich) {
    try {
      const result = await enrichTelegramItem(item);
      if (result) {
        item.enrichment = result;
        item.matchStatus = 'unmatched';
        enriched++;
        enrichmentStats.totalEnriched++;
      }
    } catch { /* already logged in enrichTelegramItem */ }

    await new Promise(r => setTimeout(r, 200));
  }

  enrichmentStats.lastEnrichedAt = Date.now();
  console.log(`[Relay] Enriched ${enriched}/${toEnrich.length} telegram items`);
}
```

### Step 5: Wire enrichment into `pollTelegramOnce`

In the existing `pollTelegramOnce` function, find the block after `if (newItems.length)` (around line 479) and add the enrichment call:

```javascript
// After: ingestTelegramHeadlines(newItems);
// Add:
enrichNewItems(newItems).catch(e =>
  console.warn('[Relay] enrichNewItems error:', e?.message || e)
);
```

### Step 6: Update the `/telegram/feed` response to include enriched fields

In the Telegram feed handler (around line 3204), update the item serialization to include enrichment data:

```javascript
// The items already have enrichment attached in-memory, so they serialize automatically.
// But we also need to expose enrichment stats. Add to the response object:
// After "items: filtered," add:
//   enrichmentEnabled: ENRICHMENT_ENABLED,
//   enrichmentStats: { total: enrichmentStats.totalEnriched, failed: enrichmentStats.totalFailed },
```

### Step 7: Store enriched items in Redis for other services to read

```javascript
async function persistEnrichedItemsToRedis() {
  if (!UPSTASH_ENABLED) return;

  const enrichedItems = (telegramState.items || [])
    .filter(item => item.enrichment)
    .slice(0, 100);

  if (!enrichedItems.length) return;

  try {
    await upstashSet('wm:telegram:enriched', {
      items: enrichedItems,
      updatedAt: new Date().toISOString(),
      count: enrichedItems.length,
    }, 300);
  } catch (e) {
    console.warn('[Relay] Failed to persist enriched items to Redis:', e?.message || e);
  }
}
```

Call `persistEnrichedItemsToRedis()` at the end of `enrichNewItems` after the loop completes.

### Step 8: Verify enrichment works

Run relay locally, check logs for `[Relay] Enriched X/Y telegram items`.
Run: `curl http://localhost:3001/telegram/feed?limit=5 | jq '.items[0].enrichment'`
Expected: JSON with location, entities, eventType, urgency, summary fields.

### Step 9: Commit

```bash
git add scripts/ais-relay.cjs
git commit -m "feat: add Ollama enrichment to Telegram relay pipeline"
```

---

## Task 3: Relay — News Matching

**Files:**
- Modify: `scripts/ais-relay.cjs` (add news matching functions)

### Step 1: Add news matching state and rate limit tracking

```javascript
// ─────────────────────────────────────────────────────────────
// Telegram ↔ News Matching
// ─────────────────────────────────────────────────────────────
const NEWS_MATCH_INTERVAL_MS = 5 * 60 * 1000;
const NEWS_MATCH_MAX_PER_CYCLE = 10;

let newsMatchState = {
  lastMatchCycleAt: 0,
  totalMatched: 0,
  totalLlmCalls: 0,
  cachedHeadlines: [],
  cachedHeadlinesAt: 0,
};
```

### Step 2: Fetch headlines from Redis for matching

```javascript
async function fetchHeadlinesForMatching() {
  if (!UPSTASH_ENABLED) return [];
  if (Date.now() - newsMatchState.cachedHeadlinesAt < 60_000 && newsMatchState.cachedHeadlines.length) {
    return newsMatchState.cachedHeadlines;
  }

  const headlines = [];
  const scopes = ['global', 'conflict', 'middleeast', 'politics', 'breaking'];

  for (const scope of scopes) {
    try {
      const raw = await upstashLrange(`wm:headlines:${scope}`, 0, 49);
      if (Array.isArray(raw)) {
        for (const item of raw) {
          try {
            const parsed = typeof item === 'string' ? JSON.parse(item) : item;
            if (parsed && parsed.title) {
              headlines.push({
                title: parsed.title,
                pubDate: parsed.pubDate || 0,
                scope,
              });
            }
          } catch { /* skip malformed */ }
        }
      }
    } catch { /* non-fatal */ }
  }

  const seen = new Set();
  newsMatchState.cachedHeadlines = headlines.filter(h => {
    if (seen.has(h.title)) return false;
    seen.add(h.title);
    return true;
  });
  newsMatchState.cachedHeadlinesAt = Date.now();
  return newsMatchState.cachedHeadlines;
}
```

NOTE: The relay currently only has `upstashGet`/`upstashSet`. You need to add an `upstashLrange` helper that calls the Upstash REST API `LRANGE` command:

```javascript
function upstashLrange(key, start, stop) {
  return new Promise((resolve) => {
    if (!UPSTASH_ENABLED) return resolve([]);
    const url = new URL('/', UPSTASH_REDIS_REST_URL);
    const body = JSON.stringify(['LRANGE', key, String(start), String(stop)]);
    const req = require('https').request(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
        'Content-Type': 'application/json',
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed?.result || []);
        } catch { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.end(body);
  });
}
```

### Step 3: Entity-based fast matching

```javascript
function entityOverlapMatch(item, headlines) {
  if (!item.enrichment || !item.enrichment.entities.length) return [];

  const itemEntities = new Set(item.enrichment.entities.map(e => e.toLowerCase()));
  const matches = [];

  for (const h of headlines) {
    const headlineLower = h.title.toLowerCase();
    let overlap = 0;
    for (const entity of itemEntities) {
      if (entity.length >= 3 && headlineLower.includes(entity)) overlap++;
    }
    if (overlap >= 1) {
      const leadTimeMinutes = Math.round(
        (h.pubDate * 1000 - new Date(item.ts).getTime()) / 60_000
      );
      matches.push({
        headline: h.title,
        scope: h.scope,
        pubDate: h.pubDate,
        overlap,
        leadTimeMinutes,
      });
    }
  }

  return matches.sort((a, b) => b.overlap - a.overlap).slice(0, 3);
}
```

### Step 4: LLM semantic matching

```javascript
const NEWS_MATCH_PROMPT = `Do these describe the same event? Answer ONLY with valid JSON:
{"same_event":true|false,"confidence":"high|medium|low","reasoning":"one sentence"}

Telegram post: "{TELEGRAM_TEXT}"
News headline: "{NEWS_HEADLINE}"`;

async function llmNewsMatch(telegramText, newsHeadline) {
  const prompt = NEWS_MATCH_PROMPT
    .replace('{TELEGRAM_TEXT}', telegramText.slice(0, 300).replace(/"/g, '\\"'))
    .replace('{NEWS_HEADLINE}', newsHeadline.slice(0, 200).replace(/"/g, '\\"'));

  const raw = await ollamaChat(
    [{ role: 'user', content: prompt }],
    500,
    true
  );

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  const parsed = JSON.parse(jsonMatch[0]);
  return {
    sameEvent: Boolean(parsed.same_event),
    confidence: ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'low',
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning.slice(0, 200) : '',
  };
}
```

### Step 5: News matching cycle

```javascript
async function runNewsMatchCycle() {
  if (!ENRICHMENT_ENABLED || !UPSTASH_ENABLED) return;
  if (Date.now() - newsMatchState.lastMatchCycleAt < NEWS_MATCH_INTERVAL_MS) return;
  newsMatchState.lastMatchCycleAt = Date.now();

  const headlines = await fetchHeadlinesForMatching();
  if (!headlines.length) return;

  const unmatchedItems = (telegramState.items || [])
    .filter(item => item.enrichment && item.matchStatus === 'unmatched')
    .sort((a, b) => {
      const urgencyOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      return (urgencyOrder[a.enrichment?.urgency] || 3) - (urgencyOrder[b.enrichment?.urgency] || 3);
    })
    .slice(0, NEWS_MATCH_MAX_PER_CYCLE);

  if (!unmatchedItems.length) return;

  let matched = 0;
  for (const item of unmatchedItems) {
    const entityMatches = entityOverlapMatch(item, headlines);

    if (entityMatches.length > 0) {
      const best = entityMatches[0];
      if (best.overlap >= 2) {
        item.matchStatus = 'confirmed';
        item.matchedNewsHeadline = best.headline;
        item.matchedAt = new Date().toISOString();
        item.leadTimeMinutes = best.leadTimeMinutes;
        matched++;
        await archiveMatch(item, best.headline, best.leadTimeMinutes, 'entity_overlap', 'high');
        continue;
      }

      // Single entity overlap: try LLM confirmation
      try {
        const llmResult = await llmNewsMatch(item.text, best.headline);
        newsMatchState.totalLlmCalls++;
        if (llmResult && llmResult.sameEvent) {
          item.matchStatus = llmResult.confidence === 'high' ? 'confirmed' : 'possibly_related';
          item.matchedNewsHeadline = best.headline;
          item.matchedAt = new Date().toISOString();
          item.leadTimeMinutes = best.leadTimeMinutes;
          matched++;
          await archiveMatch(item, best.headline, best.leadTimeMinutes, 'llm_semantic', llmResult.confidence);
        }
      } catch (e) {
        console.warn('[Relay] LLM news match failed:', e?.message || e);
      }

      await new Promise(r => setTimeout(r, 500));
    }
  }

  newsMatchState.totalMatched += matched;
  if (matched > 0) {
    console.log(`[Relay] News matching: ${matched} matches found in cycle`);
    persistEnrichedItemsToRedis().catch(() => {});
  }
}
```

### Step 6: Archive matches to Supabase

```javascript
async function archiveMatch(item, newsHeadline, leadTimeMinutes, matchMethod, confidence) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) return;

  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/telegram_news_matches`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        telegram_item_id: item.id,
        telegram_channel: item.channel,
        telegram_text: item.text.slice(0, 1000),
        telegram_ts: item.ts,
        news_headline: newsHeadline.slice(0, 500),
        news_source: null,
        news_ts: new Date().toISOString(),
        lead_time_minutes: leadTimeMinutes,
        match_method: matchMethod,
        confidence,
        corroborating_source_count: (item.corroboration?.sources?.length) || 0,
      }),
    });
    if (!res.ok) {
      console.warn('[Relay] Failed to archive match:', res.status);
    }
  } catch (e) {
    console.warn('[Relay] archiveMatch error:', e?.message || e);
  }
}
```

### Step 7: Wire news matching into the poll cycle

In `guardedTelegramPoll` or at the end of `pollTelegramOnce`, add:

```javascript
runNewsMatchCycle().catch(e =>
  console.warn('[Relay] News match cycle error:', e?.message || e)
);
```

### Step 8: Verify news matching

Run relay, wait for enrichment, then check for match logs.
Run: `curl http://localhost:3001/telegram/feed?limit=10 | jq '[.items[] | select(.matchStatus != null) | {id, matchStatus, matchedNewsHeadline, leadTimeMinutes}]'`
Expected: Items with `matchStatus` of "confirmed", "possibly_related", or "unmatched".

### Step 9: Commit

```bash
git add scripts/ais-relay.cjs
git commit -m "feat: add entity + LLM news matching for Telegram items"
```

---

## Task 4: Relay — Cross-Source Fusion Engine

**Files:**
- Modify: `scripts/ais-relay.cjs` (add fusion functions)

This task correlates enriched Telegram items with other real-time sensor data from the relay (OREF, UCDP, AIS disruptions, etc.) and generates situation cards via LLM fusion assessment.

### Step 1: Add fusion state and constants

```javascript
// ─────────────────────────────────────────────────────────────
// Intelligence Fusion Engine
// ─────────────────────────────────────────────────────────────
const FUSION_INTERVAL_MS = 5 * 60 * 1000;
const FUSION_MAX_PER_CYCLE = 5;
const FUSION_GEO_RADIUS_KM = 200;
const FUSION_TIME_WINDOW_MS = 4 * 60 * 60 * 1000;

let fusionState = {
  lastFusionAt: 0,
  situationCards: [],
  totalAssessments: 0,
};
```

### Step 2: Add geo-distance helper

```javascript
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
```

### Step 3: Gather corroborating signals

This function checks in-memory relay state for signals near the Telegram item's extracted location. Access the relay's existing state objects (`orefState`, `ucdpState`, etc.) to find nearby events.

```javascript
function gatherCorroboratingSources(item) {
  const sources = [];
  const enrichment = item.enrichment;
  if (!enrichment || enrichment.lat == null || enrichment.lon == null) return sources;

  const itemLat = enrichment.lat;
  const itemLon = enrichment.lon;
  const itemTs = new Date(item.ts).getTime();
  const cutoff = itemTs - FUSION_TIME_WINDOW_MS;

  // UCDP conflict events (if available in relay state)
  // The relay stores UCDP events via upstashSet('wm:ucdp:events', ...).
  // For fusion, we check against recently cached events.

  // OREF alerts (Israel sirens — already in orefState.history)
  if (typeof orefState !== 'undefined' && Array.isArray(orefState.history)) {
    for (const wave of orefState.history) {
      const waveTs = new Date(wave.timestamp).getTime();
      if (waveTs < cutoff) continue;
      if (!Array.isArray(wave.alerts)) continue;
      for (const alert of wave.alerts) {
        if (alert.lat != null && alert.lon != null) {
          const dist = haversineKm(itemLat, itemLon, alert.lat, alert.lon);
          if (dist <= FUSION_GEO_RADIUS_KM) {
            sources.push({
              type: 'news',
              summary: `OREF siren alert: ${alert.data || 'unknown threat'} in ${alert.title || 'unknown location'}`,
              timestamp: wave.timestamp,
              distance_km: Math.round(dist),
            });
            break;
          }
        }
      }
    }
  }

  return sources;
}
```

### Step 4: LLM fusion assessment

```javascript
const FUSION_PROMPT = `You are a senior intelligence analyst. Assess this OSINT report against corroborating data.

OSINT REPORT (Telegram):
Source: {CHANNEL} (topic: {TOPIC})
Time: {TIMESTAMP}
Text: "{TEXT}"
Location: {LOCATION} ({LAT}, {LON})
Extracted entities: {ENTITIES}

CORROBORATING SIGNALS:
{SIGNALS}

MAINSTREAM NEWS STATUS:
{NEWS_STATUS}

Return ONLY valid JSON:
{"confidence":"high|medium|low","leadTimeStatus":"exclusive|possibly_related|confirmed","assessmentText":"2-3 sentence intelligence assessment","watchItems":["what to monitor"],"threatLevel":"critical|high|medium|low|info","narrativeArc":"emerging|developing|confirmed|escalating|de-escalating"}`;

async function generateFusionAssessment(item) {
  const enrichment = item.enrichment;
  const corroborating = gatherCorroboratingSources(item);
  const newsStatus = item.matchedNewsHeadline
    ? `Confirmed in mainstream news: "${item.matchedNewsHeadline}" (lead time: ${item.leadTimeMinutes || '?'} min)`
    : 'No mainstream coverage yet — potential exclusive';

  const signalsText = corroborating.length > 0
    ? corroborating.map((s, i) => `${i + 1}. [${s.type}] ${s.summary} (${s.timestamp}, ${s.distance_km || '?'}km)`).join('\n')
    : 'No corroborating sensor data found within 200km / 4h window.';

  const prompt = FUSION_PROMPT
    .replace('{CHANNEL}', item.channelTitle || item.channel)
    .replace('{TOPIC}', item.topic || 'unknown')
    .replace('{TIMESTAMP}', item.ts)
    .replace('{TEXT}', item.text.slice(0, 400).replace(/"/g, '\\"'))
    .replace('{LOCATION}', enrichment?.location || 'unknown')
    .replace('{LAT}', String(enrichment?.lat || 'null'))
    .replace('{LON}', String(enrichment?.lon || 'null'))
    .replace('{ENTITIES}', (enrichment?.entities || []).join(', ') || 'none')
    .replace('{SIGNALS}', signalsText)
    .replace('{NEWS_STATUS}', newsStatus);

  const raw = await ollamaChat(
    [{ role: 'user', content: prompt }],
    1500,
    true
  );

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  const parsed = JSON.parse(jsonMatch[0]);
  return {
    confidence: parsed.confidence || 'low',
    leadTimeStatus: parsed.leadTimeStatus || 'exclusive',
    assessmentText: parsed.assessmentText || '',
    watchItems: Array.isArray(parsed.watchItems) ? parsed.watchItems.slice(0, 5) : [],
    threatLevel: parsed.threatLevel || 'info',
    narrativeArc: parsed.narrativeArc || 'emerging',
    corroboratingSources: corroborating,
  };
}
```

### Step 5: Fusion cycle

```javascript
async function runFusionCycle() {
  if (!ENRICHMENT_ENABLED) return;
  if (Date.now() - fusionState.lastFusionAt < FUSION_INTERVAL_MS) return;
  fusionState.lastFusionAt = Date.now();

  const candidates = (telegramState.items || [])
    .filter(item => {
      if (!item.enrichment) return false;
      if (!['critical', 'high'].includes(item.enrichment.urgency)) return false;
      if (item.fusionAssessed) return false;
      return true;
    })
    .slice(0, FUSION_MAX_PER_CYCLE);

  if (!candidates.length) return;

  let assessed = 0;
  for (const item of candidates) {
    try {
      const assessment = await generateFusionAssessment(item);
      if (assessment) {
        item.corroboration = {
          sources: assessment.corroboratingSources,
          confidence: assessment.confidence,
          assessmentText: assessment.assessmentText,
        };
        item.fusionAssessed = true;

        const card = {
          id: `sc-${item.id}-${Date.now()}`,
          telegramItemId: item.id,
          channelHandle: item.channel,
          confidence: assessment.confidence,
          threatLevel: assessment.threatLevel,
          narrativeArc: assessment.narrativeArc,
          assessmentText: assessment.assessmentText,
          watchItems: assessment.watchItems,
          locationName: item.enrichment?.location || null,
          lat: item.enrichment?.lat || null,
          lon: item.enrichment?.lon || null,
          corroboratingSources: assessment.corroboratingSources,
          leadTimeMinutes: item.leadTimeMinutes || null,
          leadTimeStatus: assessment.leadTimeStatus,
          newsHeadline: item.matchedNewsHeadline || null,
          newsMatchedAt: item.matchedAt || null,
          model: OLLAMA_MODEL,
          expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
          createdAt: new Date().toISOString(),
        };

        fusionState.situationCards = [card, ...fusionState.situationCards].slice(0, 50);
        assessed++;

        await archiveSituationCard(card);
      }
    } catch (e) {
      console.warn('[Relay] Fusion assessment failed for', item.id, ':', e?.message || e);
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  fusionState.totalAssessments += assessed;
  if (assessed > 0) {
    console.log(`[Relay] Fusion: ${assessed} assessments generated`);
    persistSituationCardsToRedis().catch(() => {});
    persistEnrichedItemsToRedis().catch(() => {});
  }
}
```

### Step 6: Archive situation cards to Supabase

```javascript
async function archiveSituationCard(card) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) return;

  try {
    await fetch(`${supabaseUrl}/rest/v1/telegram_situation_cards`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        telegram_item_id: card.telegramItemId,
        channel_handle: card.channelHandle,
        confidence: card.confidence,
        threat_level: card.threatLevel,
        narrative_arc: card.narrativeArc,
        assessment_text: card.assessmentText,
        watch_items: card.watchItems,
        location_name: card.locationName,
        lat: card.lat,
        lon: card.lon,
        corroborating_sources: card.corroboratingSources,
        lead_time_minutes: card.leadTimeMinutes,
        lead_time_status: card.leadTimeStatus,
        news_headline: card.newsHeadline,
        news_matched_at: card.newsMatchedAt,
        model: card.model,
        expires_at: card.expiresAt,
      }),
    });
  } catch (e) {
    console.warn('[Relay] archiveSituationCard error:', e?.message || e);
  }
}
```

### Step 7: Persist situation cards to Redis

```javascript
async function persistSituationCardsToRedis() {
  if (!UPSTASH_ENABLED) return;
  const active = fusionState.situationCards.filter(
    c => new Date(c.expiresAt) > new Date()
  );
  try {
    await upstashSet('wm:telegram:situations', {
      cards: active,
      updatedAt: new Date().toISOString(),
      count: active.length,
    }, 600);
  } catch (e) {
    console.warn('[Relay] Failed to persist situation cards:', e?.message || e);
  }
}
```

### Step 8: Add `/telegram/situations` endpoint

In the Telegram route handler, add a sub-route for situation cards:

```javascript
// Inside the telegram route handler, before the default feed response:
if (pathname === '/telegram/situations') {
  const active = fusionState.situationCards.filter(
    c => new Date(c.expiresAt) > new Date()
  );
  sendCompressed(req, res, 200, {
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=30',
  }, JSON.stringify({
    cards: active,
    count: active.length,
    updatedAt: fusionState.lastFusionAt ? new Date(fusionState.lastFusionAt).toISOString() : null,
  }));
  return;
}
```

### Step 9: Wire fusion into poll cycle

After `runNewsMatchCycle()` call, add:

```javascript
runFusionCycle().catch(e =>
  console.warn('[Relay] Fusion cycle error:', e?.message || e)
);
```

### Step 10: Commit

```bash
git add scripts/ais-relay.cjs
git commit -m "feat: add cross-source fusion engine with situation cards"
```

---

## Task 5: Relay — Channel Credibility Scoring

**Files:**
- Modify: `scripts/ais-relay.cjs`

### Step 1: Add credibility scoring state

```javascript
// ─────────────────────────────────────────────────────────────
// Channel Credibility Scoring
// ─────────────────────────────────────────────────────────────
const CREDIBILITY_UPDATE_INTERVAL_MS = 30 * 60 * 1000;
let credibilityState = {
  lastUpdateAt: 0,
  scores: Object.create(null),
};
```

### Step 2: Compute credibility score

```javascript
function computeReliabilityScore(stats) {
  const total = stats.total_posts || 1;
  let score = 50.0;

  score += (stats.confirmed_by_news / total) * 30;
  score += (stats.confirmed_by_sensors / total) * 20;
  score -= (stats.unconfirmed_after_24h / total) * 15;

  if (stats.avg_lead_time_minutes != null && stats.avg_lead_time_minutes > 0) {
    const bonus = Math.min(10, 60 / stats.avg_lead_time_minutes);
    score += bonus;
  }

  return Math.max(0, Math.min(100, Math.round(score * 10) / 10));
}
```

### Step 3: Update channel scores from match data

```javascript
async function updateChannelScores() {
  if (Date.now() - credibilityState.lastUpdateAt < CREDIBILITY_UPDATE_INTERVAL_MS) return;
  credibilityState.lastUpdateAt = Date.now();

  const channels = telegramState.channels || [];
  if (!channels.length) return;

  const items = telegramState.items || [];
  for (const channel of channels) {
    const handle = channel.handle;
    const channelItems = items.filter(i => i.channel === handle);
    const confirmed = channelItems.filter(i => i.matchStatus === 'confirmed');
    const unmatched = channelItems.filter(i =>
      i.matchStatus === 'unmatched' &&
      (Date.now() - new Date(i.ts).getTime()) > 24 * 60 * 60 * 1000
    );

    const leadTimes = confirmed
      .map(i => i.leadTimeMinutes)
      .filter(lt => typeof lt === 'number' && lt > 0);

    const stats = {
      total_posts: channelItems.length,
      confirmed_by_news: confirmed.length,
      confirmed_by_sensors: channelItems.filter(i => i.corroboration?.sources?.length > 0).length,
      unconfirmed_after_24h: unmatched.length,
      avg_lead_time_minutes: leadTimes.length ? leadTimes.reduce((a, b) => a + b, 0) / leadTimes.length : null,
      min_lead_time_minutes: leadTimes.length ? Math.min(...leadTimes) : null,
    };

    const reliability = computeReliabilityScore(stats);
    credibilityState.scores[handle] = { ...stats, reliability_score: reliability };

    await upsertChannelScore(handle, channel, stats, reliability);
  }

  console.log(`[Relay] Updated credibility scores for ${channels.length} channels`);
}
```

### Step 4: Upsert to Supabase

```javascript
async function upsertChannelScore(handle, channel, stats, reliability) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) return;

  try {
    await fetch(`${supabaseUrl}/rest/v1/telegram_channel_scores`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Prefer': 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({
        handle,
        label: channel.label || handle,
        topic: channel.topic || 'other',
        region: channel.region || 'global',
        total_posts: stats.total_posts,
        confirmed_by_news: stats.confirmed_by_news,
        confirmed_by_sensors: stats.confirmed_by_sensors,
        unconfirmed_after_24h: stats.unconfirmed_after_24h,
        avg_lead_time_minutes: stats.avg_lead_time_minutes,
        min_lead_time_minutes: stats.min_lead_time_minutes,
        reliability_score: reliability,
        last_scored_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
    });
  } catch (e) {
    console.warn('[Relay] upsertChannelScore error:', e?.message || e);
  }
}
```

### Step 5: Wire into poll cycle

Call `updateChannelScores().catch(...)` after the fusion cycle.

### Step 6: Commit

```bash
git add scripts/ais-relay.cjs
git commit -m "feat: add Telegram channel credibility scoring"
```

---

## Task 6: Frontend — Type Definitions

**Files:**
- Modify: `src/services/telegram-intel.ts`

### Step 1: Add enrichment and corroboration types

Update `src/services/telegram-intel.ts` to add the enriched types:

```typescript
export interface TelegramEnrichment {
  location: string | null;
  lat: number | null;
  lon: number | null;
  entities: string[];
  eventType: string;
  urgency: 'critical' | 'high' | 'medium' | 'low';
  summary: string;
  enrichedAt: string;
}

export interface CorroboratingSource {
  type: 'news' | 'ais' | 'military_flight' | 'gps_interference' | 'internet_outage' | 'protest' | 'satellite_fire' | 'cable_disruption';
  summary: string;
  timestamp: string;
  distance_km?: number;
}

export interface TelegramCorroboration {
  sources: CorroboratingSource[];
  confidence: 'high' | 'medium' | 'low';
  assessmentText: string;
}

export type TelegramMatchStatus = 'exclusive' | 'possibly_related' | 'confirmed' | 'unmatched';
```

### Step 2: Extend TelegramItem with enrichment fields

Add optional enrichment fields to the existing `TelegramItem` interface:

```typescript
export interface TelegramItem {
  id: string;
  source: 'telegram';
  channel: string;
  channelTitle: string;
  url: string;
  ts: string;
  text: string;
  topic: string;
  tags: string[];
  earlySignal: boolean;
  // Enrichment fields (populated by relay)
  enrichment?: TelegramEnrichment;
  matchStatus?: TelegramMatchStatus;
  matchedNewsHeadline?: string;
  matchedAt?: string;
  leadTimeMinutes?: number;
  corroboration?: TelegramCorroboration;
}
```

### Step 3: Add SituationCard type

```typescript
export interface SituationCard {
  id: string;
  telegramItemId: string;
  channelHandle: string;
  confidence: 'high' | 'medium' | 'low';
  threatLevel: 'critical' | 'high' | 'medium' | 'low' | 'info';
  narrativeArc: 'emerging' | 'developing' | 'confirmed' | 'escalating' | 'de-escalating';
  assessmentText: string;
  watchItems: string[];
  locationName: string | null;
  lat: number | null;
  lon: number | null;
  corroboratingSources: CorroboratingSource[];
  leadTimeMinutes: number | null;
  leadTimeStatus: 'exclusive' | 'possibly_related' | 'confirmed';
  newsHeadline: string | null;
  newsMatchedAt: string | null;
  model: string;
  expiresAt: string;
  createdAt: string;
}

export interface SituationCardsResponse {
  cards: SituationCard[];
  count: number;
  updatedAt: string | null;
}
```

### Step 4: Add situation cards fetch function

```typescript
function situationCardsUrl(): string {
  const path = '/api/telegram-situations';
  return isDesktopRuntime() ? proxyUrl(path) : path;
}

let cachedSituations: SituationCardsResponse | null = null;
let cachedSituationsAt = 0;

export async function fetchSituationCards(): Promise<SituationCardsResponse> {
  if (cachedSituations && Date.now() - cachedSituationsAt < CACHE_TTL) return cachedSituations;

  const res = await fetch(situationCardsUrl());
  if (!res.ok) throw new Error(`Situation cards ${res.status}`);

  const json: SituationCardsResponse = await res.json();
  cachedSituations = json;
  cachedSituationsAt = Date.now();
  return json;
}
```

### Step 5: Add the API proxy endpoint

Create `api/telegram-situations.js` (same pattern as `api/telegram-feed.js`):

```typescript
// Proxy to relay /telegram/situations
export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  const relayUrl = process.env.WS_RELAY_URL;
  if (!relayUrl) {
    return new Response(JSON.stringify({ cards: [], count: 0, updatedAt: null }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const target = new URL('/telegram/situations', relayUrl);
    const res = await fetch(target.toString(), {
      headers: { 'User-Agent': 'worldmonitor-api' },
    });
    const body = await res.text();
    return new Response(body, {
      status: res.status,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=30',
      },
    });
  } catch {
    return new Response(JSON.stringify({ cards: [], count: 0, updatedAt: null }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
```

### Step 6: Commit

```bash
git add src/services/telegram-intel.ts api/telegram-situations.js
git commit -m "feat: add enriched Telegram types and situation cards API"
```

---

## Task 7: Frontend — Enhanced TelegramIntelPanel

**Files:**
- Modify: `src/components/TelegramIntelPanel.ts`
- Modify: `src/styles/` (find the Telegram panel CSS file and add badge styles)

### Step 1: Add badge rendering to `buildItem`

Update the `buildItem` method in `TelegramIntelPanel.ts` to show match status badges and urgency indicators:

```typescript
private buildItem(item: TelegramItem): HTMLElement {
  const timeAgo = formatTelegramTime(item.ts);

  const badges: HTMLElement[] = [];

  if (item.matchStatus === 'exclusive') {
    badges.push(h('span', { className: 'telegram-badge telegram-badge-exclusive' }, 'EXCLUSIVE'));
  } else if (item.matchStatus === 'confirmed') {
    badges.push(h('span', { className: 'telegram-badge telegram-badge-confirmed' }, 'CONFIRMED'));
  } else if (item.matchStatus === 'possibly_related') {
    badges.push(h('span', { className: 'telegram-badge telegram-badge-related' }, 'RELATED'));
  }

  if (item.enrichment?.urgency === 'critical') {
    badges.push(h('span', { className: 'telegram-badge telegram-badge-critical' }, 'CRITICAL'));
  } else if (item.enrichment?.urgency === 'high') {
    badges.push(h('span', { className: 'telegram-badge telegram-badge-high' }, 'HIGH'));
  }

  const headerChildren = [
    h('span', { className: 'telegram-intel-channel' }, item.channelTitle || item.channel),
    h('span', { className: 'telegram-intel-topic' }, item.topic),
    ...badges,
    h('span', { className: 'telegram-intel-time' }, timeAgo),
  ];

  const contentChildren = [
    h('div', { className: 'telegram-intel-item-header' }, ...headerChildren),
    h('div', { className: 'telegram-intel-text' },
      item.enrichment?.summary || item.text,
    ),
  ];

  if (item.matchedNewsHeadline) {
    contentChildren.push(
      h('div', { className: 'telegram-intel-match' },
        h('span', { className: 'telegram-match-icon' }, '\u2714'),
        h('span', { className: 'telegram-match-text' },
          `News: ${item.matchedNewsHeadline.slice(0, 80)}${item.matchedNewsHeadline.length > 80 ? '...' : ''}`
        ),
        item.leadTimeMinutes != null
          ? h('span', { className: 'telegram-lead-time' }, `+${item.leadTimeMinutes}m lead`)
          : null,
      ),
    );
  }

  if (item.enrichment?.entities?.length) {
    contentChildren.push(
      h('div', { className: 'telegram-intel-entities' },
        ...item.enrichment.entities.slice(0, 4).map(e =>
          h('span', { className: 'telegram-entity-tag' }, e)
        ),
      ),
    );
  }

  return h('a', {
    href: sanitizeUrl(item.url),
    target: '_blank',
    rel: 'noopener noreferrer',
    className: `telegram-intel-item ${item.enrichment?.urgency === 'critical' ? 'telegram-item-critical' : ''}`,
  }, ...contentChildren.filter(Boolean));
}
```

### Step 2: Add CSS for badges and match indicators

Find the Telegram panel CSS (search for `telegram-intel-item` in CSS files) and add:

```css
.telegram-badge {
  display: inline-block;
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  padding: 1px 5px;
  border-radius: 3px;
  text-transform: uppercase;
  margin-left: 4px;
}
.telegram-badge-exclusive { background: #d4380d; color: #fff; }
.telegram-badge-confirmed { background: #237804; color: #fff; }
.telegram-badge-related { background: #d48806; color: #fff; }
.telegram-badge-critical { background: #a8071a; color: #fff; animation: pulse-badge 1.5s infinite; }
.telegram-badge-high { background: #cf1322; color: #fff; }

@keyframes pulse-badge {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}

.telegram-intel-match {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 0.75rem;
  color: var(--text-secondary, #8c8c8c);
  margin-top: 4px;
  padding: 2px 0;
}
.telegram-match-icon { color: #52c41a; }
.telegram-lead-time {
  color: #1890ff;
  font-weight: 600;
  margin-left: auto;
}

.telegram-intel-entities {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
  margin-top: 4px;
}
.telegram-entity-tag {
  font-size: 0.65rem;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 3px;
  padding: 0 4px;
  color: var(--text-secondary, #8c8c8c);
}

.telegram-item-critical {
  border-left: 3px solid #a8071a;
}
```

### Step 3: Verify badges render

Run the dev server, open the Telegram panel, verify items show badges.
Expected: Items with enrichment show urgency badges; confirmed items show green checkmark with news headline.

### Step 4: Commit

```bash
git add src/components/TelegramIntelPanel.ts src/styles/
git commit -m "feat: add match status badges and enrichment display to Telegram panel"
```

---

## Task 8: Frontend — OSINT Map Layer

**Files:**
- Modify: `src/types/index.ts` (add `osint` to `MapLayers`)
- Modify: `src/config/panels.ts` (add `osint` to layer configs)
- Modify: `src/components/DeckGLMap.ts` (add OSINT layer rendering)
- Modify: `src/app/data-loader.ts` (add OSINT data loading)

### Step 1: Add `osint` to MapLayers interface

In `src/types/index.ts`, add to the `MapLayers` interface:

```typescript
// After: gulfInvestments: boolean;
osint: boolean;
```

### Step 2: Add to layer configs in panels.ts

In `src/config/panels.ts`, add `osint: false` to `FULL_MAP_LAYERS`, `TECH_MAP_LAYERS`, `FINANCE_MAP_LAYERS`, and all other `*_MAP_LAYERS` objects. Set it to `false` by default (user opt-in).

### Step 3: Create OSINT layer in DeckGLMap

In `src/components/DeckGLMap.ts`, add a method to create the OSINT layer. Use `ScatterplotLayer` or `IconLayer` from deck.gl:

```typescript
private osintItems: TelegramItem[] = [];

public setOsintItems(items: TelegramItem[]): void {
  this.osintItems = items.filter(
    i => i.enrichment?.lat != null && i.enrichment?.lon != null
  );
  this.updateLayers();
}

// In buildLayers(), add:
if (this.mapLayers.osint && this.osintItems.length) {
  layers.push(
    new ScatterplotLayer({
      id: 'osint-layer',
      data: this.osintItems,
      getPosition: (d: TelegramItem) => [d.enrichment!.lon!, d.enrichment!.lat!],
      getRadius: (d: TelegramItem) =>
        d.enrichment?.urgency === 'critical' ? 12000 :
        d.enrichment?.urgency === 'high' ? 8000 : 5000,
      getFillColor: (d: TelegramItem) => {
        switch (d.enrichment?.urgency) {
          case 'critical': return [168, 7, 26, 200];
          case 'high': return [207, 19, 34, 180];
          case 'medium': return [212, 136, 6, 160];
          default: return [24, 144, 255, 140];
        }
      },
      radiusMinPixels: 4,
      radiusMaxPixels: 20,
      pickable: true,
      autoHighlight: true,
    })
  );
}
```

### Step 4: Wire data loading

In `src/app/data-loader.ts`, add OSINT loading when the layer is toggled on:

```typescript
// In loadDataForLayer:
case 'osint': {
  const { fetchTelegramFeed } = await import('@/services/telegram-intel');
  const feed = await fetchTelegramFeed(100);
  const geoItems = feed.items.filter(
    i => i.enrichment?.lat != null && i.enrichment?.lon != null
  );
  ctx.map?.setOsintItems(geoItems);
  break;
}
```

### Step 5: Add layer toggle in event handlers

In `src/app/event-handlers.ts`, ensure the layer toggle handler covers `osint` (it should work via the generic `mapLayers[layer]` toggle already).

### Step 6: Verify map layer

Toggle the OSINT layer, verify pins appear at extracted coordinates.
Expected: Colored dots on the map at locations mentioned in Telegram posts.

### Step 7: Commit

```bash
git add src/types/index.ts src/config/panels.ts src/components/DeckGLMap.ts src/app/data-loader.ts
git commit -m "feat: add OSINT map layer for geo-tagged Telegram items"
```

---

## Task 9: Signal Pipeline Integration

**Files:**
- Modify: `scripts/ais-relay.cjs` (promote high-confidence items)
- Modify: `src/services/telegram-intel.ts` (export helper for signal integration)

### Step 1: Promote exclusive/high-urgency items to the headline ingest pipeline

In the relay, after enrichment and news matching, promote items with specific criteria to the broader headline pipeline with a special scope:

```javascript
async function promoteToSignalPipeline(items) {
  const promotable = items.filter(item =>
    item.enrichment &&
    item.earlySignal &&
    (item.enrichment.urgency === 'critical' || item.enrichment.urgency === 'high') &&
    (item.matchStatus === 'exclusive' || item.matchStatus === 'unmatched')
  );

  if (!promotable.length) return;

  const headlines = promotable.map(item => ({
    title: `[OSINT] ${item.enrichment.summary || item.text.slice(0, 200)}`,
    pubDate: Math.floor(new Date(item.ts).getTime() / 1000),
    scopes: ['global', 'telegram', item.topic].filter(Boolean),
  }));

  ingestTelegramHeadlines({ length: headlines.length, map: () => headlines });
}
```

Call this at the end of the enrichment cycle.

### Step 2: Commit

```bash
git add scripts/ais-relay.cjs
git commit -m "feat: promote high-urgency Telegram items to signal pipeline"
```

---

## Post-Implementation Checklist

After all tasks are complete:

1. **Env vars on relay server:** Ensure these are set:
   - `OLLAMA_API_URL=https://ollama.5ls.us`
   - `OLLAMA_MODEL=qwen3-wm`
   - `OLLAMA_CF_ACCESS_CLIENT_ID` (if behind Cloudflare Access)
   - `OLLAMA_CF_ACCESS_CLIENT_SECRET` (if behind Cloudflare Access)
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`

2. **Deploy relay:** Run `bash scripts/update-relay.sh` to push the updated relay.

3. **Run migrations:** Apply the 3 new Supabase migrations.

4. **Monitor:** Watch relay logs for:
   - `[Relay] Enriched X/Y telegram items`
   - `[Relay] News matching: X matches found`
   - `[Relay] Fusion: X assessments generated`
   - `[Relay] Updated credibility scores for X channels`

5. **Frontend verification:**
   - Telegram panel shows badges (EXCLUSIVE, CONFIRMED, CRITICAL)
   - Items with news matches show the matched headline + lead time
   - OSINT map layer toggle shows geo pins
   - Entity tags display below enriched items
