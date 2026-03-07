'use strict';

// Ingests OSINT messages from Telegram channels
// Maintains persistent session, writes message buffer to Redis, broadcasts via gRPC

const config = require('@worldmonitor/shared/config.cjs');
const { createLogger } = require('@worldmonitor/shared/logger.cjs');
const { setex: redisSetex } = require('@worldmonitor/shared/redis.cjs');
const { createGatewayClient, broadcast } = require('@worldmonitor/shared/grpc-client.cjs');

const log = createLogger('ingest-telegram');
const REDIS_KEY = 'relay:telegram:v1';
const BUFFER_TTL = 3600; // 1 hour
const MAX_BUFFER_SIZE = 500;

// In-memory message buffer (ring buffer, newest first)
const messageBuffer = [];

function _resetBuffer() {
  messageBuffer.length = 0;
}

function addMessage(message) {
  // Prepend (newest first)
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

async function startTelegramClient(gatewayClient) {
  // TODO: Initialize GramJS/telegram client with session string from TELEGRAM_SESSION env var
  // TODO: Connect and start listening to configured channels (TELEGRAM_CHANNELS env var)
  // TODO: On each new message, call addMessage() and persistBuffer()

  const sessionString = process.env.TELEGRAM_SESSION;
  const channelsEnv = process.env.TELEGRAM_CHANNELS;

  if (!sessionString) {
    log.warn('TELEGRAM_SESSION not set — Telegram ingest disabled');
    return;
  }

  if (!channelsEnv) {
    log.warn('TELEGRAM_CHANNELS not set — no channels to monitor');
    return;
  }

  log.info('Telegram client initialized (stub)', { channels: channelsEnv });

  // Periodic persist: every 60 seconds
  const persistInterval = setInterval(async () => {
    try {
      await persistBuffer(gatewayClient);
    } catch (err) {
      log.error('Periodic persist failed', { error: err.message });
    }
  }, 60_000);

  // Return cleanup function
  return () => {
    clearInterval(persistInterval);
  };
  // TODO: replace with actual GramJS client that calls addMessage() on new messages
}

async function main() {
  log.info('Starting ingest-telegram');
  const gatewayClient = createGatewayClient(config.GATEWAY_HOST, config.GATEWAY_GRPC_PORT);

  const cleanup = await startTelegramClient(gatewayClient);

  const shutdown = () => {
    log.info('Shutting down ingest-telegram');
    if (cleanup) cleanup();
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
  addMessage,
  getMessageBuffer,
  persistBuffer,
  startTelegramClient,
  _resetBuffer,
};
