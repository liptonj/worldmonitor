'use strict';

const Redis = require('ioredis');
const { createLogger } = require('./logger.cjs');

let _client = null;
const log = createLogger('redis');

function getClient() {
  if (process.__REDIS_TEST_CLIENT__ != null) {
    return process.__REDIS_TEST_CLIENT__;
  }
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

async function keys(pattern) {
  const client = getClient();
  return client.keys(pattern);
}

async function ttl(key) {
  const client = getClient();
  return client.ttl(key);
}

async function del(key) {
  const client = getClient();
  return client.del(key);
}

async function strlen(key) {
  const client = getClient();
  return client.strlen(key);
}

async function type(key) {
  const client = getClient();
  return client.type(key);
}

module.exports = { get, setex, getClient, keys, ttl, del, strlen, type };
