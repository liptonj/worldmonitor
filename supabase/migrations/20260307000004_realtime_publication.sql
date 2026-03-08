-- Add wm_admin tables to Realtime publication for orchestrator subscriptions
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'wm_admin' AND tablename = 'service_config') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE wm_admin.service_config;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'wm_admin' AND tablename = 'trigger_requests') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE wm_admin.trigger_requests;
  END IF;
END $$;
