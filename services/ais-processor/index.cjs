'use strict';

// Processes AIS vessel tracking data from aisstream.io WebSocket API
// Maintains in-memory vessel state, writes snapshots to Redis, broadcasts via gRPC

const config = require('@worldmonitor/shared/config.cjs');
const { createLogger } = require('@worldmonitor/shared/logger.cjs');
const { setex: redisSetex } = require('@worldmonitor/shared/redis.cjs');
const { createGatewayClient, broadcast } = require('@worldmonitor/shared/grpc-client.cjs');

const log = createLogger('ais-processor');
const REDIS_KEY = 'relay:ais-snapshot:v1';
const SNAPSHOT_TTL = 120; // 2 minutes
const SNAPSHOT_INTERVAL_MS = 10000; // write snapshot every 10s

// In-memory vessel state: Map<mmsi, { mmsi, lat, lon, heading, speed, timestamp, shipName, ... }>
const vessels = new Map();

function _resetVessels() {
  vessels.clear();
}

function processAisMessage(message) {
  // TODO: parse aisstream.io message format
  // Message types: PositionReport, ShipStaticData, etc.
  // Extract MMSI, lat, lon, heading, speed, ship name
  // Update vessels Map
  try {
    const msg = typeof message === 'string' ? JSON.parse(message) : message;
    const mmsi = msg.MetaData?.MMSI || msg.mmsi;
    if (!mmsi) return null;

    const existing = vessels.get(String(mmsi)) || {};
    const updated = {
      ...existing,
      mmsi: String(mmsi),
      lat: msg.MetaData?.latitude ?? existing.lat,
      lon: msg.MetaData?.longitude ?? existing.lon,
      timestamp: msg.MetaData?.time_utc ?? new Date().toISOString(),
      ship_name: msg.MetaData?.ShipName ?? existing.ship_name,
    };
    vessels.set(String(mmsi), updated);
    return updated;
  } catch (err) {
    log.debug('Failed to parse AIS message', { error: err.message });
    return null;
  }
}

function getSnapshot() {
  return {
    vessels: Array.from(vessels.values()),
    count: vessels.size,
    timestamp: new Date().toISOString(),
  };
}

async function writeSnapshot(gatewayClient) {
  const snapshot = getSnapshot();
  try {
    await redisSetex(REDIS_KEY, SNAPSHOT_TTL, snapshot);
    log.debug('AIS snapshot written to Redis', { count: snapshot.count });
  } catch (err) {
    log.warn('Failed to write AIS snapshot to Redis', { error: err.message });
  }

  if (gatewayClient && snapshot.count > 0) {
    try {
      await broadcast(gatewayClient, {
        channel: 'ais',
        payload: Buffer.from(JSON.stringify(snapshot)),
        timestampMs: Date.now(),
        triggerId: 'ais-processor',
      });
    } catch (err) {
      log.warn('Failed to broadcast AIS snapshot', { error: err.message });
    }
  }
}

function connectAisStream(gatewayClient) {
  const WebSocket = require('ws');
  const apiKey = process.env.AISSTREAM_API_KEY;

  if (!apiKey) {
    log.warn('AISSTREAM_API_KEY not set — AIS stream disabled');
    return null;
  }

  // TODO: replace with actual aisstream.io WS URL
  const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');

  ws.on('open', () => {
    log.info('Connected to aisstream.io');
    // TODO: send subscription message with API key and bounding boxes
    try {
      ws.send(
        JSON.stringify({
          APIKey: apiKey,
          BoundingBoxes: [[[-90, -180], [90, 180]]], // global
          FilterMessageTypes: ['PositionReport'],
        })
      );
    } catch (err) {
      log.warn('AIS stream send error on open', { error: err.message });
    }
  });

  ws.on('message', (data) => {
    processAisMessage(data.toString());
  });

  ws.on('error', (err) => {
    log.warn('AIS stream WebSocket error', { error: err.message });
  });

  ws.on('close', (code, reason) => {
    log.warn('AIS stream WebSocket closed, reconnecting in 30s', {
      code,
      reason: reason?.toString(),
    });
    setTimeout(() => connectAisStream(gatewayClient), 30000);
  });

  return ws;
}

async function main() {
  log.info('Starting ais-processor');
  const gatewayClient = createGatewayClient(config.GATEWAY_HOST, config.GATEWAY_GRPC_PORT);

  const ws = connectAisStream(gatewayClient);

  const snapshotInterval = setInterval(() => {
    writeSnapshot(gatewayClient).catch((err) =>
      log.error('Snapshot error', { error: err.message })
    );
  }, SNAPSHOT_INTERVAL_MS);

  const shutdown = () => {
    log.info('Shutting down ais-processor');
    clearInterval(snapshotInterval);
    if (ws) ws.close();
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

module.exports = { processAisMessage, getSnapshot, writeSnapshot, _resetVessels };
