'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const protoLoader = require('@grpc/proto-loader');
const grpc = require('@grpc/grpc-js');
const { createLogger } = require('@worldmonitor/shared/logger.cjs');
const { get, getClient, keys: redisKeys, ttl: redisTtl, del: redisDel, strlen: redisStrlen, type: redisType } = require('@worldmonitor/shared/redis.cjs');

const log = createLogger('gateway');

/** Load channel keys from generated JSON (from src/config/channel-registry.ts). */
function loadChannelKeys() {
  const jsonPath = path.join(__dirname, 'channel-keys.json');
  try {
    const raw = fs.readFileSync(jsonPath, 'utf8');
    const data = JSON.parse(raw);
    if (!data.channelKeys || typeof data.channelKeys !== 'object') {
      throw new Error('channel-keys.json missing channelKeys');
    }
    return {
      channelKeys: data.channelKeys,
      mapKeys: data.mapKeys || {},
    };
  } catch (err) {
    log.error('Failed to load channel-keys.json', { path: jsonPath, error: err.message });
    throw new Error(
      'Run "npx tsx scripts/generate-channel-keys.mts" from repo root to generate channel-keys.json'
    );
  }
}

const { channelKeys: PHASE4_CHANNEL_KEYS, mapKeys: PHASE4_MAP_KEYS } = loadChannelKeys();

const CHANNEL_TO_HYDRATION_KEY = Object.fromEntries(
  Object.keys(PHASE4_CHANNEL_KEYS).map((k) => [k, k])
);

const CORS_HEADER = 'Access-Control-Allow-Origin';
const CORS_VALUE = '*';

const GDELT_DOC_API = 'https://api.gdeltproject.org/api/v2/doc/doc';
const GDELT_TIMEOUT_MS = 12_000;
const GDELT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

// Envelope fields added by workers that should be stripped before sending to frontend.
// Keep any payload fields (stocks, commodities, events, etc.)
const ENVELOPE_FIELDS = new Set(['timestamp', 'source', 'status', 'errors']);

/**
 * Unwrap relay envelope: workers store { timestamp, source, status, data, ...payload }.
 * Frontend expects just the payload. For simple envelopes with only `data`, return data.
 * For richer payloads (markets has stocks/commodities), strip envelope fields and return the rest.
 */
function unwrapEnvelope(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return raw;
  }
  // Count how many non-envelope fields exist
  const payloadKeys = Object.keys(raw).filter(k => !ENVELOPE_FIELDS.has(k));
  
  // If only 'data' remains as payload, return just data (simple envelope)
  if (payloadKeys.length === 1 && payloadKeys[0] === 'data') {
    return raw.data;
  }
  
  // Otherwise, strip envelope fields and return the rest (rich payload like markets)
  if (payloadKeys.length > 0) {
    const result = {};
    for (const k of payloadKeys) {
      result[k] = raw[k];
    }
    return result;
  }
  
  // No payload fields found - return as-is
  return raw;
}

