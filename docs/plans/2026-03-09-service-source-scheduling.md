# Service & Source Scheduling + Cache Viewer — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an admin page with three tabs: Service Config (view/edit cron schedules for 50 relay services), Source Scheduling (per-source poll intervals for 405 news sources), and Cache Viewer (full Redis cache inspector with JSON viewer and invalidation).

**Architecture:** Admin UI is a vanilla TypeScript SPA at `src/admin/`. Pages render to `#admin-content` via `renderXxxPage(container, accessToken)`. Data flows via Supabase RPC or direct table access (RLS already grants admin ALL on `service_config`, `trigger_requests`, `news_sources`). Cache viewing requires new authenticated gateway endpoints that proxy Redis reads/deletes. The gateway (`services/gateway/index.cjs`) is a raw Node.js HTTP server (no framework).

**Tech Stack:** TypeScript (admin SPA), Node.js/ioredis (gateway), PostgreSQL/Supabase (data), Redis (cache)

---

## Task 1: Database Migration — Add scheduling columns to news_sources

**Files:**
- Create: `supabase/migrations/2026030900001_add_source_scheduling.sql`

**Step 1: Write the migration**

```sql
-- Add per-source scheduling overrides to news_sources
ALTER TABLE wm_admin.news_sources
  ADD COLUMN IF NOT EXISTS poll_interval_minutes INTEGER,
  ADD COLUMN IF NOT EXISTS custom_cron TEXT;

COMMENT ON COLUMN wm_admin.news_sources.poll_interval_minutes
  IS 'Per-source poll interval override in minutes. NULL = inherit from tier default (T1=5, T2=15, T3=30, T4=60).';
COMMENT ON COLUMN wm_admin.news_sources.custom_cron
  IS 'Per-source cron expression override. Takes precedence over poll_interval_minutes if set.';
```

**Step 2: Apply the migration**

Run: `npx supabase db push` or apply via the Supabase MCP `apply_migration` tool.
Expected: Migration applies successfully, two new nullable columns on `news_sources`.

**Step 3: Verify**

Run SQL: `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'wm_admin' AND table_name = 'news_sources' AND column_name IN ('poll_interval_minutes', 'custom_cron');`
Expected: Both columns present, nullable, correct types.

**Step 4: Commit**

```bash
git add supabase/migrations/2026030900001_add_source_scheduling.sql
git commit -m "feat(db): add poll_interval_minutes and custom_cron to news_sources"
```

---

## Task 2: Gateway — Add admin cache endpoints with auth

**Files:**
- Modify: `services/gateway/index.cjs`
- Modify: `services/shared/redis.cjs` (add `keys`, `ttl`, `del`, `strlen` exports)
- Modify: `services/docker-compose.yml` (add `ADMIN_API_KEY` env var)
- Modify: `services/.env.example` and `services/.env.production` (add `ADMIN_API_KEY`)

**Step 1: Add Redis helper functions to shared/redis.cjs**

Open `services/shared/redis.cjs`. After the existing `setex` function (line ~43), add these functions before `module.exports`:

```javascript
async function keys(pattern) {
  const client = getClient();
  return client.keys(pattern);
}

async function ttl(key) {
  const client = getClient();
  return client.ttl(key);
}

async function del(key) {
  const client = getClient();
  return client.del(key);
}

async function strlen(key) {
  const client = getClient();
  return client.strlen(key);
}

async function type(key) {
  const client = getClient();
  return client.type(key);
}
```

Update `module.exports` to: `{ get, setex, getClient, keys, ttl, del, strlen, type }`.

**Step 2: Add admin auth and cache routes to gateway**

Open `services/gateway/index.cjs`.

At the top, after the existing imports (line ~9), add:

```javascript
const { keys: redisKeys, ttl: redisTtl, del: redisDel, strlen: redisStrlen, type: redisType } = require('@worldmonitor/shared/redis.cjs');
```

