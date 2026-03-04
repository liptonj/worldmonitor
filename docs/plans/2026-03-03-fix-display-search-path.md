# Fix display Schema Function Search Path Mutable Warnings

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `SET search_path = ''` to every `display` and `public` schema function that is missing it, eliminating all 24 `function_search_path_mutable` security advisor warnings.

**Architecture:** A single migration file patches all affected functions with `CREATE OR REPLACE FUNCTION` — the simplest safe approach. Each function body is unchanged; only the `SET search_path = ''` clause is added to the function header and all unqualified table/schema references inside are fully qualified. No application code changes needed since the fix is purely at the database level.

**Tech Stack:** PostgreSQL 17 (Supabase), `apply_migration` MCP tool for deployment, `get_advisors` MCP tool to verify.

---

## Background: Why This Matters

PostgreSQL's `search_path` controls which schema is searched when an unqualified object name (e.g. `pairings` instead of `display.pairings`) is referenced. If an attacker or misconfigured role can change `search_path`, they can hijack a `SECURITY DEFINER` function into calling a malicious shadow table instead of the real one. The fix is to set `search_path = ''` (empty) in the function definition, which forces all identifiers to be fully qualified.

**Functions affected:** 24 total across `display` and `public` schemas.

All unqualified table/function references inside each function body must also be schema-qualified once `search_path = ''` is set, or the function will error at runtime.

---

## Pre-flight Check

Before starting, verify current warning count:

```
MCP: get_advisors(project_id="fmultmlsevqgtnqzaylg", type="security")
```

Expected: 24+ warnings all named `function_search_path_mutable` in `display` or `public` schemas. Zero warnings in `wm_admin` (already fixed).

---

### Task 1: Fix `display.update_updated_at` and `display.update_release_artifacts_updated_at`

**Files:**
- Create: `supabase/migrations/20260303000002_fix_display_search_path.sql`

These two are simple `RETURNS TRIGGER` functions that only reference `NEW` (a trigger pseudo-row — no schema needed). The fix is just adding `SET search_path = ''`.

**Step 1: Create the migration file**

```sql
-- supabase/migrations/20260303000002_fix_display_search_path.sql
-- Fix function_search_path_mutable warnings: display + public schemas
-- Adds SET search_path = '' to all 24 affected functions.
-- All unqualified table references inside function bodies are fully qualified.

-- 1. display.update_updated_at (trigger: sets NEW.updated_at)
CREATE OR REPLACE FUNCTION display.update_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

-- 2. display.update_release_artifacts_updated_at (trigger: sets NEW.updated_at)
CREATE OR REPLACE FUNCTION display.update_release_artifacts_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;
```

**Step 2: Apply via MCP**

```
MCP: apply_migration(
  project_id="fmultmlsevqgtnqzaylg",
  name="fix_display_search_path",
  query=<contents of the file above>
)
```

Expected: `{"success": true}`

**Step 3: Verify no runtime error**

```
MCP: execute_sql(
  project_id="fmultmlsevqgtnqzaylg",
  query="SELECT display.update_updated_at IS NOT NULL;"
)
```

Expected: query returns without error (the function exists and is callable).

**Step 4: Commit**

```bash
git add supabase/migrations/20260303000002_fix_display_search_path.sql
git commit -m "fix(db): add SET search_path='' to display.update_updated_at and update_release_artifacts_updated_at"
```

---

### Task 2: Fix `display.update_status_timestamp` and `display.status_values_changed`

**Files:**
- Modify: `supabase/migrations/20260303000002_fix_display_search_path.sql`

Both reference `display.pairings` inside their bodies (must be fully qualified with `search_path = ''`).

`status_values_changed` uses `display.pairings%ROWTYPE` which requires full qualification.

**Step 1: Append to the migration file**

