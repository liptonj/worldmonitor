'use strict';

const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const config = require('@worldmonitor/shared/config.cjs');
const { createLogger } = require('@worldmonitor/shared/logger.cjs');
const { createWorkerClient, execute } = require('@worldmonitor/shared/grpc-client.cjs');

const log = createLogger('orchestrator');

const SERVICE_NAME = 'orchestrator';

// --- Exported for tests ---

function shouldRouteToAiEngine(serviceKey) {
  return typeof serviceKey === 'string' && serviceKey.startsWith('ai:');
}

function buildTriggerRequest(serviceConfig) {
  return {
    serviceKey: serviceConfig.service_key,
    redisKey: serviceConfig.redis_key || '',
    ttlSeconds: serviceConfig.ttl_seconds ?? 600,
    settingsJson: JSON.stringify(serviceConfig.settings || {}),
    triggerId: '',
    fetchType: serviceConfig.fetch_type || 'custom',
  };
}

async function updateServiceStatus(supabase, serviceKey, result) {
  const { error } = await supabase
    .schema('wm_admin')
    .from('service_config')
    .update({
      last_run_at: new Date().toISOString(),
      last_duration_ms: result.duration_ms ?? null,
      last_status: result.status ?? null,
      last_error: result.error || null,
      consecutive_failures: result.status === 'ok' ? 0 : (result.consecutive_failures ?? 0),
    })
    .eq('service_key', serviceKey);

  if (error) {
    log.error('Failed to update service_config', { serviceKey, error: error.message });
  }
}

// --- Internal ---

function getSupabaseClient() {
  const url = process.env.SUPABASE_URL || config.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !serviceKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required for orchestrator');
  }
  return createClient(url, serviceKey);
}

function getWorkerClient() {
  const host = config.WORKER_HOST;
  const port = config.WORKER_GRPC_PORT;
  return createWorkerClient(host, port);
}

function getAiEngineClient() {
  const host = config.AI_ENGINE_HOST;
  const port = config.AI_ENGINE_GRPC_PORT;
  return createWorkerClient(host, port);
}

async function triggerService(supabase, serviceConfig, workerClient, aiEngineClient, triggerRequestId = null, executeFn = execute) {
  const client = shouldRouteToAiEngine(serviceConfig.service_key) ? aiEngineClient : workerClient;
  const req = buildTriggerRequest(serviceConfig);

  const start = Date.now();
  let result;
  try {
    const res = await executeFn(client, req);
    result = {
      status: res.status || 'ok',
      duration_ms: res.duration_ms ?? Math.round(Date.now() - start),
      error: res.error || null,
      consecutive_failures: res.status === 'ok' ? 0 : (serviceConfig.consecutive_failures ?? 0) + 1,
    };
  } catch (err) {
    const duration = Math.round(Date.now() - start);
    const failures = (serviceConfig.consecutive_failures ?? 0) + 1;
    result = {
      status: 'error',
      duration_ms: duration,
      error: err.message || String(err),
      consecutive_failures: failures,
    };
    log.warn('gRPC Execute failed', {
      service_key: serviceConfig.service_key,
      error: result.error,
      consecutive_failures: failures,
    });
    if (
      failures >= (serviceConfig.max_consecutive_failures ?? 5) &&
      (serviceConfig.alert_on_failure !== false)
    ) {
      log.error('Service exceeded max consecutive failures', {
        service_key: serviceConfig.service_key,
        consecutive_failures: failures,
        max: serviceConfig.max_consecutive_failures,
      });
    }
  }

  await updateServiceStatus(supabase, serviceConfig.service_key, result);

  if (triggerRequestId) {
    const { error } = await supabase
      .schema('wm_admin')
      .from('trigger_requests')
      .update({
        status: result.status === 'ok' ? 'completed' : 'failed',
        result: result,
        completed_at: new Date().toISOString(),
      })
      .eq('id', triggerRequestId);

    if (error) {
      log.error('Failed to update trigger_requests', { id: triggerRequestId, error: error.message });
    }
  }

  return result;
}

async function loadServiceConfigs(supabase) {
  const { data, error } = await supabase
    .schema('wm_admin')
    .from('service_config')
    .select('*')
    .eq('enabled', true);

  if (error) {
    log.error('Failed to load service_config', { error: error.message });
    return [];
  }
  return data || [];
}

function scheduleCronJobs(supabase, workerClient, aiEngineClient, jobsRef) {
  jobsRef.current.forEach((j) => j.stop());
  jobsRef.current = [];

  return loadServiceConfigs(supabase).then((configs) => {
    for (const cfg of configs) {
      try {
        const job = cron.schedule(cfg.cron_schedule, async () => {
          try {
            await triggerService(supabase, cfg, workerClient, aiEngineClient);
          } catch (err) {
            log.error('Cron job error', { service_key: cfg.service_key, error: err.message });
          }
        });
        jobsRef.current.push(job);
      } catch (err) {
        log.warn('Invalid cron_schedule', { service_key: cfg.service_key, schedule: cfg.cron_schedule, error: err.message });
      }
    }
    log.info('Scheduled cron jobs', { count: jobsRef.current.length });
    return jobsRef.current.length;
  }).catch((err) => {
    log.error('Failed to load configs for cron', { error: err.message });
    throw err;
  });
}

function subscribeRealtime(supabase, workerClient, aiEngineClient) {
  const channel = supabase
    .channel('orchestrator-realtime')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'wm_admin', table: 'trigger_requests' },
      async (payload) => {
        const row = payload.new;
        if (row.status !== 'pending') return;

        const { data: configRow } = await supabase
          .schema('wm_admin')
          .from('service_config')
          .select('*')
          .eq('service_key', row.service_key)
          .single();

        if (!configRow) {
          log.warn('trigger_requests: unknown service_key', { service_key: row.service_key, id: row.id });
          await supabase
            .schema('wm_admin')
            .from('trigger_requests')
            .update({ status: 'failed', result: { error: 'Unknown service_key' }, completed_at: new Date().toISOString() })
            .eq('id', row.id);
          return;
        }

        try {
          await triggerService(supabase, configRow, workerClient, aiEngineClient, row.id);
        } catch (err) {
          log.error('Manual trigger failed', { id: row.id, service_key: row.service_key, error: err.message });
          await supabase
            .schema('wm_admin')
            .from('trigger_requests')
            .update({ status: 'failed', result: { error: err.message }, completed_at: new Date().toISOString() })
            .eq('id', row.id);
        }
      }
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'wm_admin', table: 'service_config' },
      () => {
        log.debug('service_config changed, reloading cron');
        scheduleCronJobs(supabase, workerClient, aiEngineClient, jobsRef);
      }
    )
    .subscribe((status) => {
      log.info('Realtime subscription status', { status });
    });

  return channel;
}

let jobsRef = { current: [] };

async function main() {
  log.info('Starting', { service: SERVICE_NAME });

  const supabase = getSupabaseClient();
  const workerClient = getWorkerClient();
  const aiEngineClient = getAiEngineClient();

  scheduleCronJobs(supabase, workerClient, aiEngineClient, jobsRef);
  const channel = subscribeRealtime(supabase, workerClient, aiEngineClient);

  const shutdown = () => {
    log.info('Shutting down');
    jobsRef.current.forEach((j) => j.stop());
    jobsRef.current = [];
    if (channel && channel.unsubscribe) channel.unsubscribe();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    log.error('Fatal', { error: err.message });
    process.exit(1);
  });
}

module.exports = {
  buildTriggerRequest,
  shouldRouteToAiEngine,
  updateServiceStatus,
  triggerService,
  scheduleCronJobs,
};