In the `main()` function, inside the `http.createServer` callback (around line 298), the current code rejects non-GET methods at line 312:

```javascript
if (req.method !== 'GET') {
  res.writeHead(405, ...);
  ...
}
```

Replace that block with logic that allows DELETE for admin routes:

```javascript
if (req.method !== 'GET' && req.method !== 'DELETE') {
  res.writeHead(405, { [CORS_HEADER]: CORS_VALUE, 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Method not allowed' }));
  return;
}
```

Also update the OPTIONS handler (around line 305) to include DELETE:

```javascript
'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
```

Then, BEFORE the GDELT handler (line ~318), add the admin route block:

```javascript
// --- Admin cache routes (auth required) ---
if (pathname.startsWith('/admin/')) {
  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) {
    res.writeHead(503, { [CORS_HEADER]: CORS_VALUE, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Admin API not configured' }));
    return;
  }
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token || token !== adminKey) {
    res.writeHead(401, { [CORS_HEADER]: CORS_VALUE, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }
  const jsonH = { [CORS_HEADER]: CORS_VALUE, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

  try {
    // GET /admin/cache/keys — list all keys with metadata
    if (pathname === '/admin/cache/keys' && req.method === 'GET') {
      const allKeys = await redisKeys('*');
      const entries = await Promise.all(
        allKeys.map(async (k) => {
          const [t, sz, tp] = await Promise.all([redisTtl(k), redisStrlen(k), redisType(k)]);
          return { key: k, ttl: t, size: sz, type: tp };
        })
      );
      entries.sort((a, b) => a.key.localeCompare(b.key));
      res.writeHead(200, jsonH);
      res.end(JSON.stringify({ keys: entries }));
      return;
    }

    // GET /admin/cache/key/:key — get full value
    const getMatch = pathname.match(/^\/admin\/cache\/key\/(.+)$/);
    if (getMatch && req.method === 'GET') {
      const key = decodeURIComponent(getMatch[1]);
      const client = require('@worldmonitor/shared/redis.cjs').getClient();
      const raw = await client.get(key);
      if (raw === null) {
        res.writeHead(404, jsonH);
        res.end(JSON.stringify({ error: 'Key not found' }));
        return;
      }
      let value;
      try { value = JSON.parse(raw); } catch { value = raw; }
      const t = await redisTtl(key);
      res.writeHead(200, jsonH);
      res.end(JSON.stringify({ key, ttl: t, value }));
      return;
    }

    // DELETE /admin/cache/key/:key — invalidate
    const delMatch = pathname.match(/^\/admin\/cache\/key\/(.+)$/);
    if (delMatch && req.method === 'DELETE') {
      const key = decodeURIComponent(delMatch[1]);
      const deleted = await redisDel(key);
      res.writeHead(200, jsonH);
      res.end(JSON.stringify({ deleted: deleted > 0, key }));
      return;
    }

    res.writeHead(404, jsonH);
    res.end(JSON.stringify({ error: 'Admin route not found' }));
    return;
  } catch (err) {
    log.error('Admin route error', { pathname, error: err.message });
    res.writeHead(500, jsonH);
    res.end(JSON.stringify({ error: 'Internal server error' }));
    return;
  }
}
```

**Step 3: Add ADMIN_API_KEY to docker-compose and env files**

In `services/docker-compose.yml`, in the `gateway` service `environment` section, add:

```yaml
ADMIN_API_KEY: ${ADMIN_API_KEY}
```

In `services/.env.example` and `services/.env.production`, add:

```
ADMIN_API_KEY=changeme-generate-a-strong-random-key
```

Generate a real key for production (e.g., `openssl rand -hex 32`).

**Step 4: Verify locally**

Start the gateway and test:

```bash
# Should return 401 without key
curl http://localhost:3004/admin/cache/keys

# Should return key list with valid key
curl -H "Authorization: Bearer YOUR_KEY" http://localhost:3004/admin/cache/keys

# Should return specific key value
curl -H "Authorization: Bearer YOUR_KEY" http://localhost:3004/admin/cache/key/market:dashboard:v1
```

