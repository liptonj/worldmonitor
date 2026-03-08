'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fetchYoutubeLive = require('../youtube-live.cjs');

const mockRedis = { get: async () => null, setex: async () => {} };
const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

test('fetchYoutubeLive returns empty data when no channels configured', async () => {
  const mockHttp = { fetchText: async () => '' };

  const result = await fetchYoutubeLive({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'youtube-live');
  assert.ok(result.timestamp);
  assert.ok(Array.isArray(result.data));
  assert.strictEqual(result.data.length, 0);
});

test('fetchYoutubeLive returns worker-compatible format on success', async () => {
  const htmlWithLive = `
    "channelId":"UCtest123"
    "ownerChannelName":"Test News"
    "videoDetails":{"videoId":"abc123xyz45","isLive":true}
    "hlsManifestUrl":"https://manifest.googlevideo.com/..."
  `;
  const mockHttp = {
    fetchText: async () => htmlWithLive,
  };

  const result = await fetchYoutubeLive({
    config: { YOUTUBE_CHANNELS: ['@testchannel'] },
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.ok(Array.isArray(result.data));
  assert.strictEqual(result.data.length, 1);
  assert.strictEqual(result.data[0].channelHandle, '@testchannel');
  assert.strictEqual(result.data[0].videoId, 'abc123xyz45');
  assert.strictEqual(result.data[0].isLive, true);
  assert.strictEqual(result.data[0].channelName, 'Test News');
});

test('fetchYoutubeLive handles fetch error for channel', async () => {
  const mockHttp = {
    fetchText: async () => {
      throw new Error('YouTube HTTP 403');
    },
  };

  const result = await fetchYoutubeLive({
    config: { YOUTUBE_CHANNELS: ['@blocked'] },
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.ok(Array.isArray(result.data));
  assert.strictEqual(result.data.length, 1);
  assert.strictEqual(result.data[0].channelHandle, '@blocked');
  assert.strictEqual(result.data[0].isLive, false);
  assert.ok(result.data[0].error);
});

test('fetchYoutubeLive normalizes handle without @ prefix', async () => {
  const mockHttp = {
    fetchText: async () => '"channelId":"x"',
  };

  const result = await fetchYoutubeLive({
    config: { YOUTUBE_CHANNELS: ['bloomberg'] },
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.data[0].channelHandle, '@bloomberg');
});
