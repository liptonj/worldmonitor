# Display Preferences Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Add configurable display preferences for time format (24h/12h), timezone (UTC/local), and temperature unit (°C/°F) with admin defaults and per-user overrides.

**Architecture:** Admin sets system-wide defaults in a Supabase `display_settings` table. The main app fetches defaults on load. Users override via UnifiedSettings, stored in localStorage. A shared `display-prefs.ts` module resolves effective values: localStorage > admin default > hardcoded fallback. All time/temperature formatting goes through centralized helpers.

**Tech Stack:** Supabase (Postgres), TypeScript, Vercel Edge API routes, vanilla DOM (existing patterns)

---

### Task 1: Supabase Migration — `display_settings` Table

**Files:**
- Create: `supabase/migrations/20260304100000_create_display_settings.sql`

**Step 1: Write migration SQL**

```sql
-- Display settings: system-wide defaults set by admin
CREATE TABLE IF NOT EXISTS wm_admin.display_settings (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  time_format text NOT NULL DEFAULT '24h' CHECK (time_format IN ('24h', '12h')),
  timezone_mode text NOT NULL DEFAULT 'utc' CHECK (timezone_mode IN ('utc', 'local')),
  temp_unit text NOT NULL DEFAULT 'celsius' CHECK (temp_unit IN ('celsius', 'fahrenheit')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Seed the single defaults row
INSERT INTO wm_admin.display_settings (id) VALUES (1) ON CONFLICT DO NOTHING;

-- Auto-update timestamp
CREATE OR REPLACE FUNCTION wm_admin.display_settings_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_display_settings_updated_at
  BEFORE UPDATE ON wm_admin.display_settings
  FOR EACH ROW
  EXECUTE FUNCTION wm_admin.display_settings_updated_at();

-- RPC to read settings (public, no auth needed — these are non-sensitive defaults)
CREATE OR REPLACE FUNCTION public.get_display_settings()
RETURNS json
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT json_build_object(
    'time_format', time_format,
    'timezone_mode', timezone_mode,
    'temp_unit', temp_unit
  )
  FROM wm_admin.display_settings
  WHERE id = 1;
$$;

-- RPC to update settings (admin only, uses is_admin() from existing infra)
CREATE OR REPLACE FUNCTION public.admin_update_display_settings(
  p_time_format text DEFAULT NULL,
  p_timezone_mode text DEFAULT NULL,
  p_temp_unit text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  UPDATE wm_admin.display_settings SET
    time_format = COALESCE(p_time_format, time_format),
    timezone_mode = COALESCE(p_timezone_mode, timezone_mode),
    temp_unit = COALESCE(p_temp_unit, temp_unit)
  WHERE id = 1;
END;
$$;
```

**Step 2: Verify migration applies**

Run: `npx supabase migration list` (or note it for deployment)

**Step 3: Commit**

```bash
git add supabase/migrations/20260304100000_create_display_settings.sql
git commit -m "feat: add display_settings table with admin defaults"
```

---

### Task 2: Admin API Endpoint — `/api/admin/display-settings.ts`

**Files:**
- Create: `api/admin/display-settings.ts`

This follows the exact same pattern as `api/admin/feature-flags.ts`:
- Import `requireAdmin`, `errorResponse`, `corsHeaders` from `./_auth`
- `GET` → call `client.rpc('get_display_settings')`, return JSON
- `PUT` → parse body `{ time_format?, timezone_mode?, temp_unit? }`, call `client.rpc('admin_update_display_settings', { ... })`, return `{ ok: true }`
- Handle CORS OPTIONS

**Implementation:**