**Step 5: Commit**

```bash
git add services/gateway/index.cjs services/shared/redis.cjs services/docker-compose.yml services/.env.example services/.env.production
git commit -m "feat(gateway): add authenticated admin cache endpoints"
```

---

## Task 3: Admin UI — Register the new page in dashboard.ts

**Files:**
- Modify: `src/admin/dashboard.ts`

**Step 1: Import and register the page**

At line 8 (after the market-symbols import), add:

```typescript
import { renderServiceSchedulingPage } from './pages/service-scheduling';
```

Update the `PageId` type (line 10) to include the new page:

```typescript
type PageId = 'secrets' | 'feature-flags' | 'news-sources' | 'llm-config' | 'app-keys' | 'display-settings' | 'market-symbols' | 'service-scheduling';
```

Add a nav entry to the `NAV` array (line 12), after market-symbols:

```typescript
{ id: 'service-scheduling', label: 'Service Scheduling', icon: '⏱️' },
```

Add a case in the `navigateTo` switch statement (around line 93):

```typescript
case 'service-scheduling':
  renderServiceSchedulingPage(content, accessToken);
  break;
```

**Step 2: Commit**

```bash
git add src/admin/dashboard.ts
git commit -m "feat(admin): register service-scheduling page in dashboard nav"
```

---

## Task 4: Admin UI — Service Config tab

**Files:**
- Create: `src/admin/pages/service-scheduling.ts`

**Step 1: Create the page file with Service Config tab**

Create `src/admin/pages/service-scheduling.ts`. This is the largest file. The pattern follows existing pages (e.g. `news-sources.ts`): a single `renderXxxPage(container, accessToken)` export that builds HTML and wires up event listeners.

The page should:

1. Render a tab bar with three tabs: Service Config, Source Scheduling, Cache Viewer
2. Service Config tab:
   - Fetch all rows from `wm_admin.service_config` via Supabase REST API (using `accessToken` in Authorization header)
   - Group services by prefix (`ai:`, `news:`, `config:`, then ungrouped)
   - Render a table with columns: Service Key, Description, Enabled (toggle), Cron Schedule (editable), TTL (editable), Timeout (editable), Fetch Type (dropdown), Status badge, Last Run, Duration, Failures, Actions
   - "Trigger Now" button calls `trigger_relay_service` RPC
   - "View Cache" button switches to Cache Viewer tab with pre-filtered key
   - Inline save: clicking Save on a row PATCHes `service_config` via Supabase REST
   - Poll `get_relay_service_statuses` every 30s to refresh status columns
   - Bulk enable/disable: checkboxes on each row + "Enable Selected" / "Disable Selected" buttons

Key implementation details:

- Supabase REST URL pattern: `${SUPABASE_URL}/rest/v1/service_config?select=*&order=service_key` with headers `{ apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + accessToken }`
- Schema qualifier: add `&` prefix or use the `Accept-Profile: wm_admin` header to target the `wm_admin` schema
- For updates: `PATCH ${SUPABASE_URL}/rest/v1/service_config?service_key=eq.${key}` with `Content-Profile: wm_admin` header
- For the trigger RPC: `POST ${SUPABASE_URL}/rest/v1/rpc/trigger_relay_service` with body `{ p_service_key: key }`
- Cron human-readable preview: write a small `cronToHuman(expr)` helper that converts common patterns (e.g. `*/5 * * * *` → "every 5 min", `0 */6 * * *` → "every 6 hours")

Status badge colors:
- `last_status === 'ok'` and `consecutive_failures === 0` → green
- `last_status === 'error'` or `consecutive_failures > 0` → red
- `last_run_at === null` → gray ("never run")

**Step 2: Verify the Service Config tab renders**

Open the admin portal, navigate to Service Scheduling. The table should show all 50 services with correct data. Test inline editing a cron schedule and saving.

