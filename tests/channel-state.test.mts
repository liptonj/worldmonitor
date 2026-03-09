/**
 * Channel state machine tests.
 * Verifies state transitions, subscriptions, and unsubscribe behavior.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setChannelState,
  getChannelState,
  subscribeChannelState,
  type ChannelStatus,
} from '../src/services/channel-state.ts';

describe('channel-state', () => {
  beforeEach(() => {
    // Reset state between tests by setting known channels to idle
    // (module uses module-level Map; we can't clear it without exporting a reset)
    // Use unique channel names per test to avoid cross-test pollution
  });

  describe('getChannelState', () => {
    it('returns default idle status for unknown channel', () => {
      const status = getChannelState('never-touched-channel');
      assert.equal(status.state, 'idle');
      assert.equal(status.lastDataAt, null);
      assert.equal(status.error, null);
      assert.equal(status.source, null);
    });
  });

  describe('setChannelState / getChannelState', () => {
    it('transitions idle → loading', () => {
      setChannelState('markets', 'loading', 'bootstrap');
      const status = getChannelState('markets');
      assert.equal(status.state, 'loading');
      assert.equal(status.source, 'bootstrap');
    });

    it('transitions loading → ready', () => {
      setChannelState('markets', 'loading');
      setChannelState('markets', 'ready', 'websocket');
      const status = getChannelState('markets');
      assert.equal(status.state, 'ready');
      assert.ok(typeof status.lastDataAt === 'number');
      assert.equal(status.source, 'websocket');
    });

    it('transitions loading → error with message', () => {
      setChannelState('fred', 'loading');
      setChannelState('fred', 'error', undefined, { error: 'Service unavailable' });
      const status = getChannelState('fred');
      assert.equal(status.state, 'error');
      assert.equal(status.error, 'Service unavailable');
    });

    it('transitions ready → stale', () => {
      setChannelState('weather', 'ready', 'websocket');
      setChannelState('weather', 'stale');
      const status = getChannelState('weather');
      assert.equal(status.state, 'stale');
      assert.ok(typeof status.lastDataAt === 'number');
    });

    it('accepts custom lastDataAt when setting ready', () => {
      const ts = 1_700_000_000_000;
      setChannelState('oil', 'ready', 'http-fallback', { lastDataAt: ts });
      const status = getChannelState('oil');
      assert.equal(status.lastDataAt, ts);
    });

    it('ignores invalid source and keeps previous', () => {
      setChannelState('test-invalid', 'ready', 'websocket');
      setChannelState('test-invalid', 'stale', 'invalid-source' as never);
      const status = getChannelState('test-invalid');
      assert.equal(status.source, 'websocket');
    });
  });

  describe('subscribeChannelState', () => {
    it('fires callback immediately with current state', () => {
      const received: ChannelStatus[] = [];
      subscribeChannelState('sub-immediate', (s) => received.push(s));
      assert.equal(received.length, 1);
      assert.equal(received[0]!.state, 'idle');
    });

    it('fires callback when state changes', () => {
      const received: ChannelStatus[] = [];
      subscribeChannelState('sub-change', (s) => received.push(s));
      assert.equal(received.length, 1);

      setChannelState('sub-change', 'loading');
      assert.equal(received.length, 2);
      assert.equal(received[1]!.state, 'loading');

      setChannelState('sub-change', 'ready', 'websocket');
      assert.equal(received.length, 3);
      assert.equal(received[2]!.state, 'ready');
    });

    it('multiple subscribers all receive updates', () => {
      const a: ChannelStatus[] = [];
      const b: ChannelStatus[] = [];
      subscribeChannelState('sub-multi', (s) => a.push(s));
      subscribeChannelState('sub-multi', (s) => b.push(s));

      setChannelState('sub-multi', 'loading');
      assert.equal(a.length, 2);
      assert.equal(b.length, 2);
      assert.equal(a[1]!.state, 'loading');
      assert.equal(b[1]!.state, 'loading');
    });

    it('unsubscribe stops further updates', () => {
      const received: ChannelStatus[] = [];
      const unsub = subscribeChannelState('sub-unsub', (s) => received.push(s));
      assert.equal(received.length, 1);

      setChannelState('sub-unsub', 'loading');
      assert.equal(received.length, 2);

      unsub();
      setChannelState('sub-unsub', 'ready');
      assert.equal(received.length, 2, 'no more callbacks after unsubscribe');
    });

    it('unsubscribing one of multiple does not affect others', () => {
      const a: ChannelStatus[] = [];
      const b: ChannelStatus[] = [];
      const unsubA = subscribeChannelState('sub-partial', (s) => a.push(s));
      subscribeChannelState('sub-partial', (s) => b.push(s));

      unsubA();
      setChannelState('sub-partial', 'loading');
      assert.equal(a.length, 1);
      assert.equal(b.length, 2);
    });
  });
});
