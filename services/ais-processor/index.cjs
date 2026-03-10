'use strict';

// Processes AIS vessel tracking data from aisstream.io WebSocket API
// Maintains in-memory vessel state, writes snapshots to Redis, broadcasts via gRPC

const WebSocket = require('ws');
const config = require('@worldmonitor/shared/config.cjs');
const { createLogger } = require('@worldmonitor/shared/logger.cjs');
const { setex: redisSetex } = require('@worldmonitor/shared/redis.cjs');
const { createGatewayClient, safeBroadcast } = require('@worldmonitor/shared/grpc-client.cjs');

const log = createLogger('ais-processor');
const MAX_VESSELS = 20000;
const REDIS_KEY = 'relay:ais-snapshot:v1';
const SNAPSHOT_TTL = 120; // 2 minutes
const SNAPSHOT_INTERVAL_MS = 10000; // write snapshot every 10s

const CHOKEPOINTS = [
  { name: 'Strait of Hormuz', lat: 26.56, lon: 56.25, radius: 0.5, region: 'IR' },
  { name: 'Suez Canal', lat: 30.46, lon: 32.35, radius: 0.3, region: 'EG' },
  { name: 'Strait of Malacca', lat: 2.5, lon: 101.5, radius: 1.0, region: 'MY' },
  { name: 'Bab el-Mandeb', lat: 12.58, lon: 43.33, radius: 0.3, region: 'YE' },
  { name: 'Panama Canal', lat: 9.08, lon: -79.68, radius: 0.3, region: 'PA' },
  { name: 'Taiwan Strait', lat: 24.5, lon: 119.5, radius: 1.0, region: 'TW' },
  { name: 'South China Sea', lat: 14.5, lon: 114.0, radius: 3.0, region: 'CN' },
  { name: 'Black Sea Straits', lat: 41.0, lon: 29.0, radius: 0.5, region: 'TR' },
];

const GAP_THRESHOLD_MS = 60 * 60 * 1000;
const DENSITY_GRID_SIZE = 2;
const MAX_DENSITY_ZONES = 200;
const vesselHistory = new Map();
const chokepointBuckets = new Map();
const densityGrid = new Map();
const vesselGridCell = new Map(); // Track which grid cell each vessel is in
const vesselChokepoints = new Map(); // Track which chokepoints each vessel is in

// In-memory vessel state: Map<mmsi, { mmsi, lat, lon, heading, speed, timestamp, shipName, ... }>
const vessels = new Map();

function _resetVessels() {
  vessels.clear();
  vesselHistory.clear();
  chokepointBuckets.clear();
  densityGrid.clear();
  vesselGridCell.clear();
  vesselChokepoints.clear();
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

    const mmsiStr = String(mmsi);
    const history = vesselHistory.get(mmsiStr) || [];
    history.push(Date.now());
    if (history.length > 10) history.shift();
    vesselHistory.set(mmsiStr, history);

    if (Number.isFinite(updated.lat) && Number.isFinite(updated.lon)) {
      // Track chokepoints - remove from old, add to new
      const currentChokepoints = new Set();
      for (const cp of CHOKEPOINTS) {
        const dist = Math.sqrt((updated.lat - cp.lat) ** 2 + (updated.lon - cp.lon) ** 2);
        if (dist <= cp.radius) {
          currentChokepoints.add(cp.name);
          if (!chokepointBuckets.has(cp.name)) chokepointBuckets.set(cp.name, new Set());
          chokepointBuckets.get(cp.name).add(mmsiStr);
        }
      }
      // Remove from chokepoints vessel has left
      const prevChokepoints = vesselChokepoints.get(mmsiStr) || new Set();
      for (const cpName of prevChokepoints) {
        if (!currentChokepoints.has(cpName)) {
          chokepointBuckets.get(cpName)?.delete(mmsiStr);
        }
      }
      vesselChokepoints.set(mmsiStr, currentChokepoints);

      // Track density grid - remove from old cell, add to new
      const gLat = Math.floor(updated.lat / DENSITY_GRID_SIZE);
      const gLon = Math.floor(updated.lon / DENSITY_GRID_SIZE);
      const gridKey = `${gLat}_${gLon}`;
      const prevGridKey = vesselGridCell.get(mmsiStr);
      if (prevGridKey && prevGridKey !== gridKey) {
        densityGrid.get(prevGridKey)?.vessels.delete(mmsiStr);
      }
      if (!densityGrid.has(gridKey)) {
        densityGrid.set(gridKey, { lat: gLat * DENSITY_GRID_SIZE + DENSITY_GRID_SIZE / 2, lon: gLon * DENSITY_GRID_SIZE + DENSITY_GRID_SIZE / 2, vessels: new Set(), prevCount: 0 });
      }
      densityGrid.get(gridKey).vessels.add(mmsiStr);
      vesselGridCell.set(mmsiStr, gridKey);
    }

    return updated;
  } catch (err) {
    log.debug('Failed to parse AIS message', { error: err.message });
    return null;
  }
}

