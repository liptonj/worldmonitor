'use strict';

const fs = require('fs');
const path = require('path');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const config = require('@worldmonitor/shared/config.cjs');
const { createLogger } = require('@worldmonitor/shared/logger.cjs');
const { setex: redisSetex } = require('@worldmonitor/shared/redis.cjs');
const { createGatewayClient, broadcast } = require('@worldmonitor/shared/grpc-client.cjs');

const log = createLogger('ingest-telegram');

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`TIMEOUT after ${ms}ms: ${label}`));
    }, ms);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function loadChannelsFromSet(channelSet) {
  const channelsFile = process.env.TELEGRAM_CHANNELS_FILE || '/app/data/telegram-channels.json';
  const set = String(channelSet || 'full').toLowerCase();

  try {
    if (!fs.existsSync(channelsFile)) {
      log.warn('Channels file not found', { path: channelsFile });
      return [];
    }
    const raw = JSON.parse(fs.readFileSync(channelsFile, 'utf8'));
    const bucket = raw?.channels?.[set];
    if (!Array.isArray(bucket)) {
      log.warn('Channel set not found or empty', { set });
      return [];
    }
    const enabled = bucket.filter((c) => c.enabled !== false);
    log.info('Loaded channels from set', { set, count: enabled.length });
    return enabled;
  } catch (err) {
    log.error('Failed to load channels file', { error: err.message });
    return [];
  }
}

const TELEGRAM_MAX_TEXT_CHARS = Math.max(200, Number(process.env.TELEGRAM_MAX_TEXT_CHARS || 800));
const TELEGRAM_MAX_FEED_ITEMS = Math.max(50, Number(process.env.TELEGRAM_MAX_FEED_ITEMS || 200));

const TELEGRAM_POLL_INTERVAL_MS = Math.max(15_000, Number(process.env.TELEGRAM_POLL_INTERVAL_MS || 60_000));
const TELEGRAM_CHANNEL_TIMEOUT_MS = 15_000;
const TELEGRAM_POLL_CYCLE_TIMEOUT_MS = 180_000;
const TELEGRAM_RATE_LIMIT_MS = Math.max(300, Number(process.env.TELEGRAM_RATE_LIMIT_MS || 800));

const REDIS_KEY = 'relay:telegram:v1';
const BUFFER_TTL = 3600;
const MAX_BUFFER_SIZE = 500;
const PERSIST_INTERVAL_MS = 30_000;
const RECONNECT_DELAY_MS = 10_000;
const MAX_RECONNECT_DELAY_MS = 300_000;

const messageBuffer = [];

const pollState = {
  cursorByHandle: Object.create(null),
  items: [],
  lastPollAt: 0,
  lastError: null,
};

function _resetPollState() {
  pollState.cursorByHandle = Object.create(null);
  pollState.items = [];
  pollState.lastPollAt = 0;
  pollState.lastError = null;
}

function createGuardedPoll(pollFn) {
  let inFlight = false;
  let startedAt = 0;

  return async function guardedPoll() {
    if (inFlight) {
      const stuck = Date.now() - startedAt;
      if (stuck > TELEGRAM_POLL_CYCLE_TIMEOUT_MS + 30_000) {
        log.warn('Poll stuck — force-clearing in-flight flag', { stuckMs: stuck });
        inFlight = false;
      } else {
        return;
      }
    }
    inFlight = true;
    startedAt = Date.now();
    try {
      return await pollFn();
    } catch (e) {
      log.warn('Guarded poll error', { error: e?.message || String(e) });
    } finally {
      inFlight = false;
    }
  };
}

function getPollState() {
  return {
    items: [...pollState.items],
    lastPollAt: pollState.lastPollAt,
    lastError: pollState.lastError,
  };
}

function mergeNewItems(newItems) {
  if (!newItems.length) return;
  const seen = new Set();
  pollState.items = [...newItems, ...pollState.items]
    .filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    .sort((a, b) => (b.ts || '').localeCompare(a.ts || ''))
    .slice(0, TELEGRAM_MAX_FEED_ITEMS);
}

