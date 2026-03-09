# Orchestrator Scheduling Audit (Task 8)

> **Date:** 2026-03-09  
> **Source:** docs/plans/2026-03-09-fix-all-panel-data-flows.md, Task 8

## Summary

The orchestrator loads schedules from `wm_admin.service_config` (seeded by `supabase/migrations/20260307000003_seed_service_config.sql`). It schedules cron jobs for each enabled row and triggers either the **worker** (custom/simple_http/simple_rss) or **ai-engine** (ai:* services) via gRPC.

## Scheduled Workers (from migration seed)

| service_key | cron_schedule | redis_key | ttl_seconds | fetch_type |
|-------------|---------------|-----------|-------------|------------|
| markets | */5 * * * * | market:dashboard:v1 | 300 | custom |
| stablecoins | */5 * * * * | relay:stablecoins:v1 | 300 | custom |
| etf-flows | */5 * * * * | relay:etf-flows:v1 | 300 | custom |
| macro-signals | 3-59/5 * * * * | economic:macro-signals:v1 | 300 | custom |
| strategic-risk | */5 * * * * | risk:scores:sebuf:v1 | 300 | custom |
| predictions | 1-59/5 * * * * | relay:predictions:v1 | 300 | custom |
| news:full | */5 * * * * | news:digest:v1:full:en | 300 | custom |
| news:tech | 1-59/5 * * * * | news:digest:v1:tech:en | 300 | custom |
| news:finance | 2-59/5 * * * * | news:digest:v1:finance:en | 300 | custom |
| news:happy | 3-59/5 * * * * | news:digest:v1:happy:en | 300 | custom |
| supply-chain | 2-59/10 * * * * | supply_chain:chokepoints:v1 | 600 | custom |
| strategic-posture | 3-59/10 * * * * | theater-posture:sebuf:v1 | 600 | custom |
| pizzint | 4-59/10 * * * * | intel:pizzint:v1 | 600 | custom |
| iran-events | */10 * * * * | conflict:iran-events:v1 | 600 | custom |
| weather | */10 * * * * | relay:weather:v1 | 600 | custom |
| gps-interference | */5 * * * * | relay:gps-interference:v1 | 300 | custom |
| cables | */15 * * * * | relay:cables:v1 | 900 | custom |
| cyber | 5-59/10 * * * * | relay:cyber:v1 | 600 | custom |
| service-status | */5 * * * * | relay:service-status:v1 | 300 | custom |
| trade | */15 * * * * | relay:trade:v1 | 900 | custom |
| fred | */30 * * * * | relay:fred:v1 | 1800 | custom |
| oil | 1-59/30 * * * * | relay:oil:v1 | 1800 | custom |
| conflict | */30 * * * * | relay:conflict:v1 | 1800 | custom |
| natural | 2-59/30 * * * * | relay:natural:v1 | 1800 | custom |
| eonet | */30 * * * * | relay:eonet:v1 | 1800 | custom |
| gdacs | */30 * * * * | relay:gdacs:v1 | 1800 | custom |
| oref | */5 * * * * | relay:oref:v1 | 300 | custom |
| opensky | */1 * * * * | relay:opensky:v1 | 60 | custom |
| gdelt | */15 * * * * | relay:gdelt:v1 | 900 | custom |
| youtube-live | */5 * * * * | relay:youtube-live:v1 | 300 | custom |
| bis | 0 * * * * | relay:bis:v1 | 3600 | custom |
| flights | 5 * * * * | relay:flights:v1 | 3600 | custom |
| aviation-precache | 0 0 * * * | (empty) | 86400 | custom |
| giving | 0 0 * * * | giving:summary:v1 | 86400 | custom |
| climate | 0 */6 * * * | relay:climate:v1 | 21600 | custom |
| ucdp-events | 0 */6 * * * | conflict:ucdp-events:v1 | 21600 | custom |
| worldbank | 0 */6 * * * | relay:worldbank:v1 | 21600 | simple_http |
| security-advisories | */30 * * * * | relay:security-advisories:v1 | 1800 | simple_rss |
| gulf-quotes | */10 * * * * | relay:gulf-quotes:v1 | 600 | custom |
| tech-events | */10 * * * * | relay:tech-events:v1 | 600 | custom |
| spending | */10 * * * * | relay:spending:v1 | 600 | custom |
| config:news-sources | */5 * * * * | relay:config:news-sources | 300 | custom |
| config:feature-flags | */5 * * * * | relay:config:feature-flags | 300 | custom |
| ai:intel-digest | */10 * * * * | ai:digest:global:v1 | 600 | custom |
| ai:panel-summary | */15 * * * * | ai:panel-summary:v1 | 900 | custom |
| ai:article-summaries | 2-59/5 * * * * | ai:article-summaries:v1 | 300 | custom |
| ai:classifications | */15 * * * * | ai:classifications:v1 | 900 | custom |
| ai:country-briefs | */30 * * * * | ai:country-briefs:v1 | 1800 | custom |
| ai:posture-analysis | 3-59/15 * * * * | ai:posture-analysis:v1 | 900 | custom |
| ai:instability-analysis | 5-59/30 * * * * | ai:instability-analysis:v1 | 1800 | custom |
| ai:risk-overview | 4-59/15 * * * * | ai:risk-overview:v1 | 900 | custom |