```sql
-- 3. display.update_status_timestamp (trigger: updates status_updated_at)
CREATE OR REPLACE FUNCTION display.update_status_timestamp()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    IF (
        COALESCE(NEW.webex_status, '') IS DISTINCT FROM COALESCE(OLD.webex_status, '') OR
        COALESCE(NEW.camera_on, FALSE) IS DISTINCT FROM COALESCE(OLD.camera_on, FALSE) OR
        COALESCE(NEW.mic_muted, FALSE) IS DISTINCT FROM COALESCE(OLD.mic_muted, FALSE) OR
        COALESCE(NEW.in_call, FALSE) IS DISTINCT FROM COALESCE(OLD.in_call, FALSE) OR
        COALESCE(NEW.display_name, '') IS DISTINCT FROM COALESCE(OLD.display_name, '') OR
        COALESCE(NEW.device_connected, FALSE) IS DISTINCT FROM COALESCE(OLD.device_connected, FALSE) OR
        COALESCE(NEW.app_connected, FALSE) IS DISTINCT FROM COALESCE(OLD.app_connected, FALSE)
    ) THEN
        NEW.status_updated_at = NOW();
    ELSE
        NEW.status_updated_at = OLD.status_updated_at;
    END IF;
    RETURN NEW;
END;
$$;

-- 4. display.status_values_changed (STABLE: reads display.pairings)
CREATE OR REPLACE FUNCTION display.status_values_changed(
    p_pairing_code text,
    p_webex_status text DEFAULT NULL,
    p_camera_on boolean DEFAULT NULL,
    p_mic_muted boolean DEFAULT NULL,
    p_in_call boolean DEFAULT NULL,
    p_display_name text DEFAULT NULL,
    p_app_connected boolean DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
    current_record display.pairings%ROWTYPE;
    has_changes BOOLEAN := FALSE;
BEGIN
    SELECT * INTO current_record
    FROM display.pairings
    WHERE pairing_code = p_pairing_code;

    IF NOT FOUND THEN
        RETURN TRUE;
    END IF;

    IF p_app_connected IS NOT NULL AND
       p_app_connected IS DISTINCT FROM COALESCE(current_record.app_connected, FALSE) THEN
        has_changes := TRUE;
    END IF;
    IF p_webex_status IS NOT NULL AND
       COALESCE(p_webex_status, '') IS DISTINCT FROM COALESCE(current_record.webex_status, '') THEN
        has_changes := TRUE;
    END IF;
    IF p_camera_on IS NOT NULL AND
       p_camera_on IS DISTINCT FROM COALESCE(current_record.camera_on, FALSE) THEN
        has_changes := TRUE;
    END IF;
    IF p_mic_muted IS NOT NULL AND
       p_mic_muted IS DISTINCT FROM COALESCE(current_record.mic_muted, FALSE) THEN
        has_changes := TRUE;
    END IF;
    IF p_in_call IS NOT NULL AND
       p_in_call IS DISTINCT FROM COALESCE(current_record.in_call, FALSE) THEN
        has_changes := TRUE;
    END IF;
    IF p_display_name IS NOT NULL AND
       COALESCE(p_display_name, '') IS DISTINCT FROM COALESCE(current_record.display_name, '') THEN
        has_changes := TRUE;
    END IF;
    RETURN has_changes;
END;
$$;
```

**Step 2: Apply via MCP** (append-only additions — safe to re-run CREATE OR REPLACE)

**Step 3: Spot-check**

```
MCP: execute_sql(
  project_id="fmultmlsevqgtnqzaylg",
  query="SELECT proname, proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='display' AND proname IN ('update_status_timestamp','status_values_changed');"
)
```

Expected: both rows show `proconfig = ["search_path=\"\""]`

**Step 4: Commit**

```bash
git commit -am "fix(db): add SET search_path='' to display.update_status_timestamp and status_values_changed"
```

---

### Task 3: Fix `display.ensure_single_latest` and `display.prevent_immutable_device_updates`

**Files:**
- Modify: `supabase/migrations/20260303000002_fix_display_search_path.sql`

