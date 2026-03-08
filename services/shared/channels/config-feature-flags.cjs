'use strict';

// Extracted from scripts/ais-relay.cjs - Feature flag configuration
// Fetches from Supabase get_public_feature_flags RPC, returns { [key]: value }

function isValidFlagRow(row) {
  return row && typeof row === 'object' && row.key != null;
}

function rowsToFlags(rows) {
  const flags = {};
  for (const row of rows ?? []) {
    if (!isValidFlagRow(row)) continue;
    flags[row.key] = row.value;
  }
  return flags;
}

async function fetchFeatureFlagsFromSupabase(config, http) {
  if (!config?.SUPABASE_URL || !config?.SUPABASE_ANON_KEY) {
    throw new Error('Supabase client not configured');
  }
  const base = config.SUPABASE_URL.replace(/\/+$/, '');
  const url = `${base}/rest/v1/rpc/get_public_feature_flags`;
  const data = await http.fetchJson(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: config.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${config.SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({}),
  });
  return rowsToFlags(Array.isArray(data) ? data : []);
}

module.exports = async function fetchConfigFeatureFlags({ config, redis, log, http }) {
  log.debug('fetchConfigFeatureFlags executing');
  const timestamp = new Date().toISOString();

  try {
    const data = await fetchFeatureFlagsFromSupabase(config, http);
    const flags = data && typeof data === 'object' ? data : {};
    return {
      timestamp,
      source: 'config:feature-flags',
      data: flags,
      status: 'success',
    };
  } catch (err) {
    log.error('fetchConfigFeatureFlags error', { error: err?.message ?? err });
    return {
      timestamp,
      source: 'config:feature-flags',
      data: {},
      status: 'error',
      errors: [err?.message ?? String(err)],
    };
  }
};
