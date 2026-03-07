'use strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'test-anon-key';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');

describe('config', () => {
  it('throws when required vars are missing', () => {
    const cwd = path.join(__dirname, '..');
    const script = `
      delete process.env.SUPABASE_URL;
      delete process.env.SUPABASE_ANON_KEY;
      try {
        require('./config.cjs');
        process.exit(1);
      } catch (e) {
        if (e.message && e.message.includes('Missing required')) process.exit(0);
        process.exit(2);
      }
    `;
    const result = spawnSync('node', ['-e', script], {
      cwd,
      env: { ...process.env, SUPABASE_URL: '', SUPABASE_ANON_KEY: '' },
    });
    assert.strictEqual(result.status, 0, result.stderr?.toString() || result.stdout?.toString());
  });

  it('uses defaults for optional vars', () => {
    process.env.SUPABASE_URL = 'https://x.supabase.co';
    process.env.SUPABASE_ANON_KEY = 'anon-key';
    delete process.env.REDIS_URL;
    delete process.env.LOG_LEVEL;
    delete process.env.GATEWAY_HOST;

    delete require.cache[require.resolve('../config.cjs')];
    const config = require('../config.cjs');

    assert.strictEqual(config.REDIS_URL, 'redis://localhost:6379');
    assert.strictEqual(config.LOG_LEVEL, 'info');
    assert.strictEqual(config.GATEWAY_HOST, 'gateway');
  });

  it('produces frozen config object', () => {
    process.env.SUPABASE_URL = 'https://x.supabase.co';
    process.env.SUPABASE_ANON_KEY = 'anon-key';

    delete require.cache[require.resolve('../config.cjs')];
    const config = require('../config.cjs');

    assert.strictEqual(Object.isFrozen(config), true);
  });
});
