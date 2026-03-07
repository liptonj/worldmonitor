-- Manual trigger requests: admin portal inserts rows, orchestrator processes
CREATE TABLE IF NOT EXISTS wm_admin.trigger_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_key     TEXT NOT NULL REFERENCES wm_admin.service_config(service_key),
  requested_by    UUID REFERENCES auth.users(id),
  status          TEXT NOT NULL DEFAULT 'pending',
  result          JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ
);

ALTER TABLE wm_admin.trigger_requests
  ADD CONSTRAINT trigger_requests_status_check
  CHECK (status IN ('pending', 'accepted', 'completed', 'failed'));

CREATE INDEX IF NOT EXISTS idx_trigger_requests_pending
  ON wm_admin.trigger_requests (status, created_at)
  WHERE status = 'pending';

ALTER TABLE wm_admin.trigger_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE wm_admin.trigger_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY admins_all_trigger_requests ON wm_admin.trigger_requests FOR ALL
  USING ((SELECT wm_admin.is_admin()));