**Step 3: Commit**

```bash
git add src/admin/pages/service-scheduling.ts
git commit -m "feat(admin): service config tab with inline editing and trigger"
```

---

## Task 5: Admin UI — Source Scheduling tab

**Files:**
- Modify: `src/admin/pages/service-scheduling.ts`

**Step 1: Add the Source Scheduling tab content**

Add a second tab panel to the page that:

1. Fetches `wm_admin.news_sources` (all 405 rows) via Supabase REST with `Accept-Profile: wm_admin`
2. Renders a table with columns: Name, Category, Tier (badge), Effective Interval (computed), Poll Interval (editable number input, placeholder shows tier default), Custom Cron (editable text input), Enabled (toggle)
3. Filter bar at top: dropdowns for category, tier (1-4), language, enabled (all/yes/no), plus a text search
4. Effective interval computation:
   - If `custom_cron` is set → show cron in human-readable form
   - Else if `poll_interval_minutes` is set → show "every N min"
   - Else → show tier default with "(tier default)" suffix
5. Badge on rows with custom overrides (either `poll_interval_minutes` or `custom_cron` is non-null)
6. "Reset to tier default" button per row: sets both fields to null
7. Bulk actions: select multiple rows, set a shared poll_interval_minutes
8. Save: PATCH `news_sources` via Supabase REST

Tier default map (constant in the file):

```typescript
const TIER_DEFAULTS: Record<number, number> = { 1: 5, 2: 15, 3: 30, 4: 60 };
```

**Step 2: Verify**

Open Source Scheduling tab. Should show all 405 sources. Test:
- Setting a poll_interval_minutes on a source and saving
- Setting a custom_cron on a source and saving
- Resetting to tier default
- Filtering by category and tier

**Step 3: Commit**

```bash
git add src/admin/pages/service-scheduling.ts
git commit -m "feat(admin): source scheduling tab with per-source overrides"
```

---

## Task 6: Admin UI — Cache Viewer tab

**Files:**
- Modify: `src/admin/pages/service-scheduling.ts`

**Step 1: Add the Cache Viewer tab content**

Add a third tab panel with a split-pane layout:

Left panel (key browser):
1. On tab activation, fetch `GET /admin/cache/keys` from the gateway URL (stored in env / config). The gateway URL is already known by the app — check how existing code resolves `WS_URL` or `GATEWAY_URL` and use the same pattern. The admin API key should be fetched from Supabase vault via `get_vault_secret` RPC (the secrets page already does this — follow that pattern from `src/admin/pages/secrets.ts`).
2. Render a scrollable list of keys. Each entry shows:
   - Key name (monospace)
   - TTL remaining as a progress bar (full width if TTL = -1 / no expiry, proportional otherwise based on the service_config TTL for that redis_key)
   - Size in KB
   - Color dot based on prefix
3. Search input at top filters the list by substring match
4. Sort dropdown: name, TTL, size
5. Auto-refresh toggle (checkbox + "Auto-refresh every 30s" label)

Right panel (value inspector):
1. Clicking a key fetches `GET /admin/cache/key/:key` from the gateway
2. Renders:
   - Metadata bar: key name, type, TTL seconds, size
   - JSON viewer: syntax-highlighted, collapsible. Use a simple recursive HTML renderer (no external dependency). Color-code strings (green), numbers (blue), booleans (orange), null (gray), keys (default text color).
   - Copy-to-clipboard button
   - "Invalidate" button → confirmation dialog → `DELETE /admin/cache/key/:key` → refresh key list

Cross-tab link:
- The "View Cache" button on Service Config tab should call a shared function that switches to Cache Viewer tab and pre-fills the search with the service's `redis_key`.

Stale detection:
- If a key's TTL is less than 10% of the matching `service_config.ttl_seconds`, show a yellow warning badge
- If a service is enabled in `service_config` but its `redis_key` is not in the Redis key list, show a red "MISSING" badge on the Service Config tab