`ensure_single_latest` references `display.releases` (must qualify).
`prevent_immutable_device_updates` uses only `OLD`/`NEW` trigger rows — no schema refs needed in body.

**Step 1: Append to migration**

```sql
-- 5. display.ensure_single_latest (trigger: enforces single is_latest per channel)
CREATE OR REPLACE FUNCTION display.ensure_single_latest()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    IF NEW.is_latest = TRUE THEN
        UPDATE display.releases
        SET is_latest = FALSE
        WHERE id != NEW.id
          AND is_latest = TRUE
          AND release_channel = NEW.release_channel;
    END IF;
    RETURN NEW;
END;
$$;

-- 6. display.prevent_immutable_device_updates (trigger: guards serial_number, device_id, key_hash)
CREATE OR REPLACE FUNCTION display.prevent_immutable_device_updates()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    IF OLD.serial_number IS DISTINCT FROM NEW.serial_number THEN
        RAISE EXCEPTION 'Cannot update immutable field: serial_number';
    END IF;
    IF OLD.device_id IS DISTINCT FROM NEW.device_id THEN
        RAISE EXCEPTION 'Cannot update immutable field: device_id';
    END IF;
    IF OLD.key_hash IS DISTINCT FROM NEW.key_hash THEN
        RAISE EXCEPTION 'Cannot update immutable field: key_hash';
    END IF;
    RETURN NEW;
END;
$$;
```

**Step 2: Apply via MCP**

**Step 3: Commit**

```bash
git commit -am "fix(db): add SET search_path='' to display.ensure_single_latest and prevent_immutable_device_updates"
```

---

### Task 4: Fix `display.pairings_presence_trigger` and `display.broadcast_commands_changes`

**Files:**
- Modify: `supabase/migrations/20260303000002_fix_display_search_path.sql`

Both reference `display.connection_heartbeats` and `realtime.broadcast_changes` — must be fully qualified.

**Step 1: Append to migration**

```sql
-- 7. display.pairings_presence_trigger (trigger: upserts connection heartbeat)
CREATE OR REPLACE FUNCTION display.pairings_presence_trigger()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    INSERT INTO display.connection_heartbeats (
        device_uuid, app_last_seen, app_connected,
        device_last_seen, device_connected, updated_at
    )
    VALUES (
        NEW.device_uuid, NEW.app_last_seen, NEW.app_connected,
        NEW.device_last_seen, NEW.device_connected, NOW()
    )
    ON CONFLICT (device_uuid) DO UPDATE SET
        app_last_seen    = COALESCE(EXCLUDED.app_last_seen,    display.connection_heartbeats.app_last_seen),
        app_connected    = COALESCE(EXCLUDED.app_connected,    display.connection_heartbeats.app_connected),
        device_last_seen = COALESCE(EXCLUDED.device_last_seen, display.connection_heartbeats.device_last_seen),
        device_connected = COALESCE(EXCLUDED.device_connected, display.connection_heartbeats.device_connected),
        updated_at       = NOW();
    RETURN NEW;
END;
$$;

-- 8. display.broadcast_commands_changes (trigger: realtime broadcast for commands)
CREATE OR REPLACE FUNCTION display.broadcast_commands_changes()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    topic     text;
    device_id uuid;
BEGIN
    device_id := COALESCE(NEW.device_uuid, OLD.device_uuid);
    IF device_id IS NULL THEN
        RETURN NEW;
    END IF;
    topic := 'device:' || device_id::text || ':events';
    PERFORM realtime.broadcast_changes(
        topic, 'command_changed', TG_OP,
        TG_TABLE_NAME, TG_TABLE_SCHEMA, NEW, OLD, 'ROW'
    );
    RETURN NEW;
END;
$$;
```

**Step 2: Apply via MCP**

**Step 3: Commit**

```bash
git commit -am "fix(db): add SET search_path='' to display.pairings_presence_trigger and broadcast_commands_changes"
```

---

