-- Enable REPLICA IDENTITY FULL on service_config so that Supabase Realtime
-- delivers the complete old row on UPDATE events.  The orchestrator uses
-- this to distinguish status-only writes (last_run_at, last_status, …) from
-- actual scheduling-relevant changes (cron_schedule, enabled, settings, …)
-- and skip unnecessary cron-job reloads.

ALTER TABLE wm_admin.service_config REPLICA IDENTITY FULL;
