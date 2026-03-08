'use strict';

const path = require('path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const { runWorker } = require('@worldmonitor/shared/worker-runner.cjs');
const { getChannel } = require('@worldmonitor/shared/channels/index.cjs');
const redis = require('@worldmonitor/shared/redis.cjs');
const { createGatewayClient, broadcast } = require('@worldmonitor/shared/grpc-client.cjs');
const { createLogger } = require('@worldmonitor/shared/logger.cjs');

const log = createLogger('worker');

const PROTO_PATH = path.resolve(__dirname, '../proto/relay/v1/worker.proto');
const loaderOpts = { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true };
const packageDef = protoLoader.loadSync(PROTO_PATH, loaderOpts);
const WorkerService = grpc.loadPackageDefinition(packageDef).relay.v1.WorkerService;

function handleHealthCheck(call, callback) {
  callback(null, { status: 'ok' });
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

function handleExecute(call, callback, deps) {
  const {
    runWorker: runWorkerFn = runWorker,
    getChannel: getChannelFn = getChannel,
    redis: redisClient = redis,
    createGrpcBroadcast: createGrpcBroadcastFn = createGrpcBroadcast,
    config = require('@worldmonitor/shared/config.cjs'),
    log: logInstance = log,
  } = deps || {};

  const start = Date.now();
  let triggerId = '';
  let serviceKey = '';

  const onComplete = (result) => {
    const durationMs = Date.now() - start;
    logInstance.info('Execute complete', {
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
    logInstance.error('Execute handler error', {
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

    const triggerRequest = {
      service_key: req.service_key,
      redis_key: req.redis_key,
      ttl_seconds: req.ttl_seconds,
      settings_json: req.settings_json,
      trigger_id: req.trigger_id,
      fetch_type: req.fetch_type || 'custom',
    };

    const channelFn = getChannelFn(req.service_key);
    const grpcBroadcastFn = createGrpcBroadcastFn(config.GATEWAY_HOST, config.GATEWAY_GRPC_PORT);

    runWorkerFn(triggerRequest, {
      channelFn,
      redis: redisClient,
      grpcBroadcast: grpcBroadcastFn,
      log: logInstance,
    })
      .then(onComplete)
      .catch(onError);
  } catch (err) {
    onError(err);
  }
}

function main() {
  const config = require('@worldmonitor/shared/config.cjs');
  const port = config.WORKER_GRPC_PORT;

  const server = new grpc.Server();
  server.addService(WorkerService.service, {
    Execute: (call, callback) => handleExecute(call, callback),
    HealthCheck: handleHealthCheck,
  });

  server.bindAsync(
    `0.0.0.0:${port}`,
    grpc.ServerCredentials.createInsecure(),
    (err, boundPort) => {
      if (err) {
        log.error('Worker gRPC server bind failed', { error: err.message });
        process.exit(1);
      }
      log.info('Worker gRPC server listening', { port: boundPort });
    }
  );

  const shutdown = () => {
    log.info('Worker shutting down');
    server.tryShutdown((shutdownErr) => {
      if (shutdownErr) {
        log.warn('Worker shutdown error', { error: shutdownErr.message });
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

module.exports = { createGrpcBroadcast, handleExecute, handleHealthCheck };