```typescript
import { requireAdmin, errorResponse, corsHeaders } from './_auth';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  const headers = corsHeaders();
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });

  let admin;
  try { admin = await requireAdmin(req); } catch (err) { return errorResponse(err); }

  const { client } = admin;

  if (req.method === 'GET') {
    const { data, error } = await client.rpc('get_display_settings');
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    return new Response(JSON.stringify(data), { status: 200, headers });
  }

  if (req.method === 'PUT') {
    const body = (await req.json()) as {
      time_format?: string;
      timezone_mode?: string;
      temp_unit?: string;
    };
    const { error } = await client.rpc('admin_update_display_settings', {
      p_time_format: body.time_format ?? null,
      p_timezone_mode: body.timezone_mode ?? null,
      p_temp_unit: body.temp_unit ?? null,
    });
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
}
```

**Step: Commit**

```bash
git add api/admin/display-settings.ts
git commit -m "feat: add admin API endpoint for display settings"
```

---

### Task 3: Admin UI Page — Display Settings

**Files:**
- Create: `src/admin/pages/display-settings.ts`
- Modify: `src/admin/dashboard.ts` — add nav item, import, and case

**Admin page implementation (`src/admin/pages/display-settings.ts`):**

Follow the existing pattern from `feature-flags.ts`. Create a `renderDisplaySettingsPage(container, token)` function:
- Fetch current settings from `/api/admin/display-settings` (GET)
- Render three `<select>` dropdowns (time format, timezone, temp unit) styled with inline styles matching existing admin pages
- On change, PUT to `/api/admin/display-settings` with the changed value
- Show save confirmation

**Dashboard integration (`src/admin/dashboard.ts`):**

1. Add to `PageId` type: `| 'display-settings'`
2. Add to `NAV` array: `{ id: 'display-settings', label: 'Display Settings', icon: '🖥️' }`
3. Import `renderDisplaySettingsPage` from `./pages/display-settings`
4. Add case in `navigateTo` switch

**Step: Commit**

```bash
git add src/admin/pages/display-settings.ts src/admin/dashboard.ts
git commit -m "feat: add Display Settings admin page"
```

---

### Task 4: Display Preferences Module — `src/utils/display-prefs.ts`

**Files:**
- Create: `src/utils/display-prefs.ts`

This is the core shared module. It:

1. Defines types:
   ```typescript
   type TimeFormat = '24h' | '12h';
   type TimezoneMode = 'utc' | 'local';
   type TempUnit = 'celsius' | 'fahrenheit';
   ```

2. Caches admin defaults fetched from Supabase RPC `get_display_settings` (called once at app startup)

3. Exports getters that resolve localStorage > admin default > hardcoded fallback:
   - `getTimeFormat(): TimeFormat` — reads `localStorage.getItem('display-time-format')` ?? adminDefault ?? `'24h'`
   - `getTimezoneMode(): TimezoneMode` — reads `localStorage.getItem('display-timezone-mode')` ?? adminDefault ?? `'utc'`
   - `getTempUnit(): TempUnit` — reads `localStorage.getItem('display-temp-unit')` ?? adminDefault ?? `'celsius'`

4. Exports setters for user overrides:
   - `setTimeFormat(v: TimeFormat)` — writes localStorage, dispatches `CustomEvent('display-prefs-changed')`
   - `setTimezoneMode(v: TimezoneMode)` — same
   - `setTempUnit(v: TempUnit)` — same

5. Exports formatting helpers:
   - `formatClockTime(date: Date): string` — formats using current timeFormat + timezoneMode
   - `convertTemp(celsius: number): number` — converts if unit is fahrenheit
   - `getTempUnitLabel(): string` — returns `'°C'` or `'°F'`

6. Exports init function:
   - `initDisplayPrefs(): Promise<void>` — fetches admin defaults from Supabase, caches in memory. Uses `fetch` or the existing Supabase anon client. Called once during app startup.

**Step: Commit**

```bash
git add src/utils/display-prefs.ts
git commit -m "feat: add display-prefs module with admin defaults and user overrides"
```

---

### Task 5: Integrate Display Prefs — Header Clock

**Files:**
- Modify: `src/app/event-handlers.ts` — `startHeaderClock()` method (around line 420)

**Current code:**
```typescript
const tick = () => {
  el.textContent = new Date().toUTCString().replace('GMT', 'UTC');
};
```

