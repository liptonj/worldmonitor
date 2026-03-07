-- RPC for admin portal to query relay service statuses
CREATE OR REPLACE FUNCTION wm_admin.get_relay_service_statuses()
RETURNS TABLE (
  service_key              TEXT,
  enabled                  BOOLEAN,
  cron_schedule            TEXT,
  last_run_at              TIMESTAMPTZ,
  last_status              TEXT,
  last_error               TEXT,
  consecutive_failures     INTEGER,
  max_consecutive_failures INTEGER,
  alert_on_failure         BOOLEAN,
  description              TEXT
)
LANGUAGE SQL
SECURITY DEFINER
SET search_path = wm_admin
AS $$
  SELECT
    service_key,
    enabled,
    cron_schedule,
    last_run_at,
    last_status,
    last_error,
    consecutive_failures,
    max_consecutive_failures,
    alert_on_failure,
    description
  FROM wm_admin.service_config
  ORDER BY service_key;
$$;

-- RPC to manually trigger a service from the admin portal
CREATE OR REPLACE FUNCTION wm_admin.trigger_relay_service(p_service_key TEXT)
RETURNS UUID
LANGUAGE SQL
SECURITY DEFINER
SET search_path = wm_admin
AS $$
  INSERT INTO wm_admin.trigger_requests (service_key, requested_by, status)
  VALUES (p_service_key, auth.uid(), 'pending')
  RETURNING id;
$$;

GRANT EXECUTE ON FUNCTION wm_admin.get_relay_service_statuses() TO authenticated;
GRANT EXECUTE ON FUNCTION wm_admin.trigger_relay_service(TEXT) TO authenticated;
