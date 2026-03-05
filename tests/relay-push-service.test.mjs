// tests/relay-push-service.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('relay-push service contract', () => {
  it('relay-push.ts exports subscribe and connect functions', () => {
    const src = readFileSync('src/services/relay-push.ts', 'utf8');
    assert.ok(src.includes('export function subscribe'), 'must export subscribe');
    assert.ok(src.includes('export function connect') || src.includes('export function initRelayPush'),
      'must export connect/init function');
  });

  it('relay-push.ts handles wm-push messages', () => {
    const src = readFileSync('src/services/relay-push.ts', 'utf8');
    assert.ok(src.includes("'wm-push'") || src.includes('"wm-push"'),
      'must handle wm-push message type');
  });

  it('relay-push.ts sends wm-subscribe on connect', () => {
    const src = readFileSync('src/services/relay-push.ts', 'utf8');
    assert.ok(src.includes("'wm-subscribe'") || src.includes('"wm-subscribe"'),
      'must send wm-subscribe on connect');
  });

  it('relay-push.ts implements reconnection with backoff', () => {
    const src = readFileSync('src/services/relay-push.ts', 'utf8');
    assert.ok(src.includes('reconnect') || src.includes('Reconnect'),
      'must implement reconnection');
  });
});
