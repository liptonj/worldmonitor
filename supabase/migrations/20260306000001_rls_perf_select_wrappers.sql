-- Phase 6: RLS and function performance — wrap function calls in (SELECT ...) for per-statement caching
--
-- Per Supabase Postgres best practices, wrapping function calls in (SELECT ...) enables
-- per-statement caching by the planner, avoiding repeated function evaluation for each row.

-- -----------------------------------------------------------------------------
-- TASK 1: admin_users_superadmin_write — wrap is_superadmin() in (SELECT ...)
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS admin_users_superadmin_write ON wm_admin.admin_users;

CREATE POLICY admin_users_superadmin_write ON wm_admin.admin_users
  FOR ALL
  TO authenticated
  USING ((SELECT wm_admin.is_superadmin()))
  WITH CHECK ((SELECT wm_admin.is_superadmin()));

-- -----------------------------------------------------------------------------
-- TASK 2: display.user_can_access_device — wrap auth.uid() in (SELECT ...)
-- -----------------------------------------------------------------------------
-- Wrapping auth.uid() in (SELECT ...) ensures consistent caching pattern even
-- inside SECURITY DEFINER functions.

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
        WHERE ud.user_id = (SELECT auth.uid())
          AND ud.serial_number = target_serial
          AND up.disabled = FALSE
    );
END;
$$;

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
        WHERE ud.user_id = (SELECT auth.uid())
          AND ud.device_uuid = target_device_uuid
          AND up.disabled = FALSE
    );
END;
$$;