### Task 5: Fix `display.cleanup_old_commands`, `display.cleanup_rate_limits`, `display.cleanup_old_logs`

**Files:**
- Modify: `supabase/migrations/20260303000002_fix_display_search_path.sql`

All reference `display.*` tables — must qualify. `cleanup_old_logs` is already `SECURITY DEFINER` but missing `search_path`.

**Step 1: Append to migration**

```sql
-- 9. display.cleanup_old_commands (expires pending + deletes old commands)
CREATE OR REPLACE FUNCTION display.cleanup_old_commands()
RETURNS integer
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    expired_count INTEGER;
    deleted_count INTEGER;
    total_affected INTEGER;
BEGIN
    UPDATE display.commands
    SET status = 'expired'
    WHERE status = 'pending' AND expires_at < NOW();
    GET DIAGNOSTICS expired_count = ROW_COUNT;

    DELETE FROM display.commands
    WHERE created_at < NOW() - INTERVAL '24 hours'
      AND status IN ('acked', 'failed', 'expired');
    GET DIAGNOSTICS deleted_count = ROW_COUNT;

    total_affected := expired_count + deleted_count;
    IF total_affected > 0 THEN
        RAISE NOTICE 'Command cleanup: % expired, % deleted', expired_count, deleted_count;
    END IF;
    RETURN total_affected;
END;
$$;

-- 10. display.cleanup_rate_limits (deletes stale rate limit entries)
CREATE OR REPLACE FUNCTION display.cleanup_rate_limits()
RETURNS integer
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM display.rate_limits
    WHERE updated_at < NOW() - INTERVAL '2 minutes';
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$;

-- 11. display.cleanup_old_logs (SECURITY DEFINER: deletes device logs > 30 days)
CREATE OR REPLACE FUNCTION display.cleanup_old_logs()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    DELETE FROM display.device_logs
    WHERE created_at < NOW() - INTERVAL '30 days';
END;
$$;
```

**Step 2: Apply via MCP**

**Step 3: Commit**

```bash
git commit -am "fix(db): add SET search_path='' to display cleanup functions"
```

---

### Task 6: Fix `display.check_connection_timeouts`

**Files:**
- Modify: `supabase/migrations/20260303000002_fix_display_search_path.sql`

References `display.pairings` — must qualify.

**Step 1: Append to migration**

```sql
-- 12. display.check_connection_timeouts (marks stale connections as disconnected)
CREATE OR REPLACE FUNCTION display.check_connection_timeouts(timeout_seconds integer DEFAULT 60)
RETURNS integer
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    updated_count INTEGER := 0;
    device_updated INTEGER;
    app_updated INTEGER;
BEGIN
    UPDATE display.pairings
    SET device_connected = FALSE
    WHERE device_connected = TRUE
      AND device_last_seen < NOW() - (timeout_seconds || ' seconds')::INTERVAL;
    GET DIAGNOSTICS device_updated = ROW_COUNT;

    UPDATE display.pairings
    SET app_connected = FALSE
    WHERE app_connected = TRUE
      AND app_last_seen < NOW() - (timeout_seconds || ' seconds')::INTERVAL;
    GET DIAGNOSTICS app_updated = ROW_COUNT;

    updated_count := device_updated + app_updated;
    IF updated_count > 0 THEN
        RAISE NOTICE 'Connection timeout: % devices, % apps marked disconnected',
            device_updated, app_updated;
    END IF;
    RETURN updated_count;
END;
$$;
```

**Step 2: Apply via MCP**

**Step 3: Commit**

```bash
git commit -am "fix(db): add SET search_path='' to display.check_connection_timeouts"
```

---

### Task 7: Fix `display.check_rate_limit`

**Files:**
- Modify: `supabase/migrations/20260303000002_fix_display_search_path.sql`

References `display.rate_limits` in an `INSERT ... ON CONFLICT` — must qualify the table name in both the INSERT target and the conflict update's backreference.

