-- =============================================================
-- Migration: Temporal anomalies channel
--
-- Purpose:
--   Register temporal-anomalies in wm_admin.service_config so
--   the orchestrator runs the channel every 5 minutes. The
--   worker reads item counts from other Redis keys, computes
--   Welford baselines, and pushes anomaly alerts via relay.
-- =============================================================

INSERT INTO wm_admin.service_config (service_key, cron_schedule, enabled, ttl_seconds, redis_key, fetch_type, description)
VALUES (
  'temporal-anomalies',
  '*/5 * * * *',
  true,
  600,
  'relay:temporal-anomalies:v1',
  'custom',
  'Temporal anomaly detection — reads item counts from other channels, computes baselines, pushes anomaly alerts'
)
ON CONFLICT (service_key) DO UPDATE SET
  cron_schedule = EXCLUDED.cron_schedule,
  enabled = EXCLUDED.enabled,
  ttl_seconds = EXCLUDED.ttl_seconds,
  redis_key = EXCLUDED.redis_key,
  fetch_type = EXCLUDED.fetch_type,
  description = EXCLUDED.description;