async function pollTelegramOnce(client, channels, handleToConfig) {
  const result = { channelsPolled: 0, channelsFailed: 0, newItemCount: 0, mediaSkipped: 0 };
  if (!client || !channels.length) return result;

  const pollStart = Date.now();
  const newItems = [];

  for (const channel of channels) {
    if (Date.now() - pollStart > TELEGRAM_POLL_CYCLE_TIMEOUT_MS) {
      log.warn('Poll cycle timeout', {
        timeoutMs: TELEGRAM_POLL_CYCLE_TIMEOUT_MS,
        polled: result.channelsPolled,
        total: channels.length,
      });
      break;
    }

    const handle = channel.handle;
    const minId = pollState.cursorByHandle[handle] || 0;

    try {
      const entity = await withTimeout(
        client.getEntity(handle),
        TELEGRAM_CHANNEL_TIMEOUT_MS,
        `getEntity(${handle})`
      );
      const rawMsgs = await withTimeout(
        client.getMessages(entity, {
          limit: Math.max(1, Math.min(50, channel.maxMessages || 25)),
          minId,
        }),
        TELEGRAM_CHANNEL_TIMEOUT_MS,
        `getMessages(${handle})`
      );
      const msgs = Array.isArray(rawMsgs) ? rawMsgs : (rawMsgs?.messages || []);

      for (const msg of msgs) {
        if (!msg || !msg.id) continue;
        if (!msg.message) {
          result.mediaSkipped++;
          continue;
        }
        const item = normalizeTelegramMessage(msg, channel);
        newItems.push(item);
        if (!pollState.cursorByHandle[handle] || msg.id > pollState.cursorByHandle[handle]) {
          pollState.cursorByHandle[handle] = msg.id;
        }
      }

      result.channelsPolled++;
      await new Promise((r) => setTimeout(r, TELEGRAM_RATE_LIMIT_MS));
    } catch (e) {
      const em = e?.message || String(e);
      result.channelsFailed++;
      pollState.lastError = `poll ${handle} failed: ${em}`;
      log.warn('Telegram poll error', { handle, error: em });

      if (/AUTH_KEY_DUPLICATED/.test(em)) {
        pollState.lastError = 'session invalidated (AUTH_KEY_DUPLICATED)';
        log.error('Telegram session permanently invalidated', { handle });
        result.permanentlyDisabled = true;
        break;
      }
      if (/FLOOD_WAIT/.test(em)) {
        const wait = parseInt(em.match(/(\d+)/)?.[1] || '60', 10);
        log.warn('Telegram FLOOD_WAIT — stopping poll cycle early', { waitSeconds: wait });
        break;
      }
    }
  }

  if (newItems.length) {
    mergeNewItems(newItems);
  }

  pollState.lastPollAt = Date.now();
  result.newItemCount = newItems.length;

  const elapsed = ((Date.now() - pollStart) / 1000).toFixed(1);
  log.info('Telegram poll complete', {
    channelsPolled: result.channelsPolled,
    totalChannels: channels.length,
    newMessages: result.newItemCount,
    totalItems: pollState.items.length,
    errors: result.channelsFailed,
    mediaSkipped: result.mediaSkipped,
    elapsedSeconds: elapsed,
  });

  return result;
}

function _resetBuffer() {
  messageBuffer.length = 0;
}

function addMessage(message) {
  messageBuffer.unshift(message);
  if (messageBuffer.length > MAX_BUFFER_SIZE) {
    messageBuffer.pop();
  }
}

function getMessageBuffer() {
  return {
    messages: [...messageBuffer],
    count: messageBuffer.length,
    timestamp: new Date().toISOString(),
  };
}

async function persistBuffer(gatewayClient) {
  const data = getMessageBuffer();
  try {
    await redisSetex(REDIS_KEY, BUFFER_TTL, data);
    log.debug('Telegram buffer persisted', { count: data.count });
  } catch (err) {
    log.warn('Failed to persist Telegram buffer', { error: err.message });
  }

  if (gatewayClient && data.count > 0) {
    try {
      await broadcast(gatewayClient, {
        channel: 'telegram',
        payload: Buffer.from(JSON.stringify(data)),
        timestampMs: Date.now(),
        triggerId: 'ingest-telegram',
      });
    } catch (err) {
      log.warn('Failed to broadcast Telegram buffer', { error: err.message });
    }
  }
}

