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

const REDIS_KEY = 'relay:telegram:v1';
const BUFFER_TTL = 3600;
const MAX_BUFFER_SIZE = 500;
const PERSIST_INTERVAL_MS = 30_000;
const RECONNECT_DELAY_MS = 10_000;
const MAX_RECONNECT_DELAY_MS = 300_000;

const messageBuffer = [];

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

  const session = new StringSession(sessionString);
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
  buildHandleToConfig,
  _resetBuffer,
};
