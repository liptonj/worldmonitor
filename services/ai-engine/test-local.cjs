'use strict';

/**
 * Local smoke test — runs AI engine generators against live Redis + Supabase.
 *
 * Usage:
 *   REDIS_URL=redis://localhost:16379 \
 *   SUPABASE_URL=https://fmultmlsevqgtnqzaylg.supabase.co \
 *   SUPABASE_ANON_KEY=<key> \
 *   SUPABASE_SERVICE_ROLE_KEY=<key> \
 *   node ai-engine/test-local.cjs [generator-name]
 *
 * generator-name: intel-digest | article-summaries | classifications | panel-summary
 *                 country-briefs | posture-analysis | instability-analysis | risk-overview
 *                 (defaults to intel-digest)
 */

const { createClient } = require('@supabase/supabase-js');
const Redis = require('ioredis');
const http = require('@worldmonitor/shared/http.cjs');
const { createLogger } = require('@worldmonitor/shared/logger.cjs');

const log = createLogger('test-local');

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const ioClient = new Redis(redisUrl, { connectTimeout: 10000, maxRetriesPerRequest: 3 });
ioClient.on('connect', () => log.info('Redis connected'));
ioClient.on('error', (err) => log.error('Redis error', { error: err.message }));

const redis = {
  async get(key) {
    const raw = await ioClient.get(key);
    if (raw == null) return null;
    try { return JSON.parse(raw); } catch (_) { return null; }
  },
  async setex(key, ttl, val) {
    const str = typeof val === 'string' ? val : JSON.stringify(val);
    await ioClient.setex(key, ttl, str);
  },
};

const GENERATORS = {
  'intel-digest': require('./generators/intel-digest.cjs'),
  'article-summaries': require('./generators/article-summaries.cjs'),
  'classifications': require('./generators/classifications.cjs'),
  'panel-summary': require('./generators/panel-summary.cjs'),
  'country-briefs': require('./generators/country-briefs.cjs'),
  'posture-analysis': require('./generators/posture-analysis.cjs'),
  'instability-analysis': require('./generators/instability-analysis.cjs'),
  'risk-overview': require('./generators/risk-overview.cjs'),
};

async function main() {
  const name = process.argv[2] || 'intel-digest';
  const gen = GENERATORS[name];
  if (!gen) {
    console.error(`Unknown generator: ${name}`);
    console.error(`Available: ${Object.keys(GENERATORS).join(', ')}`);
    process.exit(1);
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }

  const supabase = createClient(url, key);

  console.log(`\n=== Running generator: ${name} ===\n`);
  const start = Date.now();

  try {
    const result = await gen({ supabase, redis, log, http });
    const elapsed = Date.now() - start;

    console.log(`\nStatus: ${result.status}`);
    console.log(`Elapsed: ${elapsed}ms`);

    if (result.error) {
      console.error(`Error: ${result.error}`);
    }

    if (result.data) {
      const preview = JSON.stringify(result.data, null, 2);
      if (preview.length > 3000) {
        console.log(`Data (first 3000 chars):\n${preview.slice(0, 3000)}...`);
      } else {
        console.log(`Data:\n${preview}`);
      }
    } else {
      console.log('Data: null');
    }
  } catch (err) {
    console.error(`Fatal error: ${err.message}`);
    console.error(err.stack);
  }

  ioClient.disconnect();
  process.exit(0);
}

main();
