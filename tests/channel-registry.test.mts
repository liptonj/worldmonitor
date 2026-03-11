/**
 * Channel registry structure verification.
 * Ensures CHANNEL_REGISTRY is correctly structured and matches expected channels.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHANNEL_REGISTRY,
  RELAY_CHANNELS,
  REDIS_KEY_MAP,
  type ChannelDefinition,
  type DataDomain,
} from '../src/config/channel-registry.ts';

const VALID_DOMAINS: DataDomain[] = [
  'news',
  'markets',
  'economic',
  'intelligence',
  'geo',
  'military',
  'infrastructure',
  'ai',
  'config',
];

const EXPECTED_CHANNELS = [
  'markets',
  'predictions',
  'fred',
  'oil',
  'bis',
  'flights',
  'weather',
  'natural',
  'eonet',
  'gdacs',
  'gps-interference',
  'cables',
  'cyber',
  'climate',
  'conflict',
  'ucdp-events',
  'telegram',
  'oref',
  'ais',
  'opensky',
  'gdelt',
  'intelligence',
  'trade',
  'supply-chain',
  'giving',
  'spending',
  'gulf-quotes',
  'tech-events',
  'security-advisories',
  'strategic-posture',
  'strategic-risk',
  'stablecoins',
  'etf-flows',
  'macro-signals',
  'service-status',
  'config:news-sources',
  'config:feature-flags',
  'iran-events',
  'ai:intel-digest',
  'ai:panel-summary',
  'ai:article-summaries',
  'ai:classifications',
  'ai:country-briefs',
  'ai:posture-analysis',
  'ai:instability-analysis',
  'ai:risk-overview',
  'ai:telegram-summary',
  'news:full',
  'news:tech',
  'news:finance',
  'news:happy',
  'pizzint',
];

describe('Channel Registry', () => {
  it('has exactly 52 channels', () => {
    assert.equal(
      Object.keys(CHANNEL_REGISTRY).length,
      52,
      'CHANNEL_REGISTRY must have 52 channels'
    );
  });

  it('contains all expected channels', () => {
    const keys = Object.keys(CHANNEL_REGISTRY);
    for (const expected of EXPECTED_CHANNELS) {
      assert.ok(keys.includes(expected), `Missing channel: ${expected}`);
    }
    assert.equal(keys.length, EXPECTED_CHANNELS.length, 'Extra or missing channels');
  });

  it('each entry has required ChannelDefinition fields', () => {
    for (const [key, def] of Object.entries(CHANNEL_REGISTRY)) {
      assert.ok(def.key === key, `${key}: key must match registry key`);
      assert.ok(typeof def.redisKey === 'string' && def.redisKey.length > 0, `${key}: redisKey required`);
      assert.ok(Array.isArray(def.panels), `${key}: panels must be array`);
      assert.ok(VALID_DOMAINS.includes(def.domain), `${key}: invalid domain "${def.domain}"`);
      assert.ok(typeof def.staleAfterMs === 'number' && def.staleAfterMs > 0, `${key}: staleAfterMs must be positive`);
      assert.ok(typeof def.timeoutMs === 'number' && def.timeoutMs > 0, `${key}: timeoutMs must be positive`);
      assert.ok(typeof def.required === 'boolean', `${key}: required must be boolean`);
    }
  });

  it('RELAY_CHANNELS equals Object.keys(CHANNEL_REGISTRY)', () => {
    assert.deepEqual(RELAY_CHANNELS, Object.keys(CHANNEL_REGISTRY));
  });

  it('REDIS_KEY_MAP matches channel -> redisKey', () => {
    for (const [channel, def] of Object.entries(CHANNEL_REGISTRY)) {
      assert.equal(REDIS_KEY_MAP[channel], def.redisKey, `${channel}: REDIS_KEY_MAP mismatch`);
    }
    assert.equal(Object.keys(REDIS_KEY_MAP).length, Object.keys(CHANNEL_REGISTRY).length);
  });

  it('config channels must have required=false', () => {
    for (const [key, def] of Object.entries(CHANNEL_REGISTRY)) {
      if (def.domain === 'config') {
        assert.equal(def.required, false, `${key}: config channels must be required=false`);
      }
    }
  });

  it('at least one data channel has required=true', () => {
    const requiredCount = Object.values(CHANNEL_REGISTRY).filter(
      (def) => def.domain !== 'config' && def.required
    ).length;
    assert.ok(requiredCount >= 1, 'Expected at least one non-config channel with required=true');
  });

  it('staleAfterMs and timeoutMs use reasonable defaults', () => {
    for (const [key, def] of Object.entries(CHANNEL_REGISTRY)) {
      assert.ok(def.staleAfterMs >= 60_000, `${key}: staleAfterMs should be >= 1 min`);
      assert.ok(def.staleAfterMs <= 60 * 60_000, `${key}: staleAfterMs should be <= 60 min`);
      assert.ok(def.timeoutMs >= 5_000, `${key}: timeoutMs should be >= 5s`);
      assert.ok(def.timeoutMs <= 60_000, `${key}: timeoutMs should be <= 60s`);
    }
  });

  it('redisKey follows expected pattern', () => {
    const redisKeyPattern =
      /^[a-z0-9_-]+(?::[a-z0-9_-]+)*:v\d+(?::[a-z0-9_-]+)*$|^relay:config:[a-z-]+$/;
    for (const [key, def] of Object.entries(CHANNEL_REGISTRY)) {
      assert.ok(
        redisKeyPattern.test(def.redisKey),
        `${key}: redisKey "${def.redisKey}" does not match expected pattern`
      );
    }
  });
});