**Step 1: Append to migration**

```sql
-- 13. display.check_rate_limit (upserts rate limit counter, returns bool)
CREATE OR REPLACE FUNCTION display.check_rate_limit(
    rate_key text,
    max_requests integer DEFAULT 12,
    window_seconds integer DEFAULT 60
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    current_count INTEGER;
    window_started TIMESTAMPTZ;
BEGIN
    INSERT INTO display.rate_limits (key, request_count, window_start, updated_at)
    VALUES (rate_key, 1, NOW(), NOW())
    ON CONFLICT (key) DO UPDATE
    SET
        request_count = CASE
            WHEN display.rate_limits.window_start < NOW() - (window_seconds || ' seconds')::INTERVAL
            THEN 1
            ELSE display.rate_limits.request_count + 1
        END,
        window_start = CASE
            WHEN display.rate_limits.window_start < NOW() - (window_seconds || ' seconds')::INTERVAL
            THEN NOW()
            ELSE display.rate_limits.window_start
        END,
        updated_at = NOW()
    RETURNING request_count, window_start INTO current_count, window_started;

    RETURN current_count <= max_requests;
END;
$$;
```

**Step 2: Apply via MCP**

**Step 3: Spot-check the function still works**

```
MCP: execute_sql(
  project_id="fmultmlsevqgtnqzaylg",
  query="SELECT display.check_rate_limit('test_search_path_fix', 100, 60);"
)
```

Expected: `true`

**Step 4: Commit**

```bash
git commit -am "fix(db): add SET search_path='' to display.check_rate_limit"
```

---

### Task 8: Fix `display.clear_expired_pairing_codes`, `display.clear_pairing_code`, `display.generate_pairing_code`

**Files:**
- Modify: `supabase/migrations/20260303000002_fix_display_search_path.sql`

All reference `display.devices` and/or `display.pairings`. `generate_pairing_code` uses `md5()` and `random()` — these are built-in Postgres functions not affected by `search_path`.

**Step 1: Append to migration**

```sql
-- 14. display.clear_expired_pairing_codes (clears expired codes from devices + pairings)
CREATE OR REPLACE FUNCTION display.clear_expired_pairing_codes()
RETURNS integer
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    cleared_devices  integer;
    cleared_pairings integer;
BEGIN
    UPDATE display.devices
    SET pairing_code = NULL, pairing_code_expires_at = NULL
    WHERE pairing_code IS NOT NULL
      AND pairing_code_expires_at IS NOT NULL
      AND pairing_code_expires_at < NOW();
    GET DIAGNOSTICS cleared_devices = ROW_COUNT;

    UPDATE display.pairings
    SET pairing_code = NULL, pairing_code_expires_at = NULL
    WHERE pairing_code IS NOT NULL
      AND pairing_code_expires_at IS NOT NULL
      AND pairing_code_expires_at < NOW();
    GET DIAGNOSTICS cleared_pairings = ROW_COUNT;

    IF cleared_devices + cleared_pairings > 0 THEN
        RAISE NOTICE 'Cleared expired pairing codes: % devices, % pairings',
            cleared_devices, cleared_pairings;
    END IF;
    RETURN cleared_devices + cleared_pairings;
END;
$$;

-- 15. display.clear_pairing_code (SECURITY DEFINER: clears code for one device)
CREATE OR REPLACE FUNCTION display.clear_pairing_code(target_device_uuid uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    UPDATE display.devices
    SET pairing_code = NULL, pairing_code_expires_at = NULL
    WHERE id = target_device_uuid;

    UPDATE display.pairings
    SET pairing_code = NULL, pairing_code_expires_at = NULL
    WHERE device_uuid = target_device_uuid;
END;
$$;

-- 16. display.generate_pairing_code (SECURITY DEFINER: generates 6-char code, sets expiry)
CREATE OR REPLACE FUNCTION display.generate_pairing_code(
    target_device_uuid uuid,
    expiry_minutes integer DEFAULT 10
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    new_code    text;
    expiry_time timestamptz;
BEGIN
    new_code    := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));
    expiry_time := NOW() + (expiry_minutes || ' minutes')::interval;

    UPDATE display.devices
    SET pairing_code = new_code, pairing_code_expires_at = expiry_time
    WHERE id = target_device_uuid;

    UPDATE display.pairings
    SET pairing_code = new_code, pairing_code_expires_at = expiry_time
    WHERE device_uuid = target_device_uuid;

    RETURN new_code;
END;
$$;
```