function buildHandleToConfig(channels) {
  const map = new Map();
  for (const ch of channels) {
    map.set(ch.handle.toLowerCase(), ch);
  }
  return map;
}

async function ingestTelegramHeadlines(messages, redisClient) {
  if (!redisClient || redisClient.status !== 'ready' || !messages || messages.length === 0) return;

  const headlines = messages
    .filter((m) => m.text && m.text.trim())
    .map((m) => ({
      title: m.text.trim().slice(0, 500),
      pubDate: m.ts ? Math.floor(new Date(m.ts).getTime() / 1000) : Math.floor(Date.now() / 1000),
      scopes: [...new Set([m.topic || 'global', 'global', 'telegram'])],
    }));

  if (headlines.length === 0) return;

  let ingested = 0;
  for (const h of headlines) {
    const item = JSON.stringify({ title: h.title, pubDate: h.pubDate });
    for (const scope of h.scopes) {
      if (!scope) continue;
      try {
        const key = `wm:headlines:${scope}`;
        await redisClient.lpush(key, item);
        await redisClient.ltrim(key, 0, 99);
        await redisClient.expire(key, 86400);
      } catch { /* swallow per-scope errors */ }
    }
    ingested++;
  }
  if (ingested > 0) log.info('Ingested telegram headlines', { count: ingested });
}

function normalizeTelegramMessage(msg, channel) {
  const handle = channel?.handle || 'unknown';
  const textRaw = String(msg?.message || '');
  const text = textRaw.slice(0, TELEGRAM_MAX_TEXT_CHARS);
  const ts = msg?.date ? new Date(msg.date * 1000).toISOString() : new Date().toISOString();
  return {
    id: `${handle}:${msg.id}`,
    source: 'telegram',
    channel: handle,
    channelTitle: channel?.label || handle,
    url: `https://t.me/${handle}/${msg.id}`,
    ts,
    text,
    topic: channel?.topic || 'other',
    tags: [channel?.region].filter(Boolean),
    earlySignal: true,
  };
}

function formatMessage(event, channelConfig) {
  const msg = event.message;
  const chatId = msg.peerId?.channelId?.toString() || msg.peerId?.chatId?.toString() || '';
  const text = msg.message || '';

  return {
    id: msg.id,
    chatId,
    channel: channelConfig?.handle || '',
    label: channelConfig?.label || channelConfig?.handle || '',
    topic: channelConfig?.topic || 'unknown',
    region: channelConfig?.region || 'unknown',
    tier: channelConfig?.tier || 3,
    text: text.slice(0, 4000),
    date: msg.date ? msg.date * 1000 : Date.now(),
    hasMedia: !!(msg.media),
    views: msg.views || 0,
    forwards: msg.forwards || 0,
    replyTo: msg.replyTo?.replyToMsgId || null,
    ingestedAt: Date.now(),
  };
}

async function resolveChannelEntities(client, handles) {
  const resolved = new Map();
  for (const handle of handles) {
    try {
      const entity = await client.getEntity(handle);
      if (entity) {
        const entityId = entity.id?.toString();
        resolved.set(entityId, handle.toLowerCase());
        log.info('Resolved channel', { handle, entityId });
      }
    } catch (err) {
      log.warn('Failed to resolve channel', { handle, error: err.message });
    }
  }
  return resolved;
}

