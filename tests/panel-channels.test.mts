/**
 * Panel channel API tests (Task 5.1, 5.2).
 * Verifies Panel base class has channels property, onChannelReady/onChannelError hooks,
 * and auto-subscribes to channel state when channelKeys is non-empty.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  setChannelState,
  resetChannelState,
  subscribeChannelState,
} from '../src/services/channel-state.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const panelSrc = readFileSync(resolve(root, 'src/components/Panel.ts'), 'utf-8');

describe('Panel channel API (Task 5.1)', () => {
  it('Panel has channelKeys property', () => {
    assert.ok(
      /readonly\s+channelKeys\s*:\s*string\[\]/.test(panelSrc) ||
        /channelKeys\s*:\s*string\[\]\s*=?\s*\[\]/.test(panelSrc),
      'Panel must have channelKeys: string[] property'
    );
  });

  it('Panel has onChannelReady protected method', () => {
    assert.ok(
      panelSrc.includes('onChannelReady') && panelSrc.includes('protected'),
      'Panel must have protected onChannelReady method'
    );
  });

  it('Panel has onChannelError protected method', () => {
    assert.ok(
      panelSrc.includes('onChannelError') && panelSrc.includes('protected'),
      'Panel must have protected onChannelError method'
    );
  });

  it('onChannelError calls showError by default', () => {
    assert.ok(
      panelSrc.includes('this.showError(error)'),
      'onChannelError default implementation must call showError'
    );
  });
});

describe('Panel auto-subscription (Task 5.2)', () => {
  beforeEach(() => {
    resetChannelState();
  });

  it('Panel imports subscribeChannelState from channel-state', () => {
    assert.ok(
      panelSrc.includes("subscribeChannelState") && panelSrc.includes("channel-state"),
      'Panel must import subscribeChannelState from channel-state'
    );
  });

  it('Panel has subscribeToChannelState method that subscribes to channels', () => {
    assert.ok(
      panelSrc.includes('subscribeToChannelState') &&
        panelSrc.includes('subscribeChannelState(channel'),
      'Panel must have subscribeToChannelState that calls subscribeChannelState'
    );
  });

  it('Panel defers subscription with queueMicrotask', () => {
    assert.ok(
      panelSrc.includes('queueMicrotask') && panelSrc.includes('subscribeToChannelState'),
      'Panel must defer subscription via queueMicrotask'
    );
  });

  it('Panel stores and cleans up channel unsubscribes in destroy', () => {
    assert.ok(
      panelSrc.includes('channelUnsubscribes') &&
        panelSrc.includes('destroy') &&
        panelSrc.includes('unsub()'),
      'Panel must store unsubscribes and call them in destroy'
    );
  });

  it('Panel calls onChannelReady when state is ready', () => {
    assert.ok(
      panelSrc.includes("case 'ready'") &&
        panelSrc.includes('onChannelReady(channel'),
      'Panel must call onChannelReady when channel state is ready'
    );
  });

  it('Panel calls onChannelError when state is error', () => {
    assert.ok(
      panelSrc.includes("case 'error'") &&
        panelSrc.includes('onChannelError(channel'),
      'Panel must call onChannelError when channel state is error'
    );
  });

  it('subscription fires when channel state changes to ready', () => {
    const received: Array<{ channel: string; state: string }> = [];
    const unsub = subscribeChannelState('panel-test-ready', (status) => {
      received.push({ channel: 'panel-test-ready', state: status.state });
    });
    assert.equal(received.length, 1);
    assert.equal(received[0]!.state, 'idle');

    setChannelState('panel-test-ready', 'ready', 'websocket');
    assert.equal(received.length, 2);
    assert.equal(received[1]!.state, 'ready');

    unsub();
  });
});
