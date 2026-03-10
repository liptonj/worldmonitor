-- Ensure security-advisories uses the custom channel worker (multi-feed aggregation).
UPDATE wm_admin.service_config
SET
  fetch_type = 'custom',
  settings = '{}'::jsonb,
  description = 'Security advisories aggregated from multiple feeds'
WHERE service_key = 'security-advisories';
