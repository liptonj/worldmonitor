'use strict';

function parseRssItems(xml) {
  const items = [];
  const itemRe = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(block)?.[1]?.trim() || '';
    const link = /<link[^>]*>([\s\S]*?)<\/link>/i.exec(block)?.[1]?.trim() || '';
    const pubDate = /<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i.exec(block)?.[1]?.trim() || '';
    const desc = /<description[^>]*>([\s\S]*?)<\/description>/i.exec(block)?.[1]?.trim() || '';
    items.push({ title, link, pubDate, description: desc });
  }
  return items;
}

async function fetchSimple(settings, { log, http }) {
  if (!settings || typeof settings.url !== 'string') {
    return { ok: false, error: 'Invalid settings: url required' };
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(settings.url);
  } catch {
    return { ok: false, error: 'Invalid settings: url is not a valid URL' };
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return { ok: false, error: 'Invalid settings: url must use http or https' };
  }

  const url = settings.url;
  const method = (settings.method || 'GET').toUpperCase();
  const headers = settings.headers && typeof settings.headers === 'object' ? settings.headers : {};
  const responseFormat = settings.response_format || 'json';

  try {
    if (responseFormat === 'json') {
      const opts = { method, headers };
      if (method === 'POST' && settings.body_json != null) {
        opts.headers = { ...opts.headers, 'Content-Type': 'application/json' };
        opts.body = typeof settings.body_json === 'string' ? settings.body_json : JSON.stringify(settings.body_json);
      }
      const data = await http.fetchJson(url, opts);
      return { ok: true, data: Array.isArray(data) ? data : [data] };
    }

    if (responseFormat === 'rss') {
      const text = await http.fetchText(url, { method, headers });
      const items = parseRssItems(text);
      return { ok: true, data: items };
    }

    return { ok: false, error: `Unknown response_format: ${responseFormat}` };
  } catch (err) {
    log.warn('fetchSimple failed', { url, error: err.message });
    return { ok: false, error: err.message };
  }
}

module.exports = { fetchSimple };
