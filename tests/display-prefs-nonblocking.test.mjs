import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('display-prefs startup contract', () => {
  it('main.ts does not await initDisplayPrefs before App construction', () => {
    const src = readFileSync('src/main.ts', 'utf8');
    // Must NOT have await initDisplayPrefs() before new App(
    // Find the position of 'new App(' and 'await initDisplayPrefs'
    const appPos = src.indexOf('new App(');
    const awaitPos = src.indexOf('await initDisplayPrefs');
    assert.ok(appPos > -1, 'main.ts must contain new App(');
    // Either it's not awaited at all, or it's after app construction
    assert.ok(
      awaitPos === -1 || awaitPos > appPos,
      'initDisplayPrefs must not be awaited before new App() — it blocks first paint'
    );
  });

  it('main.ts does not await initDisplayPrefs at all', () => {
    const src = readFileSync('src/main.ts', 'utf8');
    assert.ok(
      !src.includes('await initDisplayPrefs'),
      'initDisplayPrefs must never be awaited — it calls Supabase with no timeout'
    );
  });
});
