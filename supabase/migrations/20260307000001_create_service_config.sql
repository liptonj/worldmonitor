-- Relay orchestrator: per-channel service configuration
-- Used by orchestrator for cron scheduling and gRPC Execute params
CREATE TABLE IF NOT EXISTS wm_admin.service_config (
  service_key              TEXT PRIMARY KEY,
  enabled                  BOOLEAN NOT NULL DEFAULT true,
  cron_schedule            TEXT NOT NULL,
  timeout_ms               INTEGER NOT NULL DEFAULT 30000,
  redis_key                TEXT NOT NULL,
  ttl_seconds              INTEGER NOT NULL DEFAULT 600,
  fetch_type                TEXT NOT NULL DEFAULT 'custom',
  settings                 JSONB NOT NULL DEFAULT '{}',
  last_run_at              TIMESTAMPTZ,
  last_duration_ms         INTEGER,
  last_status              TEXT,
  last_error               TEXT,
  consecutive_failures     INTEGER NOT NULL DEFAULT 0,
  max_consecutive_failures  INTEGER NOT NULL DEFAULT 5,
  alert_on_failure         BOOLEAN NOT NULL DEFAULT true,
  description              TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS service_config_updated_at ON wm_admin.service_config;
CREATE TRIGGER service_config_updated_at
  BEFORE UPDATE ON wm_admin.service_config
  FOR EACH ROW EXECUTE FUNCTION wm_admin.set_updated_at();

CREATE INDEX IF NOT EXISTS idx_service_config_enabled
  ON wm_admin.service_config (enabled) WHERE enabled = true;

DO $$ BEGIN
  ALTER TABLE wm_admin.service_config
    ADD CONSTRAINT service_config_fetch_type_check
    CHECK (fetch_type IN ('custom', 'simple_http', 'simple_rss'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE wm_admin.service_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE wm_admin.service_config FORCE ROW LEVEL SECURITY;
CREATE POLICY admins_all_service_config ON wm_admin.service_config FOR ALL
  USING ((SELECT wm_admin.is_admin()));
