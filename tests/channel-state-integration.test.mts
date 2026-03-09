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
});