function detectDisruptions() {
  const disruptions = [];
  for (const cp of CHOKEPOINTS) {
    const bucket = chokepointBuckets.get(cp.name);
    const vesselCount = bucket ? bucket.size : 0;
    if (vesselCount < 5) continue;
    const normalTraffic = Math.max(cp.radius * 10, 1);
    const changePct = Math.round(((vesselCount - normalTraffic) / normalTraffic) * 100);
    let severity = 'low';
    if (vesselCount > normalTraffic * 1.5) severity = 'high';
    else if (vesselCount > normalTraffic) severity = 'elevated';
    disruptions.push({
      id: `cp-${cp.name.toLowerCase().replace(/\s+/g, '-')}`,
      name: cp.name, type: 'chokepoint_congestion',
      lat: cp.lat, lon: cp.lon, severity, changePct, windowHours: 1,
      vesselCount, region: cp.region,
      description: `${vesselCount} vessels in ${cp.name} (${changePct > 0 ? '+' : ''}${changePct}% vs normal)`,
    });
  }
  let darkShipCount = 0;
  const now = Date.now();
  for (const [, history] of vesselHistory) {
    if (history.length < 2) continue;
    const gap = history[history.length - 1] - history[history.length - 2];
    if (gap > GAP_THRESHOLD_MS && (now - history[history.length - 1]) < 10 * 60 * 1000) {
      darkShipCount++;
    }
  }
  if (darkShipCount >= 1) {
    let severity = 'low';
    if (darkShipCount >= 10) severity = 'high';
    else if (darkShipCount >= 5) severity = 'elevated';
    disruptions.push({
      id: 'gap-spike-global', name: 'AIS Gap Spike', type: 'gap_spike',
      lat: 0, lon: 0, severity, changePct: 0, windowHours: 1,
      darkShips: darkShipCount, region: 'global',
      description: `${darkShipCount} vessels reappeared after extended AIS silence`,
    });
  }
  return disruptions;
}

function calculateDensityZones() {
  const zones = [];
  for (const [, cell] of densityGrid) {
    const vesselCount = cell.vessels.size;
    const deltaPct = cell.prevCount > 0 ? Math.round(((vesselCount - cell.prevCount) / cell.prevCount) * 100) : 0;
    // Persist previous count so next snapshot can compute a real delta.
    cell.prevCount = vesselCount;
    if (vesselCount < 2) continue;
    const intensity = Math.min(1.0, 0.2 + Math.log10(vesselCount) * 0.3);
    zones.push({
      id: `dz-${cell.lat.toFixed(0)}-${cell.lon.toFixed(0)}`,
      name: `Zone ${cell.lat.toFixed(0)}\u00B0, ${cell.lon.toFixed(0)}\u00B0`,
      lat: cell.lat, lon: cell.lon, intensity, deltaPct,
      shipsPerDay: vesselCount * 48,
    });
  }
  zones.sort((a, b) => b.intensity - a.intensity);
  return zones.slice(0, MAX_DENSITY_ZONES);
}

function getSnapshot() {
  let vesselArray = Array.from(vessels.values());
  if (vesselArray.length > MAX_VESSELS) {
    vesselArray = vesselArray
      .sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''))
      .slice(0, MAX_VESSELS);
  }
  const disruptions = detectDisruptions();
  const density = calculateDensityZones();
  return {
    vessels: vesselArray,
    disruptions,
    density,
    count: vesselArray.length,
    totalTracked: vessels.size,
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
      const result = await safeBroadcast(gatewayClient, {
        channel: 'ais',
        payload: Buffer.from(JSON.stringify(snapshot)),
        timestampMs: Date.now(),
        triggerId: 'ais-processor',
      });
      if (result.skipped) {
        log.warn('AIS broadcast skipped — payload too large', {
          vessels: snapshot.count,
          bytes: result.bytes,
        });
      }
    } catch (err) {
      log.warn('Failed to broadcast AIS snapshot', { error: err.message });
    }
  }
}

function connectAisStream(gatewayClient) {
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
