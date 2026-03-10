'use strict';

const path = require('path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

const PROTO_DIR = path.resolve(__dirname, '../proto/relay/v1');
const loaderOpts = { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true };

const workerPackage = protoLoader.loadSync(path.join(PROTO_DIR, 'worker.proto'), loaderOpts);
const gatewayPackage = protoLoader.loadSync(path.join(PROTO_DIR, 'gateway.proto'), loaderOpts);

const WorkerService = grpc.loadPackageDefinition(workerPackage).relay.v1.WorkerService;
const GatewayService = grpc.loadPackageDefinition(gatewayPackage).relay.v1.GatewayService;

const MAX_BROADCAST_BYTES = 3 * 1024 * 1024;

function createGatewayClient(host, port) {
  const addr = `${host}:${port}`;
  return new GatewayService(addr, grpc.credentials.createInsecure(), {
    'grpc.max_receive_message_length': 16 * 1024 * 1024,
    'grpc.max_send_message_length': 16 * 1024 * 1024,
  });
}

function createWorkerClient(host, port) {
  const addr = `${host}:${port}`;
  return new WorkerService(addr, grpc.credentials.createInsecure());
}

function broadcast(client, { channel, payload, timestampMs, triggerId }) {
  return new Promise((resolve, reject) => {
    const req = {
      channel,
      payload: Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload)),
      timestamp_ms: timestampMs ?? Date.now(),
      trigger_id: triggerId || '',
    };
    client.Broadcast(req, (err, res) => {
      if (err) return reject(err);
      resolve(res);
    });
  });
}

function safeBroadcast(client, { channel, payload, timestampMs, triggerId, maxBytes }) {
  const limit = typeof maxBytes === 'number' && maxBytes > 0 ? maxBytes : MAX_BROADCAST_BYTES;
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
  if (buf.length > limit) {
    const msg = `Payload exceeds max broadcast size (${buf.length} > ${limit})`;
    return Promise.resolve({ clients_notified: 0, skipped: true, reason: msg, bytes: buf.length });
  }
  return broadcast(client, { channel, payload: buf, timestampMs, triggerId });
}

function execute(client, { serviceKey, redisKey, ttlSeconds, settingsJson, triggerId, fetchType }) {
  return new Promise((resolve, reject) => {
    const req = {
      service_key: serviceKey,
      redis_key: redisKey || '',
      ttl_seconds: ttlSeconds ?? 600,
      settings_json: settingsJson || '{}',
      trigger_id: triggerId || '',
      fetch_type: fetchType || 'custom',
    };
    client.Execute(req, (err, res) => {
      if (err) return reject(err);
      resolve(res);
    });
  });
}

module.exports = { createGatewayClient, createWorkerClient, broadcast, execute, safeBroadcast };