**Step 2: Apply via MCP**

**Step 3: Commit**

```bash
git commit -am "fix(db): add SET search_path='' to display pairing code functions"
```

---

### Task 9: Fix `display.set_latest_release` (both overloads) and `display.user_can_access_device` (both overloads)

**Files:**
- Modify: `supabase/migrations/20260303000002_fix_display_search_path.sql`

`set_latest_release` has two overloads (1-arg and 2-arg). Both reference `display.releases`.
`user_can_access_device` has two overloads (by `serial_number` text, by `device_uuid` uuid). Both call `display.is_admin()` and reference `display.user_devices`, `display.user_profiles` — must qualify. They also reference `auth.uid()` which is already schema-qualified.

**Step 1: Append to migration**

```sql
-- 17. display.set_latest_release(text) — 1-arg overload
CREATE OR REPLACE FUNCTION display.set_latest_release(target_version text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    UPDATE display.releases SET is_latest = FALSE WHERE is_latest = TRUE;
    UPDATE display.releases SET is_latest = TRUE  WHERE version = target_version;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Release version % not found', target_version;
    END IF;
END;
$$;

-- 18. display.set_latest_release(text, text) — 2-arg overload (channel-scoped)
CREATE OR REPLACE FUNCTION display.set_latest_release(
    target_version text,
    target_channel text DEFAULT 'production'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    UPDATE display.releases
    SET is_latest = FALSE
    WHERE is_latest = TRUE AND release_channel = target_channel;

    UPDATE display.releases
    SET is_latest = TRUE
    WHERE version = target_version AND release_channel = target_channel;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Release version % in channel % not found', target_version, target_channel;
    END IF;
END;
$$;

-- 19. display.user_can_access_device(text) — by serial_number
CREATE OR REPLACE FUNCTION display.user_can_access_device(target_serial text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF display.is_admin() THEN
        RETURN TRUE;
    END IF;
    RETURN EXISTS (
        SELECT 1
        FROM display.user_devices ud
        JOIN display.user_profiles up ON up.user_id = ud.user_id
        WHERE ud.user_id = auth.uid()
          AND ud.serial_number = target_serial
          AND up.disabled = FALSE
    );
END;
$$;

-- 20. display.user_can_access_device(uuid) — by device_uuid
CREATE OR REPLACE FUNCTION display.user_can_access_device(target_device_uuid uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF display.is_admin() THEN
        RETURN TRUE;
    END IF;
    RETURN EXISTS (
        SELECT 1
        FROM display.user_devices ud
        JOIN display.user_profiles up ON up.user_id = ud.user_id
        WHERE ud.user_id = auth.uid()
          AND ud.device_uuid = target_device_uuid
          AND up.disabled = FALSE
    );
END;
$$;
```

**Step 2: Apply via MCP**

**Step 3: Commit**

```bash
git commit -am "fix(db): add SET search_path='' to display.set_latest_release and user_can_access_device"
```

---

### Task 10: Fix `public` schema wrappers (`public.set_latest_release`, `public.display_check_rate_limit`, `public.display_commands_broadcast_trigger`, `public.display_firmware_updates_broadcast_trigger`, `public.display_heartbeats_broadcast_trigger`)

**Files:**
- Modify: `supabase/migrations/20260303000002_fix_display_search_path.sql`

These are thin wrappers or realtime broadcast triggers living in `public`. They call `display.*` functions or `realtime.broadcast_changes` — all must be fully qualified.

