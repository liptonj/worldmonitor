# Service & Source Scheduling + Cache Viewer — Admin Panel

**Date**: 2026-03-09
**Status**: Approved

## Problem

The admin panel has no UI for managing service schedules (`wm_admin.service_config` — 50 services), no per-source polling frequency on `news_sources` (405 sources), and no way to inspect Redis cache contents to validate data flow.

## Architecture

Single new admin page with three tabs:

```
Tab 1: Service Config  →  Supabase (service_config table, existing RLS)
Tab 2: Source Scheduling →  Supabase (news_sources table, existing RLS)
Tab 3: Cache Viewer     →  Gateway /admin/cache/* → Redis
```

Service Config and Source Scheduling talk directly to Supabase via existing RLS policies (admins already have ALL access). Cache Viewer requires new authenticated gateway endpoints since Redis is server-side only.

## Tab 1: Service Config

Table view of all `wm_admin.service_config` rows with inline editing.

### Columns

| Column | Editable | Notes |
|--------|----------|-------|
| Service Key | no | Primary identifier |
| Description | yes | Human-readable name |
| Enabled | toggle | Enable/disable cron |
| Cron Schedule | text input | With human-readable preview |
| TTL (seconds) | number | Redis cache TTL |
| Timeout (ms) | number | Per-run timeout |
| Fetch Type | dropdown | `custom`, `simple_http`, `simple_rss` |
| Status | badge | green=ok, red=error, gray=never run |
| Last Run | timestamp | Relative time |
| Duration | number | Last run duration in ms |
| Failures | number | Consecutive failure count |
| Actions | buttons | "Trigger Now" + "View Cache" |

### Features

- Auto-group by prefix (`ai:*`, `news:*`, `config:*`, ungrouped)
- Bulk enable/disable
- Inline save with confirmation toast
- Poll `get_relay_service_statuses` every 30s for live status
- "Trigger Now" uses existing `trigger_relay_service` RPC
- "View Cache" opens Cache Viewer filtered to the service's `redis_key`

### Backend

Direct Supabase table access via existing RLS. No new RPCs needed for CRUD.

## Tab 2: Source Scheduling

### Schema Change

Add two nullable columns to `wm_admin.news_sources`:

```sql
ALTER TABLE wm_admin.news_sources
  ADD COLUMN poll_interval_minutes INTEGER,
  ADD COLUMN custom_cron TEXT;
```

### Tier Defaults

When both fields are NULL, the source inherits from its tier:

| Tier | Default Interval | Rationale |
|------|-----------------|-----------|
| 1 | 5 min | Wire/critical — breaking news |
| 2 | 15 min | Major outlets, think tanks |
| 3 | 30 min | Standard sources |
| 4 | 60 min | Blogs, niche |

Precedence: `custom_cron` > `poll_interval_minutes` > tier default.

### Columns

| Column | Editable | Notes |
|--------|----------|-------|
| Name | no | Source name |
| Category | no | For filtering/grouping |
| Tier | no | Badge + default interval |
| Effective Interval | no | Computed from precedence chain |
| Poll Interval (min) | yes | Number input, placeholder = tier default |
| Custom Cron | yes | Text input for advanced overrides |
| Enabled | toggle | yes |

### Features

- Filter by category, tier, language, enabled
- Bulk tier-default override for selected sources
- "Reset to tier default" per row
- Visual badge on sources with custom overrides

## Tab 3: Cache Viewer

### Gateway Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `GET /admin/cache/keys` | GET | List keys with TTL, type, size |
| `GET /admin/cache/key/:key` | GET | Full value for a key |
| `DELETE /admin/cache/key/:key` | DELETE | Invalidate a cache entry |

### Authentication

All `/admin/*` routes require `Authorization: Bearer <ADMIN_API_KEY>`. The key is stored as a Supabase vault secret and loaded by the admin panel via `get_vault_secret` RPC.

### UI — Left Panel (Key Browser)

- Searchable list of all Redis keys
- Per key: name, TTL remaining (progress bar), size in KB
- Color-coded by prefix (`relay:*` blue, `news:*` green, `ai:*` purple, `market:*` orange)
- Sort by name, TTL, size
- Filter by prefix or substring

### UI — Right Panel (Value Inspector)

- Syntax-highlighted JSON viewer with collapsible nodes
- Copy-to-clipboard
- "Invalidate" with confirmation dialog
- Metadata bar: key name, type, TTL, size

### Features

- Auto-refresh toggle (30s interval)
- Bulk invalidate with confirmation
- Link from Service Config "View Cache" button
- Stale detection: TTL < 10% = warning badge; missing keys for enabled services = red flag

### Security

- Gateway adds DELETE support only for `/admin/cache/*` routes
- `ADMIN_API_KEY` env var separate from `RELAY_SHARED_SECRET`
- Key stored in Supabase vault, loaded at runtime

## Changes Summary

| Layer | Change |
|-------|--------|
| Database | Migration: add `poll_interval_minutes`, `custom_cron` to `news_sources` |
| Gateway | Add `/admin/*` routes with auth, cache key listing/get/delete |
| Admin UI | New page: `src/admin/pages/service-scheduling.ts` with 3 tabs |
| Docker | Add `ADMIN_API_KEY` env var to gateway service |
| Orchestrator | Wire `news_sources` scheduling fields into fetch pipeline |
