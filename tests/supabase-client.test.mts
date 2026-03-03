// tests/supabase-client.test.mts
import { strict as assert } from 'assert';
import { test } from 'node:test';

test('createServiceClient returns object with rpc method', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';

  const { createServiceClient } = await import('../server/_shared/supabase.js');
  const client = createServiceClient();
  assert.ok(typeof client.rpc === 'function', 'client.rpc must be a function');
});