**Step 1: Append to migration**

```sql
-- 21. public.set_latest_release — delegates to display schema
CREATE OR REPLACE FUNCTION public.set_latest_release(
    target_version text,
    target_channel text DEFAULT 'production'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    PERFORM display.set_latest_release(target_version, target_channel);
END;
$$;

-- 22. public.display_check_rate_limit — delegates to display.check_rate_limit
CREATE OR REPLACE FUNCTION public.display_check_rate_limit(
    rate_key text,
    max_requests integer DEFAULT 12,
    window_seconds integer DEFAULT 60
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    RETURN display.check_rate_limit(rate_key, max_requests, window_seconds);
END;
$$;

-- 23. public.display_commands_broadcast_trigger — realtime broadcast for commands
CREATE OR REPLACE FUNCTION public.display_commands_broadcast_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    topic     text;
    device_id uuid;
BEGIN
    device_id := COALESCE(NEW.device_uuid, OLD.device_uuid);
    IF device_id IS NULL THEN
        RETURN NEW;
    END IF;
    topic := 'device:' || device_id::text || ':events';
    PERFORM realtime.broadcast_changes(
        topic, 'command_changed', TG_OP,
        TG_TABLE_NAME, TG_TABLE_SCHEMA, NEW, OLD, 'ROW'
    );
    RETURN NEW;
END;
$$;

-- 24. public.display_firmware_updates_broadcast_trigger — realtime broadcast for firmware
CREATE OR REPLACE FUNCTION public.display_firmware_updates_broadcast_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    topic     text;
    device_id uuid;
BEGIN
    device_id := COALESCE(NEW.id, OLD.id);
    IF device_id IS NULL THEN
        RETURN NEW;
    END IF;
    topic := 'device:' || device_id::text || ':firmware';
    PERFORM realtime.broadcast_changes(
        topic, 'firmware_update', TG_OP,
        TG_TABLE_NAME, TG_TABLE_SCHEMA, NEW, OLD, 'ROW'
    );
    RETURN NEW;
END;
$$;

-- 25. public.display_heartbeats_broadcast_trigger — realtime broadcast for heartbeats
CREATE OR REPLACE FUNCTION public.display_heartbeats_broadcast_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    topic     text;
    device_id uuid;
BEGIN
    device_id := COALESCE(NEW.device_uuid, OLD.device_uuid);
    IF device_id IS NULL THEN
        RETURN NEW;
    END IF;
    topic := 'device:' || device_id::text || ':heartbeats';
    PERFORM realtime.broadcast_changes(
        topic, 'heartbeat_changed', TG_OP,
        TG_TABLE_NAME, TG_TABLE_SCHEMA, NEW, OLD, 'ROW'
    );
    RETURN NEW;
END;
$$;
```

**Step 2: Apply via MCP**

**Step 3: Commit**

```bash
git commit -am "fix(db): add SET search_path='' to all public schema display wrapper functions"
```

---

### Task 11: Verify all warnings are gone

**Step 1: Run security advisor**

```
MCP: get_advisors(project_id="fmultmlsevqgtnqzaylg", type="security")
```

Expected result: **zero** `function_search_path_mutable` warnings. The only remaining warning should be `auth_leaked_password_protection` (a Supabase Auth config setting, not a function issue — handled separately if desired).

**Step 2: Run performance advisor for completeness**

```
MCP: get_advisors(project_id="fmultmlsevqgtnqzaylg", type="performance")
```

Review any performance warnings — these are pre-existing and out of scope for this plan.

**Step 3: Confirm function proconfig in the DB**

