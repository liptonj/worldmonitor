# Admin Portal — Brainstorm Review & Addendum Design

> Companion to `2026-03-03-admin-portal.md`. This document captures gaps identified during the brainstorm review and the approved design for addressing them.

## Context

The original plan (Tasks 1–22) builds the admin CRUD layer: Supabase schema, Vault RPCs, admin API routes, and the admin portal UI. However, it does not wire the main application to read from Supabase at runtime. It also has security, operational, and UX gaps.

## Design Principles (agreed with user)

1. **No hardcoded fallbacks.** The database is the single source of truth. If Supabase is down and Redis cache is empty, features degrade gracefully (disabled/empty). No fallback to TypeScript config files.
2. **Resolution order:** Redis cache → Supabase query → feature unavailable.
3. **All security gaps addressed:** CORS origin allowlist, rate limiting, audit logging, input validation (Zod), token refresh, populated `updated_by`/`created_by`.
4. **Full UX consistency:** External CSS, i18n, theme integration matching the settings page.
5. **Prompt versioning** with history table and revert capability.
6. **Config export/backup** via admin portal download.
7. **Vercel rewrite** from `/admin` to `/admin.html`.

## Gap Categories

### A. Runtime Consumers

The plan creates database tables and admin CRUD but the app never reads from them:

- **Feature flags:** `src/config/ml-config.ts` exports static `ML_FEATURE_FLAGS` and `ML_THRESHOLDS`. Used by `ml.worker.ts`, `ml-worker.ts`, `ml-capabilities.ts`, `clustering.ts`. No public API, no client-side fetch.
- **News sources (server):** `server/worldmonitor/news/v1/_feeds.ts` exports `VARIANT_FEEDS` and `INTEL_SOURCES` as `Record<string, Record<string, ServerFeed[]>>`. Used by `list-feed-digest.ts`. The plan only knows about `src/config/feeds.ts`.
- **News sources (client):** `src/config/feeds.ts` exports feed lists plus `SOURCE_TIERS`, `SOURCE_TYPES`, `SOURCE_PROPAGANDA_RISK`, `SOURCE_REGION_MAP`, `DEFAULT_ENABLED_SOURCES`, `ALERT_KEYWORDS`, and utility functions (`getSourceTier`, `getSourceType`, `getSourcePropagandaRisk`, `computeDefaultDisabledSources`, etc.). Used by 8+ components. Migration requires new table columns and a client-side feed service.

### B. Security

- CORS uses `*` instead of origin allowlist from `api/_cors.js`
- No rate limiting (existing API uses `api/_rate-limit.js` at 600 req/60s)
- No audit logging despite `updated_by`/`created_by` columns
- No input validation (no Zod, minimal type checks)
- Token refresh not wired — stale `accessToken` after ~1 hour
- `updated_by`/`created_by` never populated in CRUD handlers

### C. Operational

- No `/admin` → `/admin.html` rewrite
- No prompt versioning / history
- No config export / backup

### D. UX

- Admin uses inline styles; settings page uses external CSS
- No i18n (settings uses `t()` from `@/services/i18n`)
- No theme (settings calls `applyStoredTheme()`)

## Schema Additions

### New columns on `wm_admin.news_sources`

| Column | Type | Purpose |
|---|---|---|
| `propaganda_risk` | `TEXT DEFAULT 'low' CHECK (IN ('low','medium','high'))` | Source propaganda risk level |
| `state_affiliated` | `TEXT` | Country name if state-affiliated media |
| `propaganda_note` | `TEXT` | Context note (e.g. "Official CCP news agency") |
| `default_enabled` | `BOOLEAN DEFAULT true` | Whether source is enabled by default for users |

### New table: `wm_admin.audit_log`

Immutable append-only log of admin actions.

| Column | Type |
|---|---|
| `id` | `UUID PK` |
| `actor_id` | `UUID NOT NULL REFERENCES auth.users(id)` |
| `action` | `TEXT NOT NULL` — `'create'`, `'update'`, `'delete'` |
| `resource` | `TEXT NOT NULL` — `'secret'`, `'feature_flag'`, `'news_source'`, etc. |
| `resource_id` | `TEXT` — UUID or name |
| `details` | `JSONB` — old/new values (secrets redacted) |
| `created_at` | `TIMESTAMPTZ DEFAULT now()` |

### New table: `wm_admin.llm_prompt_history`

Mirrors `llm_prompts` columns + `changed_at`, `changed_by`. Populated by a BEFORE UPDATE trigger on `llm_prompts`.

### Additional feature flag seeds

- `site.alertKeywords` — JSONB array (replaces `ALERT_KEYWORDS`)
- `site.alertExclusions` — JSONB array (replaces `ALERT_EXCLUSIONS`)
- `site.sourceRegionMap` — JSONB object (replaces `SOURCE_REGION_MAP`)
- `site.defaultEnabledSources` — JSONB object (replaces `DEFAULT_ENABLED_SOURCES`)
- `site.defaultEnabledIntel` — JSONB array (replaces `DEFAULT_ENABLED_INTEL`)

## New Tasks Summary

| Task | Title | Dependencies |
|---|---|---|
| 23 | Install Zod | After Task 2 |
| 24 | Create `server/_shared/news-sources.ts` helper | After Task 8 |
| 25 | Create public config API endpoints | After Task 10 |
| 26 | Migrate `list-feed-digest.ts` to dynamic news sources | After Task 24 |
| 27 | Create `src/services/feature-flag-client.ts` | After Task 25 |
| 28 | Migrate ML consumers to dynamic feature flags | After Task 27 |
| 29 | Create `src/services/feed-client.ts` and migrate client code | After Task 25 |
| 30 | Add prompt versioning UI to LLM Config page | After Task 17 |
| 31 | Add config export endpoint and admin UI button | After Task 10 |
| 32 | Create `src/styles/admin.css` | Before Task 13 |
| 33 | Add i18n keys for admin portal | Before Task 13 |
| 34 | Archive old static config files | After Tasks 26, 28, 29 |
| 35 | Final integration test | Last |

## Modified Existing Tasks

- **Task 2:** Also install `zod`
- **Task 4:** Add `audit_log`, `llm_prompt_history` tables; add columns to `news_sources`; add feature flag seeds; add prompt history trigger
- **Task 10:** Rewrite `_auth.ts` with CORS (origin allowlist), rate limiting, audit helper. All CRUD routes use Zod validation, set `updated_by`/`created_by`, call audit log.
- **Task 13:** Use external CSS, call `initI18n()` + `applyStoredTheme()`
- **Task 14–18:** Use `t()` for all strings
- **Task 19:** Seed from both `src/config/feeds.ts` AND `_feeds.ts`; include propaganda risk and default_enabled metadata
- **Task 20:** Add Vercel rewrite `/admin` → `/admin.html`
