'use strict';

// Extracted from scripts/ais-relay.cjs - YouTube live stream monitoring
// Checks configured channels for live status. Config: YOUTUBE_CHANNELS (array of handles e.g. @bloomberg)

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const TIMEOUT_MS = 12_000;

function parseLiveStatus(html, channelHandle) {
  const channelExists = html.includes('"channelId"') || html.includes('og:url');
  let channelName = null;
  const ownerMatch = html.match(/"ownerChannelName"\s*:\s*"([^"]+)"/);
  if (ownerMatch) channelName = ownerMatch[1];
  else {
    const am = html.match(/"author"\s*:\s*"([^"]+)"/);
    if (am) channelName = am[1];
  }

  let videoId = null;
  const detailsIdx = html.indexOf('"videoDetails"');
  if (detailsIdx !== -1) {
    const block = html.substring(detailsIdx, detailsIdx + 5000);
    const vidMatch = block.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
    const liveMatch = block.match(/"isLive"\s*:\s*true/);
    if (vidMatch && liveMatch) videoId = vidMatch[1];
  }

  let hlsUrl = null;
  const hlsMatch = html.match(/"hlsManifestUrl"\s*:\s*"([^"]+)"/);
  if (hlsMatch && videoId) hlsUrl = hlsMatch[1].replace(/\\u0026/g, '&');

  return {
    channelHandle,
    videoId,
    isLive: videoId !== null,
    channelExists,
    channelName,
    hlsUrl: hlsUrl || undefined,
  };
}

module.exports = async function fetchYoutubeLive({ config, redis, log, http }) {
  log.debug('fetchYoutubeLive executing');
  const timestamp = new Date().toISOString();

  const channels = config?.YOUTUBE_CHANNELS;
  if (!Array.isArray(channels) || channels.length === 0) {
    return {
      timestamp,
      source: 'youtube-live',
      data: [],
      status: 'success',
    };
  }

  try {
    const results = [];
    for (const ch of channels) {
      const handle = (ch && String(ch).trim()) || '';
      if (!handle) continue;
      const channelHandle = handle.startsWith('@') ? handle : `@${handle}`;
      const liveUrl = `https://www.youtube.com/${channelHandle}/live`;

      try {
        const html = await http.fetchText(liveUrl, {
          headers: { 'User-Agent': USER_AGENT },
          timeout: TIMEOUT_MS,
        });
        const status = parseLiveStatus(html, channelHandle);
        results.push(status);
      } catch (err) {
        log.warn('fetchYoutubeLive channel fetch failed', { channel: channelHandle, error: err?.message ?? err });
        results.push({
          channelHandle,
          videoId: null,
          isLive: false,
          channelExists: false,
          channelName: null,
          error: err?.message ?? String(err),
        });
      }
    }

    const data = Array.isArray(results) ? results : [];
    return {
      timestamp,
      source: 'youtube-live',
      data,
      status: 'success',
    };
  } catch (err) {
    log.error('fetchYoutubeLive error', { error: err?.message ?? err });
    return {
      timestamp,
      source: 'youtube-live',
      data: [],
      status: 'error',
      errors: [err?.message ?? String(err)],
    };
  }
};
