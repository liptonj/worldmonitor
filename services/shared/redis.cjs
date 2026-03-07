'use strict';

const Redis = require('ioredis');
const { createLogger } = require('./logger.cjs');

let _client = null;
let _testClient = null;
const log = createLogger('redis');

function getClient() {
  if (_testClient) return _testClient;
  if (!_client) {
    const url = process.env.REDIS_URL || 'redis://localhost:6379';
    const opts = {};
    if (url.startsWith('rediss://')) {
      opts.tls = { rejectUnauthorized: true };
    }
    _client = new Redis(url, opts);
    _client.on('connect', () => log.info('Redis connected'));
    _client.on('error', (err) => log.error('Redis error', { error: err.message }));
    _client.on('reconnecting', () => log.info('Redis reconnecting'));
  }
  return _client;
}

async function get(key) {
  const client = getClient();
  const raw = await client.get(key);
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    log.warn('Redis get parse error', { key, error: err.message });
    return null;
  }
}

async function setex(key, ttlSeconds, value) {
  const client = getClient();
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  await client.setex(key, ttlSeconds, str);
}

function setClientForTesting(client) {
  _testClient = client;
}

module.exports = { get, setex, getClient, setClientForTesting };
