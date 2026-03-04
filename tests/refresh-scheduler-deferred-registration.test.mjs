import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(resolve(__dirname, '..', 'src', 'app', 'refresh-scheduler.ts'), 'utf-8');

describe('refresh scheduler deferred registration', () => {
  it('exports a registerDeferred method', () => {
    assert.ok(appSrc.includes('registerDeferred'), 'missing registerDeferred method');
    assert.ok(appSrc.includes('delayMs'), 'missing delayMs parameter');
  });

  it('registerDeferred body calls scheduleRefresh, guards on isDestroyed, and uses setTimeout with delayMs', () => {
    const methodStart = appSrc.indexOf('registerDeferred(');
    assert.ok(methodStart >= 0, 'registerDeferred method must exist');

    const methodSection = appSrc.slice(methodStart);

    assert.ok(methodSection.includes('scheduleRefresh'), 'method body must call scheduleRefresh');
    assert.ok(methodSection.includes('this.ctx.isDestroyed'), 'method body must check this.ctx.isDestroyed (guard present)');
    assert.ok(methodSection.includes('setTimeout'), 'method body must use setTimeout');
    assert.ok(methodSection.includes('delayMs'), 'method body must use delayMs parameter');
  });
});