async function startTelegramClient(gatewayClient) {
  const sessionString = process.env.TELEGRAM_SESSION;
  const apiId = parseInt(process.env.TELEGRAM_API_ID || '0', 10);
  const apiHash = process.env.TELEGRAM_API_HASH || '';
  const channelSet = process.env.TELEGRAM_CHANNEL_SET;
  const channelsEnv = process.env.TELEGRAM_CHANNELS;

  if (!sessionString) {
    log.warn('TELEGRAM_SESSION not set — Telegram ingest disabled');
    return;
  }
  if (!apiId || !apiHash) {
    log.warn('TELEGRAM_API_ID or TELEGRAM_API_HASH not set — Telegram ingest disabled');
    return;
  }

  let channels = [];
  if (channelSet) {
    channels = loadChannelsFromSet(channelSet);
  } else if (channelsEnv) {
    channels = channelsEnv.split(',').map((h) => ({ handle: h.trim(), enabled: true }));
  }

  if (channels.length === 0) {
    log.warn('No channels configured — set TELEGRAM_CHANNEL_SET or TELEGRAM_CHANNELS');
    return;
  }

  const handleToConfig = buildHandleToConfig(channels);
  const handles = channels.map((c) => c.handle);
  log.info('Starting Telegram client', { channelCount: channels.length, handles });

  const normalised = sessionString[0] === '1' ? sessionString : '1' + sessionString;
  const session = new StringSession(normalised);
  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
    retryDelay: 2000,
    autoReconnect: true,
  });

  let entityIdToHandle = new Map();
  let reconnectDelay = RECONNECT_DELAY_MS;
  let connected = false;

  async function connect() {
    try {
      await client.connect();
      connected = true;
      reconnectDelay = RECONNECT_DELAY_MS;
      log.info('Connected to Telegram');

      entityIdToHandle = await resolveChannelEntities(client, handles);
      log.info('Resolved channel entities', { count: entityIdToHandle.size });

      if (entityIdToHandle.size === 0) {
        log.error('No channels could be resolved — check handles');
      }
    } catch (err) {
      connected = false;
      log.error('Failed to connect to Telegram', { error: err.message });
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    log.info('Scheduling reconnect', { delayMs: reconnectDelay });
    setTimeout(async () => {
      try {
        await connect();
      } catch (err) {
        log.error('Reconnect failed', { error: err.message });
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
        scheduleReconnect();
      }
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
  }

  client.addEventHandler(async (event) => {
    try {
      const msg = event.message;
      if (!msg || !msg.message) return;

      const chatId = msg.peerId?.channelId?.toString() || '';
      const handle = entityIdToHandle.get(chatId);
      if (!handle) return;

      const channelConfig = handleToConfig.get(handle);
      const formatted = formatMessage(event, channelConfig);

      addMessage(formatted);
      log.debug('New message', {
        channel: formatted.channel,
        id: formatted.id,
        textLen: formatted.text.length,
        bufferSize: messageBuffer.length,
      });

      await persistBuffer(gatewayClient);
    } catch (err) {
      log.error('Error handling message event', { error: err.message });
    }
  }, new NewMessage({}));

  client._handleUpdate = ((orig) => {
    return function (...args) {
      try {
        return orig.apply(this, args);
      } catch (err) {
        log.error('Update handler error', { error: err.message });
      }
    };
  })(client._handleUpdate);

  await connect();

  const persistInterval = setInterval(async () => {
    try {
      if (connected) {
        await persistBuffer(gatewayClient);
      }
    } catch (err) {
      log.error('Periodic persist failed', { error: err.message });
    }
  }, PERSIST_INTERVAL_MS);

  const statsInterval = setInterval(() => {
    log.info('Telegram stats', {
      connected,
      bufferSize: messageBuffer.length,
      resolvedChannels: entityIdToHandle.size,
      targetChannels: handles.length,
    });
  }, 60_000);

  return () => {
    clearInterval(persistInterval);
    clearInterval(statsInterval);
    try {
      client.disconnect();
    } catch { /* ignore */ }
  };
}

async function main() {
  log.info('Starting ingest-telegram');
  const gatewayClient = createGatewayClient(config.GATEWAY_HOST, config.GATEWAY_GRPC_PORT);

  const cleanup = await startTelegramClient(gatewayClient);

  const shutdown = () => {
    log.info('Shutting down ingest-telegram');
    if (cleanup) cleanup();
    setTimeout(() => process.exit(0), 1000);
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
  addMessage,
  getMessageBuffer,
  persistBuffer,
  startTelegramClient,
  formatMessage,
  normalizeTelegramMessage,
  buildHandleToConfig,
  _resetBuffer,
  withTimeout,
  _resetPollState,
  getPollState,
  mergeNewItems,
  pollTelegramOnce,
  ingestTelegramHeadlines,
  createGuardedPoll,
};
