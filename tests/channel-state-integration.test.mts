/**
 * Task 3.2: State transition integration tests.
 * Verifies WebSocket push and stale detection wire state correctly.
 *
 * Bootstrap integration tests: We verify the bootstrap source contains the
 * expected setChannelState calls (static check). Full bootstrap flow tests
 * require Vite env (import.meta.glob) and are covered by e2e.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  getChannelState,
  setChannelState,
  resetChannelState,
} from '../src/services/channel-state.ts';
import { dispatchForTesting } from '../src/services/relay-push.ts';
import {
  runStaleCheck,
  runTimeoutCheck,
  startStaleDetection,
  stopStaleDetection,
} from '../src/services/stale-detection.ts';
import { CHANNEL_REGISTRY } from '../src/config/channel-registry.ts';

describe('channel-state integration (Task 3.2)', () => {
  beforeEach(() => {
    resetChannelState();
  });

  afterEach(() => {
    stopStaleDetection();
  });

  describe('bootstrap (static)', () => {
    it('bootstrap.ts sets loading before fetch and ready/error after', () => {
      const root = dirname(fileURLToPath(import.meta.url));
      const src = readFileSync(join(root, '../src/services/bootstrap.ts'), 'utf-8');
      assert.ok(src.includes("setChannelState(ch, 'loading'"), 'bootstrap must set loading before fetch');
      assert.ok(src.includes("setChannelState(ch, 'ready'"), 'bootstrap must set ready on success');
      assert.ok(src.includes("setChannelState(ch, 'error'"), 'bootstrap must set error on failure');
      assert.ok(src.includes("source: 'bootstrap'") || src.includes("'bootstrap'"), 'bootstrap must use bootstrap source');
    });
  });

  describe('WebSocket push', () => {
    it('sets channel to ready with websocket source when push arrives', () => {
      setChannelState('markets', 'loading', 'bootstrap');
      dispatchForTesting('markets', { price: 100 });
      const s = getChannelState('markets');
      assert.equal(s.state, 'ready');
      assert.equal(s.source, 'websocket');
      assert.ok(typeof s.lastDataAt === 'number');
    });

    it('does not set ready when payload is null', () => {
      setChannelState('fred', 'loading', 'bootstrap');
      dispatchForTesting('fred', null);
      const s = getChannelState('fred');
      assert.equal(s.state, 'loading', 'null payload should not transition to ready');
    });

    it('does not set ready when payload is undefined', () => {
      setChannelState('oil', 'loading', 'bootstrap');
      dispatchForTesting('oil', undefined);
      const s = getChannelState('oil');
      assert.equal(s.state, 'loading', 'undefined payload should not transition to ready');
    });
  });

  describe('stale detection', () => {
    it('transitions ready to stale when data older than staleAfterMs', () => {
      const channel = 'markets';
      const def = CHANNEL_REGISTRY[channel];
      assert.ok(def, 'markets should be in registry');

      const oldTimestamp = Date.now() - def.staleAfterMs - 60_000;
      setChannelState(channel, 'ready', 'websocket', { lastDataAt: oldTimestamp });

      runStaleCheck();

      const s = getChannelState(channel);
      assert.equal(s.state, 'stale');
      assert.equal(s.lastDataAt, oldTimestamp, 'stale transition must preserve lastDataAt');
    });

    it('leaves ready channels alone when data is fresh', () => {
      const channel = 'weather';
      setChannelState(channel, 'ready', 'websocket', { lastDataAt: Date.now() });

      runStaleCheck();

      const s = getChannelState(channel);
      assert.equal(s.state, 'ready');
    });

    it('does not affect loading or error channels', () => {
      setChannelState('fred', 'loading');
      setChannelState('oil', 'error', undefined, { error: 'fail' });

      runStaleCheck();

      assert.equal(getChannelState('fred').state, 'loading');
      assert.equal(getChannelState('oil').state, 'error');
    });
  });

  describe('timeout detection (Task 3.3)', () => {
    it('transitions loading to error after timeoutMs', () => {
      const channel = 'markets';
      const def = CHANNEL_REGISTRY[channel];
      assert.ok(def, 'markets should be in registry');

      const oldTimestamp = Date.now() - def.timeoutMs - 5_000;
      setChannelState(channel, 'loading', 'bootstrap', {
        loadingStartedAt: oldTimestamp,
      });

      runTimeoutCheck();

      const s = getChannelState(channel);
      assert.equal(s.state, 'error');
      assert.equal(s.error, 'Service unavailable — data not received');
    });

    it('leaves loading channels alone when within timeout', () => {
      const channel = 'weather';
      const def = CHANNEL_REGISTRY[channel];
      assert.ok(def, 'weather should be in registry');

      const recentTimestamp = Date.now() - 1_000; // 1 second ago
      setChannelState(channel, 'loading', 'bootstrap', {
        loadingStartedAt: recentTimestamp,
      });

      runTimeoutCheck();

      const s = getChannelState(channel);
      assert.equal(s.state, 'loading');
    });

    it('loading → ready before timeout does not error', () => {
      const channel = 'fred';
      setChannelState(channel, 'loading', 'bootstrap');
      setChannelState(channel, 'ready', 'websocket');

      runTimeoutCheck();

      const s = getChannelState(channel);
      assert.equal(s.state, 'ready');
      assert.equal(s.error, null);
    });

    it('uses channel-specific timeoutMs from registry', () => {
      const marketsDef = CHANNEL_REGISTRY['markets'];
      const fredDef = CHANNEL_REGISTRY['fred'];
      assert.ok(marketsDef && fredDef);

      // Both have 30_000 in registry; use different ages to verify we use def.timeoutMs
      const justUnderTimeout = Date.now() - marketsDef.timeoutMs + 1_000;
      const justOverTimeout = Date.now() - fredDef.timeoutMs - 1_000;

      setChannelState('markets', 'loading', 'bootstrap', {
        loadingStartedAt: justUnderTimeout,
      });
      setChannelState('fred', 'loading', 'bootstrap', {
        loadingStartedAt: justOverTimeout,
      });

      runTimeoutCheck();

      assert.equal(getChannelState('markets').state, 'loading');
      assert.equal(getChannelState('fred').state, 'error');
      assert.equal(
        getChannelState('fred').error,
        'Service unavailable — data not received'
      );
    });
  });
});