**New code:**
```typescript
import { formatClockTime } from '../utils/display-prefs';
// ...
const tick = () => {
  el.textContent = formatClockTime(new Date());
};
```

Also add a listener in `setupEventListeners()` for `display-prefs-changed` to restart the clock tick so the format updates immediately.

**Step: Commit**

```bash
git add src/app/event-handlers.ts
git commit -m "feat: use display-prefs for header clock formatting"
```

---

### Task 6: Integrate Display Prefs — World Clock Panel

**Files:**
- Modify: `src/components/WorldClockPanel.ts` — `getTimeInZone()` function (around line 96)

**Current code:**
```typescript
const parts = new Intl.DateTimeFormat(getLocale(), {
  timeZone: tz, hour: 'numeric', minute: 'numeric', second: 'numeric',
  hour12: false, weekday: 'short',
  numberingSystem: 'latn',
}).formatToParts(now);
```

**New code:**
```typescript
import { getTimeFormat } from '../utils/display-prefs';
// ...
const parts = new Intl.DateTimeFormat(getLocale(), {
  timeZone: tz, hour: 'numeric', minute: 'numeric', second: 'numeric',
  hour12: getTimeFormat() === '12h', weekday: 'short',
  numberingSystem: 'latn',
}).formatToParts(now);
```

Also needs to handle the AM/PM `dayPeriod` part when `hour12` is true, and listen for `display-prefs-changed` to re-render.

**Step: Commit**

```bash
git add src/components/WorldClockPanel.ts
git commit -m "feat: use display-prefs for World Clock time format"
```

---

### Task 7: Integrate Display Prefs — Climate Anomalies Panel

**Files:**
- Modify: `src/components/ClimateAnomalyPanel.ts` (around line 51)
- Modify: `src/services/climate/index.ts` — `formatDelta()` function (around line 63)

**Current code in ClimateAnomalyPanel.ts:**
```typescript
<td class="climate-num ${tempClass}">${formatDelta(a.tempDelta, '°C')}</td>
```

**New code:**
```typescript
import { convertTemp, getTempUnitLabel } from '../utils/display-prefs';
// ...
<td class="climate-num ${tempClass}">${formatDelta(convertTemp(a.tempDelta), getTempUnitLabel())}</td>
```

The `convertTemp()` function handles the math: if unit is fahrenheit, convert delta by multiplying by 9/5 (delta conversion, not absolute). `getTempUnitLabel()` returns `'°C'` or `'°F'`.

Also listen for `display-prefs-changed` to re-render.

**Step: Commit**

```bash
git add src/components/ClimateAnomalyPanel.ts src/services/climate/index.ts
git commit -m "feat: use display-prefs for climate temperature unit"
```

---

### Task 8: User Settings UI — UnifiedSettings General Tab

**Files:**
- Modify: `src/components/UnifiedSettings.ts` — `renderGeneralContent()` method (around line 290)

Add a new "Display" section to the General tab with three `<select>` dropdowns:
- **Time Format**: 24-hour / 12-hour (AM/PM)
- **Timezone**: UTC / Local
- **Temperature Unit**: Celsius (°C) / Fahrenheit (°F)

Use the same styling pattern as the Language and Stream Quality selects already in that tab.

On change, call the setters from `display-prefs.ts` which handle localStorage + dispatching the `display-prefs-changed` event.

Wire up event listeners in the existing `bindGeneralListeners()` (or equivalent method).

**Step: Commit**

```bash
git add src/components/UnifiedSettings.ts
git commit -m "feat: add display preferences to UnifiedSettings General tab"
```

---

### Task 9: App Startup Integration

**Files:**
- Modify: `src/app/panel-layout.ts` or `src/main.ts` — wherever the app initializes

Call `initDisplayPrefs()` early in the app startup sequence (before panels render) so admin defaults are fetched and cached before any formatting occurs.

**Step: Commit**

```bash
git add src/main.ts
git commit -m "feat: initialize display preferences on app startup"
```
