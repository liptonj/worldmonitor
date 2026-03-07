'use strict';

const config = require('./config.cjs');
const http = require('./http.cjs');
const { fetchSimple } = require('./channels/_simple-fetcher.cjs');

async function runWorker(triggerRequest, { channelFn, redis, grpcBroadcast, log }) {
  const { service_key, redis_key, ttl_seconds, settings_json, trigger_id, fetch_type } = triggerRequest || {};
  const start = Date.now();

  if (!service_key || !redis_key || !fetch_type) {
    const err = 'Missing required fields: service_key, redis_key, fetch_type';
    log.warn('runWorker invalid request', { trigger_id, error: err });
    return { status: 'error', error: err, duration_ms: Date.now() - start, service_key: service_key || '', trigger_id: trigger_id || '' };
  }

  log.info('runWorker start', { trigger_id, service_key, fetch_type });

  let settings = null;
  if (settings_json) {
    try {
      settings = JSON.parse(settings_json);
    } catch (err) {
      log.warn('runWorker invalid settings_json', { trigger_id, error: err.message });
      return { status: 'error', error: `Invalid settings_json: ${err.message}`, duration_ms: Date.now() - start, service_key, trigger_id };
    }
  }

  try {
    let result;

    if (fetch_type === 'simple_http' || fetch_type === 'simple_rss') {
      const format = fetch_type === 'simple_rss' ? 'rss' : 'json';
      const merged = settings ? { ...settings, response_format: settings.response_format || format } : { response_format: format };
      const out = await fetchSimple(merged, { log, http });
      if (!out.ok) {
        return { status: 'error', error: out.error, duration_ms: Date.now() - start, service_key, trigger_id };
      }
      result = out.data;
    } else if (fetch_type === 'custom') {
      if (typeof channelFn !== 'function') {
        return { status: 'error', error: 'channelFn required for custom fetch_type', duration_ms: Date.now() - start, service_key, trigger_id };
      }
      result = await channelFn({ config, redis, log, http });
    } else {
      return { status: 'error', error: `Unknown fetch_type: ${fetch_type}`, duration_ms: Date.now() - start, service_key, trigger_id };
    }

    const ttl = typeof ttl_seconds === 'number' && ttl_seconds > 0 ? ttl_seconds : 300;
    await redis.setex(redis_key, ttl, result);

    if (typeof grpcBroadcast === 'function') {
      await grpcBroadcast(service_key, result, trigger_id);
    }

    const duration_ms = Date.now() - start;
    log.info('runWorker success', { trigger_id, service_key, duration_ms });
    return { status: 'ok', duration_ms, service_key, trigger_id };
  } catch (err) {
    const duration_ms = Date.now() - start;
    log.error('runWorker error', { trigger_id, service_key, error: err.message });
    return { status: 'error', error: err.message, duration_ms, service_key, trigger_id };
  }
}

module.exports = { runWorker };