function routeHttpRequest(pathname, redis) {
  const headers = { [CORS_HEADER]: CORS_VALUE };
  const jsonHeaders = { ...headers, 'Content-Type': 'application/json' };

  if (pathname === '/health') {
    return {
      status: 200,
      body: JSON.stringify({ status: 'ok', uptime: process.uptime() }),
      headers: jsonHeaders,
    };
  }

  const panelMatch = pathname.match(/^\/panel\/(.+)$/);
  if (panelMatch) {
    const channel = panelMatch[1];
    const redisKey = PHASE4_CHANNEL_KEYS[channel];
    if (!redisKey) {
      return {
        status: 404,
        body: JSON.stringify({ error: 'Not found' }),
        headers: jsonHeaders,
      };
    }
    return (async () => {
      const raw = await redis.get(redisKey);
      if (raw === null || raw === undefined) {
        return {
          status: 200,
          body: JSON.stringify({ status: 'pending' }),
          headers: { ...jsonHeaders, 'Cache-Control': 'no-store' },
        };
      }
      // Workers store data in envelope format: { timestamp, source, data, status, errors, ... }.
      // Frontend expects the payload without envelope metadata.
      // Strip envelope fields but keep everything else (e.g., markets has stocks, commodities, etc.)
      const payload = unwrapEnvelope(raw);
      return {
        status: 200,
        body: JSON.stringify(payload),
        headers: jsonHeaders,
      };
    })();
  }

  if (pathname === '/bootstrap') {
    return (async () => {
      const channels = Object.keys(PHASE4_CHANNEL_KEYS);
      const settled = await Promise.allSettled(
        channels.map((ch) => redis.get(PHASE4_CHANNEL_KEYS[ch]))
      );
      const out = {};
      for (let i = 0; i < channels.length; i++) {
        const hydrationKey = CHANNEL_TO_HYDRATION_KEY[channels[i]] || channels[i];
        const raw = settled[i].status === 'fulfilled' ? (settled[i].value ?? null) : null;
        out[hydrationKey] = unwrapEnvelope(raw);
      }
      return {
        status: 200,
        body: JSON.stringify(out),
        headers: jsonHeaders,
      };
    })();
  }

  const mapMatch = pathname.match(/^\/map\/(.+)$/);
  if (mapMatch) {
    const channel = mapMatch[1];
    const redisKey = PHASE4_MAP_KEYS[channel];
    if (!redisKey) {
      return {
        status: 404,
        body: JSON.stringify({ error: 'Not found' }),
        headers: jsonHeaders,
      };
    }
    return (async () => {
      const raw = await redis.get(redisKey);
      if (raw === null || raw === undefined) {
        return {
          status: 200,
          body: JSON.stringify({ status: 'pending' }),
          headers: { ...jsonHeaders, 'Cache-Control': 'no-store' },
        };
      }
      const payload = unwrapEnvelope(raw);
      return {
        status: 200,
        body: JSON.stringify(payload),
        headers: jsonHeaders,
      };
    })();
  }

  return {
    status: 404,
    body: JSON.stringify({ error: 'Not found' }),
    headers: jsonHeaders,
  };
}

function handleBroadcast(channel, data, subscriptions) {
  const clients = subscriptions.get(channel);
  if (!clients || clients.size === 0) {
    return 0;
  }
  const ts = Math.floor(Date.now() / 1000);
  const unwrapped = unwrapEnvelope(data);
  const msg = JSON.stringify({ type: 'wm-push', channel, data: unwrapped, ts });
  let count = 0;
  for (const ws of clients) {
    try {
      if (ws.readyState === 1) {
        ws.send(msg);
        count++;
      }
    } catch (err) {
      log.debug('WS send error', { channel, error: err.message });
    }
  }
  return count;
}