**Step 2: Verify**

Open Cache Viewer tab. Should show all Redis keys. Test:
- Click a key to view its JSON value
- Copy to clipboard
- Invalidate a key (use a non-critical one like a test key)
- Search/filter by prefix
- Auto-refresh toggle
- "View Cache" button from Service Config tab

**Step 3: Commit**

```bash
git add src/admin/pages/service-scheduling.ts
git commit -m "feat(admin): cache viewer tab with JSON inspector and invalidation"
```

---

## Task 7: Integration — Wire ADMIN_API_KEY into Supabase vault

**Files:**
- Create: `supabase/migrations/20260309000002_seed_admin_api_key_vault.sql`

**ADMIN_API_KEY dual storage (both required):**

| Location | Purpose |
|----------|---------|
| `services/.env.production` | Gateway reads this for `/admin/cache/*` auth |
| Supabase vault `ADMIN_API_KEY` | Admin portal `/api/admin/admin-api-key` returns it for Cache Viewer |

**The values must match.** For production: generate with `openssl rand -hex 32`, then update both.

**Step 1: Migration seeds vault**

Migration `20260309000002_seed_admin_api_key_vault.sql` creates the vault secret with the same placeholder as `.env.production` (`changeme-generate-a-strong-random-key`). Applied via Supabase MCP.

**Step 2: Cache Viewer flow (already implemented)**

- Cache Viewer tab calls `GET /api/admin/admin-api-key` (with admin JWT)
- API route uses `getSecret('ADMIN_API_KEY')` → reads from vault
- Cache Viewer uses returned key for `Authorization: Bearer` on gateway `/admin/cache/keys`, etc.

**Step 3: Verify end-to-end**

1. Admin logs in
2. Navigate to Service Scheduling → Cache Viewer
3. Tab loads API key from vault, fetches keys from gateway, displays them
4. Click a key to inspect, invalidate works

**Step 4: Production key rotation**

To rotate: generate new key, update both vault (admin portal Secrets page) and `services/.env.production`, restart gateway.

---

## Task 8: CORS and access headers cleanup

**Files:**
- Modify: `services/gateway/index.cjs`

**Step 1: Ensure CORS headers allow the admin portal origin**

The gateway currently sends `Access-Control-Allow-Origin: *`. This is sufficient for the admin portal to reach the gateway. However, ensure the preflight handler also includes `Authorization` in `Access-Control-Allow-Headers` (it already does at line ~307).

**Step 2: Verify from the browser**

Open the admin portal in a browser, open DevTools Network tab, navigate to Cache Viewer. Verify:
- No CORS errors
- Preflight OPTIONS request returns 204 with correct headers
- GET/DELETE requests succeed

**Step 3: Commit (if changes were needed)**

```bash
git add services/gateway/index.cjs
git commit -m "fix(gateway): ensure CORS headers support admin cache routes"
```

---

## Task 9: Final verification and cleanup

**Step 1: Full smoke test**

1. **Service Config tab**: View all 50 services. Edit a cron schedule, save, verify it persists on reload. Trigger a service manually. Watch status refresh.
2. **Source Scheduling tab**: View all 405 sources. Set a poll_interval on a source, save, reload. Set a custom_cron, save. Reset to tier default. Filter by category and tier.
3. **Cache Viewer tab**: Browse all keys. Click to inspect JSON. Copy to clipboard. Invalidate a non-critical key. Use "View Cache" from Service Config. Test auto-refresh.

**Step 2: Verify no regressions**

- Existing admin pages still work (secrets, feature flags, news sources, LLM config, app keys, display settings, market symbols)
- Gateway health endpoint still works: `curl http://localhost:3004/health`
- WebSocket connections still work
- Panel/bootstrap endpoints still work

**Step 3: Final commit**

```bash
git add -A
git commit -m "feat(admin): service scheduling page with config, source scheduling, and cache viewer"
```
