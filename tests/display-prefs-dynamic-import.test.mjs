import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('display-prefs bundle contract', () => {
  it('display-prefs.ts does not statically import @supabase/supabase-js', () => {
    const src = readFileSync('src/utils/display-prefs.ts', 'utf8');
    // Static import at top of file would be: import { createClient } from '@supabase/supabase-js'
    const hasStaticImport = /^import\s+.*from\s+['"]@supabase\/supabase-js['"]/m.test(src);
    assert.ok(
      !hasStaticImport,
      'display-prefs.ts must not statically import @supabase/supabase-js — it bloats the critical path bundle'
    );
  });

  it('display-prefs.ts uses dynamic import for supabase', () => {
    const src = readFileSync('src/utils/display-prefs.ts', 'utf8');
    assert.ok(
      src.includes("import('@supabase/supabase-js')"),
      'display-prefs.ts must use dynamic import() for @supabase/supabase-js'
    );
  });
});
