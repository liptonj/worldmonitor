'use strict';

/**
 * Parse Redis news value and flatten to array of items.
 * Supports: envelope unwrap, categories shape, data/items/root array fallbacks.
 */

const ENVELOPE_FIELDS = new Set(['timestamp', 'source', 'status', 'errors']);

function unwrapEnvelope(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const payloadKeys = Object.keys(raw).filter((k) => !ENVELOPE_FIELDS.has(k));
  if (payloadKeys.length === 1 && payloadKeys[0] === 'data') return raw.data;
  if (payloadKeys.length > 0) {
    const result = {};
    for (const k of payloadKeys) result[k] = raw[k];
    return result;
  }
  return raw;
}

/**
 * Parse Redis value (string or object), unwrap envelope, flatten digest shape.
 * Returns array of news items.
 * - If categories exists: flatten all category.items into newsItems
 * - Else: support array in data, items, or root array
 */
function parseNewsFromRedis(raw) {
  if (raw == null) return [];
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!obj || typeof obj !== 'object') return [];
  const unwrapped = unwrapEnvelope(obj);
  if (!unwrapped || typeof unwrapped !== 'object') return [];
  if (Array.isArray(unwrapped)) return unwrapped;
  if (unwrapped.categories && typeof unwrapped.categories === 'object') {
    const items = [];
    for (const cat of Object.values(unwrapped.categories)) {
      const arr = cat?.items ?? cat;
      if (Array.isArray(arr)) items.push(...arr);
    }
    return items;
  }
  const arr = unwrapped.data ?? unwrapped.items ?? (Array.isArray(unwrapped) ? unwrapped : []);
  return Array.isArray(arr) ? arr : [];
}

module.exports = { parseNewsFromRedis, unwrapEnvelope };
