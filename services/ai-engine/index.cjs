'use strict';

const path = require('path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const { createClient } = require('@supabase/supabase-js');
const { runWorker } = require('@worldmonitor/shared/worker-runner.cjs');
const redis = require('@worldmonitor/shared/redis.cjs');
const { createGatewayClient, broadcast } = require('@worldmonitor/shared/grpc-client.cjs');
const { createLogger } = require('@worldmonitor/shared/logger.cjs');

const log = createLogger('ai-engine');

const GENERATOR_REGISTRY = {
  'ai:intel-digest': require('./generators/intel-digest.cjs'),
  'ai:panel-summary': require('./generators/panel-summary.cjs'),
  'ai:article-summaries': require('./generators/article-summaries.cjs'),
  'ai:classifications': require('./generators/classifications.cjs'),
  'ai:country-briefs': require('./generators/country-briefs.cjs'),
  'ai:posture-analysis': require('./generators/posture-analysis.cjs'),
  'ai:instability-analysis': require('./generators/instability-analysis.cjs'),
  'ai:risk-overview': require('./generators/risk-overview.cjs'),
};

const PROTO_PATH = path.resolve(__dirname, '../proto/relay/v1/worker.proto');
const loaderOpts = { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true };
const packageDef = protoLoader.loadSync(PROTO_PATH, loaderOpts);
const WorkerService = grpc.loadPackageDefinition(packageDef).relay.v1.WorkerService;

function createSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    log.warn('SUPABASE_URL or SUPABASE_SERVICE_KEY not set — Supabase disabled');
    return null;
  }
  return createClient(url, key);
}

function createGrpcBroadcast(host, port) {
  return async function grpcBroadcast(channel, data, triggerId) {
    try {
      const client = createGatewayClient(host, port);
      await broadcast(client, {
        channel,
        payload: Buffer.from(JSON.stringify(data)),
        timestampMs: Date.now(),
        triggerId: triggerId || '',
      });
    } catch (err) {
      log.warn('grpcBroadcast failed', { channel, triggerId, error: err.message });
    }
  };
}

function handleHealthCheck(call, callback) {
  callback(null, { status: 'ok' });
}

function handleExecute(call, callback) {
  const config = require('@worldmonitor/shared/config.cjs');
  const start = Date.now();
  let triggerId = '';
  let serviceKey = '';

  const onComplete = (result) => {
    const durationMs = Date.now() - start;
    log.info('Execute complete', {
      trigger_id: triggerId,
      service_key: serviceKey,
      status: result.status,
      duration_ms: durationMs,
    });
    callback(null, {
      service_key: result.service_key || serviceKey,
      status: result.status,
      duration_ms: durationMs,
      error: result.error || '',
      trigger_id: result.trigger_id || triggerId,
    });
  };

  const onError = (err) => {
    const durationMs = Date.now() - start;
    log.error('Execute handler error', {
      trigger_id: triggerId,
      service_key: serviceKey,
      error: err.message,
      duration_ms: durationMs,
    });
    callback(null, {
      service_key: serviceKey,
      status: 'error',
      duration_ms: durationMs,
      error: err.message,
      trigger_id: triggerId,
    });
  };

  try {
    const req = call.request;
    serviceKey = req.service_key || '';
    triggerId = req.trigger_id || '';

    const generatorFn = GENERATOR_REGISTRY[serviceKey];
    if (!generatorFn) {
      onComplete({
        status: 'error',
        error: `Unknown service_key: ${serviceKey}`,
        service_key: serviceKey,
        trigger_id: triggerId,
      });
      return;
    }

    const triggerRequest = {
      service_key: req.service_key,
      redis_key: req.redis_key,
      ttl_seconds: req.ttl_seconds,
      settings_json: req.settings_json,
      trigger_id: req.trigger_id,
      fetch_type: req.fetch_type || 'custom',
    };

    const supabase = createSupabaseClient();
    const channelFn = async (deps) => {
      const { redis: r, log: l } = deps;
      return generatorFn({ config, redis: r, log: l, supabase });
    };

    const grpcBroadcastFn = createGrpcBroadcast(config.GATEWAY_HOST, config.GATEWAY_GRPC_PORT);

    runWorker(triggerRequest, {
      channelFn,
      redis,
      grpcBroadcast: grpcBroadcastFn,
      log,
    })
      .then(onComplete)
      .catch(onError);
  } catch (err) {
    onError(err);
  }
}

function main() {
  const config = require('@worldmonitor/shared/config.cjs');
  const port = config.AI_ENGINE_GRPC_PORT;

  const server = new grpc.Server();
  server.addService(WorkerService.service, {
    Execute: handleExecute,
    HealthCheck: handleHealthCheck,
  });

  server.bindAsync(
    `0.0.0.0:${port}`,
    grpc.ServerCredentials.createInsecure(),
    (err, boundPort) => {
      if (err) {
        log.error('AI engine gRPC server bind failed', { error: err.message });
        process.exit(1);
      }
      log.info('AI engine gRPC server listening', { port: boundPort });
    }
  );

  const shutdown = () => {
    log.info('AI engine shutting down');
    server.tryShutdown((shutdownErr) => {
      if (shutdownErr) {
        log.warn('AI engine shutdown error', { error: shutdownErr.message });
      }
      process.exit(shutdownErr ? 1 : 0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) {
  main();
}

module.exports = {
  GENERATOR_REGISTRY,
  handleExecute,
  handleHealthCheck,
};
