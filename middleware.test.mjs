// middleware.test.mjs
import { strict as assert } from 'node:assert';
import test from 'node:test';

// Helper: build a minimal Request that middleware() receives
function makeRequest(host, { path = '/', ua = 'Twitterbot/1.0' } = {}) {
  return new Request(`https://${host}${path}`, {
    headers: {
      host,
      'user-agent': ua,
    },
  });
}

// Dynamic import so we can re-import after edits if needed
const { default: middleware } = await import('./middleware.ts');

// --- OG variant detection ---

test('serves tech OG for tech.worldmonitor.app (exact map)', async () => {
  const req = makeRequest('tech.worldmonitor.app');
  const res = middleware(req);
  assert.ok(res instanceof Response, 'should return a Response');
  const text = await res.text();
  assert.ok(text.includes('Tech Monitor'), 'should include Tech Monitor title');
  assert.ok(text.includes('tech.worldmonitor.app'), 'OG url should be canonical');
});

test('serves tech OG for tech.info.5ls.us (prefix detection)', async () => {
  const req = makeRequest('tech.info.5ls.us');
  const res = middleware(req);
  assert.ok(res instanceof Response, 'should return a Response');
  const text = await res.text();
  assert.ok(text.includes('Tech Monitor'), 'should include Tech Monitor title');
});

test('serves finance OG for finance.info.5ls.us (prefix detection)', async () => {
  const req = makeRequest('finance.info.5ls.us');
  const res = middleware(req);
  assert.ok(res instanceof Response, 'should return a Response');
  const text = await res.text();
  assert.ok(text.includes('Finance Monitor'), 'should include Finance Monitor title');
});

test('serves happy OG for happy.info.5ls.us (prefix detection)', async () => {
  const req = makeRequest('happy.info.5ls.us');
  const res = middleware(req);
  assert.ok(res instanceof Response, 'should return a Response');
  const text = await res.text();
  assert.ok(text.includes('Happy Monitor'), 'should include Happy Monitor title');
});

test('returns undefined (no OG) for info.5ls.us (no variant prefix)', () => {
  const req = makeRequest('info.5ls.us');
  const res = middleware(req);
  // full/default variant has no OG entry — middleware should not return a Response for root
  assert.equal(res, undefined, 'should not intercept non-variant host at root');
});

test('returns undefined for non-social-bot UA', () => {
  const req = makeRequest('tech.info.5ls.us', { ua: 'Mozilla/5.0 Chrome/120' });
  const res = middleware(req);
  assert.equal(res, undefined, 'regular browsers should not get OG intercept');
});

test('canonical OG url always points to worldmonitor.app, not 5ls.us', async () => {
  const req = makeRequest('tech.info.5ls.us');
  const res = middleware(req);
  assert.ok(res instanceof Response, 'should return Response for tech.info.5ls.us (prerequisite for canonical check)');
  const text = await res.text();
  assert.ok(text.includes('https://tech.worldmonitor.app/'), 'canonical OG url must be worldmonitor.app');
  assert.ok(!text.includes('5ls.us'), 'OG url must not use 5ls.us domain');
});
