# Service Scheduling Page — Verification Summary

**Date:** 2026-03-09  
**Task:** Final verification and cleanup (Task 9)

## Features Implemented

### Service Config Tab
- Table shows all services grouped by prefix (ai:, news:, config:, other)
- Columns: key, description, enabled, cron, TTL, timeout, fetch_type, status, last_run, duration, failures, actions
- Cron schedules show human-readable preview (e.g. "every 5 min", "every hour")
- Status badges: green=ok, red=error, gray=never run
- Inline editing: cron, TTL, timeout, fetch_type dropdown, enabled checkbox
- Save button updates database via Supabase REST
- Trigger Now button calls `trigger_relay_service` RPC
- View Cache button switches to Cache Viewer with pre-filled search
- Bulk enable/disable with checkboxes
- Status polling every 30s; stops when switching tabs

### Source Scheduling Tab
- Table shows all news sources (405)
- Filters: category, tier, language, enabled, text search
- Effective interval: custom_cron > poll_interval > tier default
- Custom badge on rows with overrides
- Tier badges color-coded (1=green, 2=blue, 3=amber, 4=red)
- Editable: poll_interval_minutes, custom_cron, enabled
- Save updates database; table refreshes after save
- Reset button with confirmation; sets both fields to null

### Cache Viewer Tab
- Loads ADMIN_API_KEY from vault via `/api/admin/admin-api-key`
- Fetches keys from gateway `GET /admin/cache/keys`
- Key list with metadata (TTL, size, type)
- TTL progress bars (100% for -1/no expiry)
- Prefix color-coding: ai: purple, news: blue, config: green, market: amber
- Search filters keys by substring
- Sort dropdown: name, TTL, size
- Auto-refresh toggle (30s); Refresh Now button
- Value inspector: JSON syntax highlighting, Copy, Invalidate with confirmation
- View Cache from Service Config pre-fills search
- Auto-refresh stops when switching tabs

### Existing Admin Pages (No Regressions)
- Secrets, Feature Flags, News Sources, LLM Config, App Keys, Display Settings, Market Symbols
- All wired in `src/admin/dashboard.ts`; Service Scheduling added as 8th nav item

## Known Limitations

1. **Cache Viewer requires gateway + Redis**  
   Gateway must be running with `ADMIN_API_KEY` set. Cache Viewer will show an error if the gateway is unreachable or key is missing.

2. **Service Config / Source Scheduling require Supabase**  
   Admin must be logged in with `wm_admin` profile. Tables `service_config` and `news_sources` must exist with RLS granting admin access.

3. **No `npm run lint` script**  
   Project uses `npm run typecheck` for type checking. No ESLint/Biome lint script is configured.

## Setup Instructions

### Environment Variables
- `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` — Admin portal Supabase client
- `VITE_GATEWAY_URL` — Gateway base URL (default: `http://localhost:3004`)

### Vault / Gateway
- **ADMIN_API_KEY** must be set in:
  1. Supabase vault (for `/api/admin/admin-api-key` → Cache Viewer)
  2. Gateway env (`services/.env.production` or `ADMIN_API_KEY` env var)
- Values must match. Generate with: `openssl rand -hex 32`

### Running Locally
```bash
# Terminal 1: Vite dev server
npm run dev

# Terminal 2: Gateway (from services/)
cd services && docker compose up gateway
# Or: node gateway/index.cjs (with Redis + ADMIN_API_KEY)
```

### Gateway Health Check
```bash
curl http://localhost:3004/health
# Expected: {"status":"ok","uptime":...}
```

## Testing Checklist

### Automated (Verified)
- [x] `npm run typecheck` — passes
- [x] `npm run build` — passes
- [x] Gateway unit tests (`node --test test/gateway.test.cjs`) — 18/18 pass

### Manual Smoke Test (Requires Running Stack)
1. **Service Config:** Load page → verify 50 services grouped → edit cron → Save → reload → verify persist → Trigger Now → View Cache
2. **Source Scheduling:** Load → verify 405 sources → set poll_interval → Save → Reset → verify effective interval
3. **Cache Viewer:** Load → verify keys list → click key → Copy → Invalidate (non-critical key)
4. **Regression:** Open each existing admin page (Secrets, Feature Flags, etc.) → verify loads

### E2E
- `e2e/admin-portal.spec.ts` — login form, invalid credentials, API 401 without token
- Admin API routes require Vercel dev or deployed environment; Vite dev server does not serve `/api/admin/*`
- **Note:** E2E tests require `npx playwright install` for browser binaries. Failures due to missing Playwright browsers are environment setup, not code regressions.

## Code Quality

| Check        | Command                    | Status  |
|-------------|----------------------------|---------|
| Type check  | `npm run typecheck`        | Pass    |
| Build       | `npm run build`            | Pass    |
| Gateway tests | `node --test test/gateway.test.cjs` | 18 pass |

## Final Commit

If making final cleanup changes:

```bash
git add -A
git commit -m "feat(admin): service scheduling page with config, source scheduling, and cache viewer"
```

Most implementation should already be committed from previous tasks (Tasks 1–8).
