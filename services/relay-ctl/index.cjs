#!/usr/bin/env node
'use strict';

const { createClient } = require('@supabase/supabase-js');

const USAGE = `Usage:
  relay-ctl list                     — list all services and their status
  relay-ctl trigger <service_key>   — manually trigger a service
  relay-ctl enable <service_key>     — enable a service
  relay-ctl disable <service_key>    — disable a service
  relay-ctl status <service_key>     — show detailed status of a service
`;

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_KEY are required.');
    console.error('Set them in your environment or .env file.');
    process.exit(1);
  }
  return createClient(url, key);
}

function pad(str, len) {
  const s = String(str ?? '');
  return s.padEnd(len).slice(0, len);
}

async function cmdList(supabase) {
  const { data, error } = await supabase
    .schema('wm_admin')
    .from('service_config')
    .select('service_key, enabled, last_status, last_run_at, consecutive_failures')
    .order('service_key');

  if (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }

  if (!data || data.length === 0) {
    console.log('No services configured.');
    return;
  }

  const rows = data.map((r) => ({
    key: r.service_key,
    enabled: r.enabled ? 'yes' : 'no',
    status: r.last_status ?? '-',
    lastRun: r.last_run_at ? new Date(r.last_run_at).toISOString() : '-',
    failures: String(r.consecutive_failures ?? 0),
  }));

  const maxKey = Math.max(8, ...rows.map((r) => r.key.length));
  const maxStatus = Math.max(6, ...rows.map((r) => (r.status ?? '').length));

  console.log(pad('SERVICE_KEY', maxKey), pad('ENABLED', 7), pad('STATUS', maxStatus), pad('LAST_RUN', 24), 'FAILURES');
  console.log('-'.repeat(maxKey + 7 + maxStatus + 26 + 10));

  for (const r of rows) {
    console.log(pad(r.key, maxKey), pad(r.enabled, 7), pad(r.status, maxStatus), pad(r.lastRun, 24), r.failures);
  }
}

async function cmdTrigger(supabase, serviceKey) {
  const { data, error } = await supabase
    .schema('wm_admin')
    .from('trigger_requests')
    .insert({ service_key: serviceKey, status: 'pending', requested_by: null })
    .select('id')
    .single();

  if (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }

  const id = data.id;
  console.log('Triggered. Request ID:', id);
  console.log('Polling for completion...');

  const maxAttempts = 60;
  const intervalMs = 2000;

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, intervalMs));

    const { data: row, error: fetchErr } = await supabase
      .schema('wm_admin')
      .from('trigger_requests')
      .select('status, result')
      .eq('id', id)
      .single();

    if (fetchErr) {
      console.error('Error polling:', fetchErr.message);
      process.exit(1);
    }

    if (row.status === 'completed') {
      console.log('Completed successfully.');
      if (row.result && row.result.duration_ms) {
        console.log('Duration:', row.result.duration_ms, 'ms');
      }
      return;
    }

    if (row.status === 'failed') {
      console.error('Failed.');
      if (row.result && row.result.error) {
        console.error('Error:', row.result.error);
      }
      process.exit(1);
    }
  }

  console.error('Timeout waiting for completion.');
  process.exit(1);
}

async function cmdEnable(supabase, serviceKey) {
  const { error } = await supabase
    .schema('wm_admin')
    .from('service_config')
    .update({ enabled: true })
    .eq('service_key', serviceKey);

  if (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
  console.log('Enabled:', serviceKey);
}

async function cmdDisable(supabase, serviceKey) {
  const { error } = await supabase
    .schema('wm_admin')
    .from('service_config')
    .update({ enabled: false })
    .eq('service_key', serviceKey);

  if (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
  console.log('Disabled:', serviceKey);
}

async function cmdStatus(supabase, serviceKey) {
  const { data, error } = await supabase
    .schema('wm_admin')
    .from('service_config')
    .select('*')
    .eq('service_key', serviceKey)
    .single();

  if (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }

  if (!data) {
    console.error('Service not found:', serviceKey);
    process.exit(1);
  }

  console.log('service_key:', data.service_key);
  console.log('enabled:', data.enabled);
  console.log('cron_schedule:', data.cron_schedule);
  console.log('redis_key:', data.redis_key);
  console.log('ttl_seconds:', data.ttl_seconds);
  console.log('last_run_at:', data.last_run_at ?? '-');
  console.log('last_status:', data.last_status ?? '-');
  console.log('last_error:', data.last_error ?? '-');
  console.log('last_duration_ms:', data.last_duration_ms ?? '-');
  console.log('consecutive_failures:', data.consecutive_failures ?? 0);
  console.log('max_consecutive_failures:', data.max_consecutive_failures ?? 5);
  console.log('alert_on_failure:', data.alert_on_failure);
  console.log('description:', data.description ?? '-');
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const arg = args[1];

  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(USAGE);
    process.exit(0);
  }

  const supabase = getSupabase();

  switch (cmd) {
    case 'list':
      await cmdList(supabase);
      break;
    case 'trigger':
      if (!arg) {
        console.error('Error: trigger requires <service_key>');
        process.exit(1);
      }
      await cmdTrigger(supabase, arg);
      break;
    case 'enable':
      if (!arg) {
        console.error('Error: enable requires <service_key>');
        process.exit(1);
      }
      await cmdEnable(supabase, arg);
      break;
    case 'disable':
      if (!arg) {
        console.error('Error: disable requires <service_key>');
        process.exit(1);
      }
      await cmdDisable(supabase, arg);
      break;
    case 'status':
      if (!arg) {
        console.error('Error: status requires <service_key>');
        process.exit(1);
      }
      await cmdStatus(supabase, arg);
      break;
    default:
      console.error('Unknown command:', cmd);
      console.log(USAGE);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
