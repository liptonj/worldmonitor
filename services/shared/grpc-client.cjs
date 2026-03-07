'use strict';

const path = require('path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

const PROTO_DIR = path.resolve(__dirname, '../../proto/relay/v1');
const loaderOpts = { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true };

const workerPackage = protoLoader.loadSync(path.join(PROTO_DIR, 'worker.proto'), loaderOpts);
const gatewayPackage = protoLoader.loadSync(path.join(PROTO_DIR, 'gateway.proto'), loaderOpts);

const WorkerService = grpc.loadPackageDefinition(workerPackage).relay.v1.WorkerService;
const GatewayService = grpc.loadPackageDefinition(gatewayPackage).relay.v1.GatewayService;

function createGatewayClient(host, port) {
  const addr = `${host}:${port}`;
  return new GatewayService(addr, grpc.credentials.createInsecure());
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

module.exports = { createGatewayClient, createWorkerClient, broadcast };