## Critical Channels Verification (Task 8 requirements)

| Channel | Redis Key | Scheduled | Notes |
|---------|-----------|-----------|-------|
| gdelt | relay:gdelt:v1 | ✅ Yes | */15 * * * * |
| strategic-risk | risk:scores:sebuf:v1 | ✅ Yes | */5 * * * * |
| strategic-posture | theater-posture:sebuf:v1 | ✅ Yes | 3-59/10 * * * * |
| ai:panel-summary | ai:panel-summary:v1 | ✅ Yes | */15 * * * * |
| intelligence / ai:intel-digest | ai:digest:global:v1 | ✅ Yes | ai:intel-digest, */10 * * * * |
| news:full | news:digest:v1:full:en | ✅ Yes | */5 * * * * |
| news:tech | news:digest:v1:tech:en | ✅ Yes | 1-59/5 * * * * |
| news:finance | news:digest:v1:finance:en | ✅ Yes | 2-59/5 * * * * |
| news:happy | news:digest:v1:happy:en | ✅ Yes | 3-59/5 * * * * |

## Pizzint Subscription Channel

**pizzint** is scheduled in the migration:
- service_key: `pizzint`
- redis_key: `intel:pizzint:v1`
- cron: `4-59/10 * * * *` (every 10 min, offset 4)
- Worker: `services/shared/channels/pizzint.cjs` exists and is registered in the worker's channel index

The pizzint channel feeds the Intel panel (PizzINT indicator). It does **need** a worker and is correctly scheduled.

## Channels NOT Orchestrator-Scheduled (by design)

These channels are populated by **separate long-running services**, not by the orchestrator:

| Channel | Redis Key | Service | Notes |
|---------|-----------|---------|-------|
| telegram | relay:telegram:v1 | ingest-telegram | Long-running MTProto client; writes to Redis on poll |
| ais | relay:ais-snapshot:v1 | ais-processor | Long-running AIS data processor |

Do **not** add these to service_config — they are not cron-triggered.

## Missing Workers (before this audit)

| service_key | redis_key | Status |
|-------------|-----------|--------|
| ai:classifications | ai:classifications:v1 | **Added** — AI engine has generator, channel-registry references it |

## Migration Changes Made

1. **Added** `ai:classifications` to the seed migration:
   - service_key: `ai:classifications`
   - cron_schedule: `*/15 * * * *`
   - redis_key: `ai:classifications:v1`
   - ttl_seconds: 900
   - fetch_type: custom
   - description: AI event classifications

No other changes were required. All critical channels from the plan were already present in the migration.
