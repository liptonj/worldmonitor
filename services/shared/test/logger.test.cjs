'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createLogger } = require('../logger.cjs');

describe('createLogger', () => {
  it('returns logger with debug, info, warn, error methods', () => {
    const log = createLogger('test');
    assert.strictEqual(typeof log.debug, 'function');
    assert.strictEqual(typeof log.info, 'function');
    assert.strictEqual(typeof log.warn, 'function');
    assert.strictEqual(typeof log.error, 'function');
  });

  it('produces valid JSON with level, timestamp, service, message', () => {
    const logs = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (s) => logs.push({ stream: 'stdout', data: s });
    console.error = (s) => logs.push({ stream: 'stderr', data: s });

    const log = createLogger('svc');
    log.info('hello', { foo: 'bar' });

    console.log = origLog;
    console.error = origErr;

    assert.strictEqual(logs.length, 1);
    const parsed = JSON.parse(logs[0].data);
    assert.strictEqual(parsed.level, 'info');
    assert.strictEqual(parsed.service, 'svc');
    assert.strictEqual(parsed.message, 'hello');
    assert.strictEqual(parsed.foo, 'bar');
    assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(parsed.timestamp));
  });

  it('respects LOG_LEVEL and filters lower levels', () => {
    const logs = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (s) => logs.push(s);
    console.error = (s) => logs.push(s);

    const prev = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'warn';

    const log = createLogger('svc');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');

    process.env.LOG_LEVEL = prev;
    console.log = origLog;
    console.error = origErr;

    assert.strictEqual(logs.length, 2);
    assert.ok(JSON.parse(logs[0]).message === 'w' || JSON.parse(logs[1]).message === 'w');
    assert.ok(JSON.parse(logs[0]).message === 'e' || JSON.parse(logs[1]).message === 'e');
  });

  it('does not throw when extra args are undefined', () => {
    const log = createLogger('svc');
    assert.doesNotThrow(() => {
      log.info('msg');
      log.info('msg', undefined);
      log.info('msg', {});
    });
  });
});
