'use strict';

// Extracted from scripts/ais-relay.cjs - News source configuration
// Fetches from Supabase get_public_news_sources RPC for each variant, dedupes by name+url

const NEWS_VARIANTS = ['full', 'tech', 'finance', 'happy'];

function isValidNewsSource(row) {
  return row && typeof row === 'object' && (row.name != null || row.url != null);
}

function dedupeNewsSources(all) {
  const seen = new Set();
  const deduped = [];
  for (const row of all) {
    const key = `${row.name ?? ''}||${typeof row.url === 'string' ? row.url : JSON.stringify(row.url ?? '')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
}

async function fetchNewsSourcesFromSupabase(config, http) {
  if (!config?.SUPABASE_URL || !config?.SUPABASE_ANON_KEY) {
    throw new Error('Supabase client not configured');
  }
  const base = config.SUPABASE_URL.replace(/\/+$/, '');
  const url = `${base}/rest/v1/rpc/get_public_news_sources`;
  const headers = {
    'Content-Type': 'application/json',
    apikey: config.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${config.SUPABASE_ANON_KEY}`,
  };

  const all = [];
  for (const v of NEWS_VARIANTS) {
    const data = await http.fetchJson(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ p_variant: v }),
    });
    if (Array.isArray(data)) all.push(...data);
  }

  const valid = (all ?? []).filter(isValidNewsSource);
  return dedupeNewsSources(valid);
}

module.exports = async function fetchConfigNewsSources({ config, redis, log, http }) {
  log.debug('fetchConfigNewsSources executing');
  const timestamp = new Date().toISOString();

  try {
    const data = await fetchNewsSourcesFromSupabase(config, http);
    return {
      timestamp,
      source: 'config:news-sources',
      data: Array.isArray(data) ? data : [],
      status: 'success',
    };
  } catch (err) {
    log.error('fetchConfigNewsSources error', { error: err?.message ?? err });
    return {
      timestamp,
      source: 'config:news-sources',
      data: [],
      status: 'error',
      errors: [err?.message ?? String(err)],
    };
  }
};