function main() {
  const PORT = parseInt(process.env.PORT || '3004', 10);
  const GATEWAY_GRPC_PORT = parseInt(process.env.GATEWAY_GRPC_PORT || '50051', 10);

  const clientToChannels = new Map();
  const channelToClients = new Map();

  function subscribe(ws, channels) {
    if (!Array.isArray(channels) || channels.length === 0) return;
    let set = clientToChannels.get(ws);
    if (!set) {
      set = new Set();
      clientToChannels.set(ws, set);
    }
    for (const ch of channels) {
      if (typeof ch !== 'string' || !PHASE4_CHANNEL_KEYS[ch]) continue;
      set.add(ch);
      let clients = channelToClients.get(ch);
      if (!clients) {
        clients = new Set();
        channelToClients.set(ch, clients);
      }
      clients.add(ws);
    }
  }

  function unsubscribe(ws, channels) {
    const set = clientToChannels.get(ws);
    if (!set) return;
    const toRemove = Array.isArray(channels) ? channels : Array.from(set);
    for (const ch of toRemove) {
      set.delete(ch);
      const clients = channelToClients.get(ch);
      if (clients) {
        clients.delete(ws);
        if (clients.size === 0) channelToClients.delete(ch);
      }
    }
    if (set.size === 0) clientToChannels.delete(ws);
  }

  function removeClient(ws) {
    const set = clientToChannels.get(ws);
    if (set) {
      for (const ch of set) {
        const clients = channelToClients.get(ch);
        if (clients) {
          clients.delete(ws);
          if (clients.size === 0) channelToClients.delete(ch);
        }
      }
      clientToChannels.delete(ws);
    }
  }

  const redis = { get };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        [CORS_HEADER]: CORS_VALUE,
        'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      });
      res.end();
      return;
    }

    if (req.method !== 'GET' && req.method !== 'DELETE') {
      res.writeHead(405, { [CORS_HEADER]: CORS_VALUE, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    // --- Admin cache routes (auth required) ---
    if (pathname.startsWith('/admin/')) {
      const adminKey = process.env.ADMIN_API_KEY;
      if (!adminKey) {
        res.writeHead(503, { [CORS_HEADER]: CORS_VALUE, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Admin API not configured' }));
        return;
      }
      const authHeader = req.headers['authorization'] || '';
      const token = authHeader.replace(/^Bearer\s+/i, '');
      if (!token || token !== adminKey) {
        res.writeHead(401, { [CORS_HEADER]: CORS_VALUE, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      const jsonH = { [CORS_HEADER]: CORS_VALUE, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

      try {
        // GET /admin/cache/keys — list all keys with metadata
        if (pathname === '/admin/cache/keys' && req.method === 'GET') {
          const allKeys = await redisKeys('*');
          const entries = await Promise.all(
            allKeys.map(async (k) => {
              const [t, sz, tp] = await Promise.all([redisTtl(k), redisStrlen(k), redisType(k)]);
              return { key: k, ttl: t, size: sz, type: tp };
            })
          );
          entries.sort((a, b) => a.key.localeCompare(b.key));
          res.writeHead(200, jsonH);
          res.end(JSON.stringify({ keys: entries }));
          return;
        }

        // GET /admin/cache/key/:key — get full value
        const getMatch = pathname.match(/^\/admin\/cache\/key\/(.+)$/);
        if (getMatch && req.method === 'GET') {
          const key = decodeURIComponent(getMatch[1]);
          const client = getClient();
          const raw = await client.get(key);
          if (raw === null) {
            res.writeHead(404, jsonH);
            res.end(JSON.stringify({ error: 'Key not found' }));
            return;
          }
          let value;
          try { value = JSON.parse(raw); } catch { value = raw; }
          const t = await redisTtl(key);
          res.writeHead(200, jsonH);
          res.end(JSON.stringify({ key, ttl: t, value }));
          return;
        }

        // DELETE /admin/cache/key/:key — invalidate
        const delMatch = pathname.match(/^\/admin\/cache\/key\/(.+)$/);
        if (delMatch && req.method === 'DELETE') {
          const key = decodeURIComponent(delMatch[1]);
          const deleted = await redisDel(key);
          res.writeHead(200, jsonH);
          res.end(JSON.stringify({ deleted: deleted > 0, key }));
          return;
        }

        res.writeHead(404, jsonH);
        res.end(JSON.stringify({ error: 'Admin route not found' }));
        return;
      } catch (err) {
        log.error('Admin route error', { pathname, error: err.message });
        res.writeHead(500, jsonH);
        res.end(JSON.stringify({ error: 'Internal server error' }));
        return;
      }
    }

    if (pathname === '/gdelt') {
      try {
        const query = url.searchParams.get('query') || 'global security conflict';
        const maxRecords = Math.min(parseInt(url.searchParams.get('max_records') || '10', 10) || 10, 50);
        const timespan = url.searchParams.get('timespan') || '24h';
        const sort = url.searchParams.get('sort') || 'date';

        const gdeltUrl = new URL(GDELT_DOC_API);
        gdeltUrl.searchParams.set('query', query);
        gdeltUrl.searchParams.set('mode', 'artlist');
        gdeltUrl.searchParams.set('maxrecords', String(maxRecords));
        gdeltUrl.searchParams.set('format', 'json');
        gdeltUrl.searchParams.set('sort', sort);
        gdeltUrl.searchParams.set('timespan', timespan);

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), GDELT_TIMEOUT_MS);

        const gdeltResp = await fetch(gdeltUrl.toString(), {
          headers: { 'User-Agent': GDELT_USER_AGENT, Accept: 'application/json' },
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!gdeltResp.ok) {
          res.writeHead(502, { [CORS_HEADER]: CORS_VALUE, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `GDELT API error: ${gdeltResp.status}` }));
          return;
        }

        const raw = await gdeltResp.json();
        const articles = (raw?.articles || []).map((a) => ({
          title: a.title || '',
          url: a.url || '',
          source: a.domain || a.source?.domain || '',
          date: a.seendate || '',
          image: a.socialimage || '',
          language: a.language || '',
          tone: typeof a.tone === 'number' ? a.tone : 0,
        }));

        res.writeHead(200, { [CORS_HEADER]: CORS_VALUE, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ articles, query }));
        return;
      } catch (err) {
        log.error('GDELT proxy error', { error: err.message });
        res.writeHead(502, { [CORS_HEADER]: CORS_VALUE, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'GDELT proxy failed' }));
        return;
      }
    }

    try {
      const result = routeHttpRequest(pathname, redis);
      const resolved = await Promise.resolve(result);
      res.writeHead(resolved.status, resolved.headers);
      res.end(resolved.body);
    } catch (err) {
      log.error('HTTP route error', { pathname, error: err.message });
      res.writeHead(500, { [CORS_HEADER]: CORS_VALUE, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });

  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'wm-subscribe' && Array.isArray(msg.channels)) {
        subscribe(ws, msg.channels);
      } else if (msg.type === 'wm-unsubscribe') {
        unsubscribe(ws, msg.channels);
      }
    });
    ws.on('close', () => removeClient(ws));
    ws.on('error', () => removeClient(ws));
  });

  const protoPath = path.join(__dirname, '../proto/relay/v1/gateway.proto');
  const loaderOpts = { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true };
  const packageDef = grpc.loadPackageDefinition(protoLoader.loadSync(protoPath, loaderOpts));
  const GatewayService = packageDef.relay.v1.GatewayService.service;

  const grpcServer = new grpc.Server();
  grpcServer.addService(GatewayService, {
    Broadcast(call, callback) {
      const { channel, payload } = call.request;
      if (!channel || typeof channel !== 'string') {
        callback(new Error('channel required'));
        return;
      }
      let data;
      try {
        data = payload && payload.length > 0 ? JSON.parse(payload.toString()) : {};
      } catch (err) {
        callback(new Error('invalid payload'));
        return;
      }
      const count = handleBroadcast(channel, data, channelToClients);
      log.debug('Broadcast', { channel, clients_notified: count });
      callback(null, { clients_notified: count });
    },
  });

  grpcServer.bindAsync(
    `0.0.0.0:${GATEWAY_GRPC_PORT}`,
    grpc.ServerCredentials.createInsecure(),
    (err) => {
      if (err) {
        log.error('gRPC bind failed', { error: err.message });
        process.exit(1);
      }
      log.info('gRPC server listening', { port: GATEWAY_GRPC_PORT });
    }
  );

  server.listen(PORT, () => {
    log.info('Gateway listening', { http: PORT, grpc: GATEWAY_GRPC_PORT });
  });

  const shutdown = () => {
    log.info('Shutting down');
    grpcServer.tryShutdown(() => {});
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = {
  handleBroadcast,
  routeHttpRequest,
  unwrapEnvelope,
  PHASE4_CHANNEL_KEYS,
  PHASE4_MAP_KEYS,
};

if (require.main === module) {
  main();
}