```
MCP: execute_sql(
  project_id="fmultmlsevqgtnqzaylg",
  query="
    SELECT n.nspname AS schema, p.proname AS function_name,
           p.proconfig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('display', 'public')
      AND p.proname IN (
        'update_updated_at','update_release_artifacts_updated_at',
        'update_status_timestamp','status_values_changed',
        'ensure_single_latest','prevent_immutable_device_updates',
        'pairings_presence_trigger','broadcast_commands_changes',
        'cleanup_old_commands','cleanup_rate_limits','cleanup_old_logs',
        'check_connection_timeouts','check_rate_limit',
        'clear_expired_pairing_codes','clear_pairing_code','generate_pairing_code',
        'set_latest_release','user_can_access_device',
        'display_check_rate_limit','display_commands_broadcast_trigger',
        'display_firmware_updates_broadcast_trigger','display_heartbeats_broadcast_trigger'
      )
    ORDER BY n.nspname, p.proname;
  "
)
```

Expected: every row shows `proconfig = [\"search_path=\"\"\"]`

**Step 4: Final commit**

```bash
git commit -am "fix(db): all display/public function_search_path_mutable warnings resolved"
```

---

## Summary of Changes

| Schema | Function | Fix Applied |
|--------|----------|-------------|
| `display` | `update_updated_at` | + `SET search_path = ''` |
| `display` | `update_release_artifacts_updated_at` | + `SET search_path = ''` |
| `display` | `update_status_timestamp` | + `SET search_path = ''` |
| `display` | `status_values_changed` | + `SET search_path = ''`, qualified `display.pairings` |
| `display` | `ensure_single_latest` | + `SET search_path = ''`, qualified `display.releases` |
| `display` | `prevent_immutable_device_updates` | + `SET search_path = ''` |
| `display` | `pairings_presence_trigger` | + `SET search_path = ''`, qualified `display.connection_heartbeats` |
| `display` | `broadcast_commands_changes` | + `SET search_path = ''`, qualified `realtime.broadcast_changes` |
| `display` | `cleanup_old_commands` | + `SET search_path = ''`, qualified `display.commands` |
| `display` | `cleanup_rate_limits` | + `SET search_path = ''`, qualified `display.rate_limits` |
| `display` | `cleanup_old_logs` | + `SET search_path = ''`, qualified `display.device_logs` |
| `display` | `check_connection_timeouts` | + `SET search_path = ''`, qualified `display.pairings` |
| `display` | `check_rate_limit` | + `SET search_path = ''`, qualified `display.rate_limits` |
| `display` | `clear_expired_pairing_codes` | + `SET search_path = ''`, qualified `display.devices`, `display.pairings` |
| `display` | `clear_pairing_code` | + `SET search_path = ''`, qualified `display.devices`, `display.pairings` |
| `display` | `generate_pairing_code` | + `SET search_path = ''`, qualified `display.devices`, `display.pairings` |
| `display` | `set_latest_release` (1-arg) | + `SET search_path = ''`, qualified `display.releases` |
| `display` | `set_latest_release` (2-arg) | + `SET search_path = ''`, qualified `display.releases` |
| `display` | `user_can_access_device` (text) | + `SET search_path = ''`, qualified `display.*`, `display.is_admin()` |
| `display` | `user_can_access_device` (uuid) | + `SET search_path = ''`, qualified `display.*`, `display.is_admin()` |
| `public` | `set_latest_release` | + `SET search_path = ''`, qualified `display.set_latest_release()` |
| `public` | `display_check_rate_limit` | + `SET search_path = ''`, qualified `display.check_rate_limit()` |
| `public` | `display_commands_broadcast_trigger` | + `SET search_path = ''`, qualified `realtime.broadcast_changes` |
| `public` | `display_firmware_updates_broadcast_trigger` | + `SET search_path = ''`, qualified `realtime.broadcast_changes` |
| `public` | `display_heartbeats_broadcast_trigger` | + `SET search_path = ''`, qualified `realtime.broadcast_changes` |

**Out of scope:** `auth_leaked_password_protection` — this is a Supabase Auth dashboard setting (enable HaveIBeenPwned password checking), not a SQL function issue. Enable it in the Supabase dashboard under Authentication → Password Security.
