// tests/secrets.test.mts
import { strict as assert } from 'assert';
import { test } from 'node:test';

test('getSecret: returns env var when SUPABASE_URL not set', async () => {
  delete process.env.SUPABASE_URL;
  process.env.GROQ_API_KEY = 'env-groq-key';

  const { getSecret } = await import('../server/_shared/secrets.js');
  const result = await getSecret('GROQ_API_KEY');
  assert.strictEqual(result, 'env-groq-key');
});

test('getSecret: returns undefined when key missing everywhere', async () => {
  delete process.env.SUPABASE_URL;
  delete process.env.MISSING_KEY_XYZ;

  const { getSecret } = await import('../server/_shared/secrets.js');
  const result = await getSecret('MISSING_KEY_XYZ');
  assert.strictEqual(result, undefined);
});
