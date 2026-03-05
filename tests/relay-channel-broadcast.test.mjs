// tests/relay-channel-broadcast.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('relay channel broadcast contract', () => {
  it('relay code defines broadcastToChannel function', () => {
    const src = readFileSync('scripts/ais-relay.cjs', 'utf8');
    assert.ok(src.includes('broadcastToChannel'), 'relay must have broadcastToChannel function');
  });

  it('relay raises MAX_WS_CLIENTS to at least 200', () => {
    const src = readFileSync('scripts/ais-relay.cjs', 'utf8');
    const match = src.match(/MAX_WS_CLIENTS\s*=\s*(\d+)/);
    assert.ok(match, 'MAX_WS_CLIENTS must exist');
    assert.ok(Number(match[1]) >= 200, `MAX_WS_CLIENTS must be >= 200, got ${match[1]}`);
  });

  it('relay handles subscribe message type', () => {
    const src = readFileSync('scripts/ais-relay.cjs', 'utf8');
    assert.ok(src.includes("'wm-subscribe'") || src.includes('"wm-subscribe"'),
      'relay must handle wm-subscribe message type');
  });

  it('relay sends wm-push typed messages', () => {
    const src = readFileSync('scripts/ais-relay.cjs', 'utf8');
    assert.ok(src.includes("'wm-push'") || src.includes('"wm-push"'),
      'relay must send wm-push typed messages');
  });

  it('relay supports RELAY_WS_TOKEN for browser WebSocket auth', () => {
    const src = readFileSync('scripts/ais-relay.cjs', 'utf8');
    assert.ok(src.includes('RELAY_WS_TOKEN'), 'relay must read RELAY_WS_TOKEN env var');
    assert.ok(src.includes('isAuthorizedWsRequest'), 'relay must have isAuthorizedWsRequest function');
  });

  it('relay WS auth reads token from query param', () => {
    const src = readFileSync('scripts/ais-relay.cjs', 'utf8');
    assert.ok(src.includes("searchParams.get('token')") || src.includes('searchParams.get("token")'),
      'relay WS auth must read token from URL query parameter');
  });
});
