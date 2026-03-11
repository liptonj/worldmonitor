# Strategic Posture: Direct OAuth2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix `strategic-posture.cjs` to make direct OAuth2 calls to OpenSky API instead of proxying through a relay, and fix `opensky.cjs` which also makes unauthenticated calls. Verify no other worker channels have the same problem.

**Architecture:** The gateway IS the relay server. Workers fetch data directly from external APIs using credentials from Supabase Vault, store results in Redis, then gRPC-broadcast to the gateway which pushes to frontend WebSocket clients. Workers should NEVER proxy through a relay URL.

**Tech Stack:** Node.js (CJS), Supabase Vault (secrets.cjs), Redis, Docker, gRPC, WebSocket

---

## Background: Correct Data Flow

```
Orchestrator
  └─ Reads wm_admin.service_config (Supabase)
  └─ gRPC Execute → Worker

Worker (strategic-posture.cjs)
  ├─ Gets OPENSKY_CLIENT_ID from config (Vault via secrets.cjs)
  ├─ Gets OPENSKY_CLIENT_SECRET from config (Vault via secrets.cjs)
  ├─ OAuth2 client_credentials → auth.opensky-network.org
  ├─ Calls opensky-network.org/api/states/all with Bearer token
  ├─ Processes data → theater posture levels
  ├─ worker-runner.cjs stores in Redis (theater-posture:sebuf:v1)
  └─ worker-runner.cjs gRPC Broadcast → Gateway

Gateway (= the relay server)
  ├─ gRPC Broadcast handler → handleBroadcast()
  └─ ws.send({ type:'wm-push', channel:'strategic-posture', data, ts })

Frontend (StrategicPosturePanel)
  ├─ channelKeys = ['strategic-posture']
  └─ applyPush(payload) ← WebSocket only, no HTTP polling
```

---

## Task 1: Create shared OpenSky OAuth2 helper module

Both `strategic-posture.cjs` and `opensky.cjs` call OpenSky API. Extract the OAuth2 logic into a shared module so both can use it.

**Files:**
- Create: `services/shared/opensky-auth.cjs`
- Test: `services/shared/test/opensky-auth.test.cjs`

**Step 1: Write the failing test**

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { getOpenSkyToken, _resetForTest } = require('../opensky-auth.cjs');

test('getOpenSkyToken returns null when no credentials configured', async () => {
  _resetForTest();
  const token = await getOpenSkyToken({});
  assert.strictEqual(token, null);
});

test('getOpenSkyToken returns token on successful OAuth2 exchange', async () => {
  _resetForTest();
  const mockFetch = async (url, opts) => {
    assert.ok(url.includes('auth.opensky-network.org'));
    assert.strictEqual(opts.method, 'POST');
    assert.ok(opts.body.includes('grant_type=client_credentials'));
    assert.ok(opts.body.includes('client_id=test-id'));
    assert.ok(opts.body.includes('client_secret=test-secret'));
    return {
      ok: true,
      json: async () => ({ access_token: 'mock-token-123', expires_in: 1800 }),
    };
  };

  const token = await getOpenSkyToken(
    { OPENSKY_CLIENT_ID: 'test-id', OPENSKY_CLIENT_SECRET: 'test-secret' },
    mockFetch,
  );
  assert.strictEqual(token, 'mock-token-123');
});

test('getOpenSkyToken caches token on subsequent calls', async () => {
  _resetForTest();
  let fetchCount = 0;
  const mockFetch = async () => {
    fetchCount++;
    return {
      ok: true,
      json: async () => ({ access_token: 'cached-token', expires_in: 1800 }),
    };
  };

  const config = { OPENSKY_CLIENT_ID: 'test-id', OPENSKY_CLIENT_SECRET: 'test-secret' };
  const t1 = await getOpenSkyToken(config, mockFetch);
  const t2 = await getOpenSkyToken(config, mockFetch);
  assert.strictEqual(t1, 'cached-token');
  assert.strictEqual(t2, 'cached-token');
  assert.strictEqual(fetchCount, 1);
});

test('getOpenSkyToken returns null and enters cooldown on auth failure', async () => {
  _resetForTest();
  const mockFetch = async () => ({
    ok: false,
    status: 401,
    text: async () => 'Unauthorized',
  });

  const config = { OPENSKY_CLIENT_ID: 'test-id', OPENSKY_CLIENT_SECRET: 'test-secret' };
  const token = await getOpenSkyToken(config, mockFetch);
  assert.strictEqual(token, null);
});
```

**Step 2: Run test to verify it fails**

Run: `node --test services/shared/test/opensky-auth.test.cjs`
Expected: FAIL with "Cannot find module '../opensky-auth.cjs'"

**Step 3: Write the implementation**

Port the OAuth2 logic from `scripts/ais-relay.cjs` lines 3153-3277, adapted for the worker environment using Node `fetch` (available in Node 18+) instead of raw `https` module.

```javascript
'use strict';

const { createLogger } = require('./logger.cjs');

const log = createLogger('opensky-auth');

const AUTH_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
const AUTH_TIMEOUT_MS = 10_000;
const AUTH_COOLDOWN_MS = 60_000;
const AUTH_MAX_RETRIES = 3;
const AUTH_RETRY_DELAYS = [0, 2000, 5000];
const TOKEN_REFRESH_BUFFER_MS = 60_000;

let _token = null;
let _tokenExpiry = 0;
let _tokenPromise = null;
let _cooldownUntil = 0;

function _resetForTest() {
  _token = null;
  _tokenExpiry = 0;
  _tokenPromise = null;
  _cooldownUntil = 0;
}

async function _attemptTokenFetch(clientId, clientSecret, fetchFn) {
  const body = `grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AUTH_TIMEOUT_MS);

  try {
    const res = await fetchFn(AUTH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': String(Buffer.byteLength(body)),
        'User-Agent': 'WorldMonitor/1.0',
      },
      body,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }

    const json = await res.json();
    if (json.access_token) {
      return { token: json.access_token, expiresIn: json.expires_in || 1800 };
    }
    return { error: json.error || 'no_access_token' };
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') return { error: 'TIMEOUT' };
    return { error: err.message };
  }
}

async function _fetchToken(clientId, clientSecret, fetchFn) {
  for (let attempt = 0; attempt < AUTH_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = AUTH_RETRY_DELAYS[attempt] || 5000;
      log.info('OpenSky auth retry', { attempt: attempt + 1, max: AUTH_MAX_RETRIES, delayMs: delay });
      await new Promise((r) => setTimeout(r, delay));
    } else {
      log.info('Fetching new OpenSky OAuth2 token');
    }

    const result = await _attemptTokenFetch(clientId, clientSecret, fetchFn);
    if (result.token) {
      _token = result.token;
      _tokenExpiry = Date.now() + result.expiresIn * 1000;
      log.info('OpenSky token acquired', { expiresInSeconds: result.expiresIn });
      return _token;
    }
    log.warn('OpenSky auth attempt failed', { attempt: attempt + 1, error: result.error });
  }

  _cooldownUntil = Date.now() + AUTH_COOLDOWN_MS;
  log.warn('OpenSky auth failed after retries, entering cooldown', { cooldownMs: AUTH_COOLDOWN_MS });
  return null;
}

async function getOpenSkyToken(config, fetchFn = globalThis.fetch) {
  const clientId = config?.OPENSKY_CLIENT_ID || process.env.OPENSKY_CLIENT_ID;
  const clientSecret = config?.OPENSKY_CLIENT_SECRET || process.env.OPENSKY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return null;
  }

  if (_token && Date.now() < _tokenExpiry - TOKEN_REFRESH_BUFFER_MS) {
    return _token;
  }

  if (Date.now() < _cooldownUntil) {
    log.debug('OpenSky auth in cooldown', { remainingMs: _cooldownUntil - Date.now() });
    return null;
  }

  if (_tokenPromise) {
    return _tokenPromise;
  }

  _tokenPromise = _fetchToken(clientId, clientSecret, fetchFn);
  try {
    return await _tokenPromise;
  } finally {
    _tokenPromise = null;
  }
}

module.exports = { getOpenSkyToken, _resetForTest };
```

**Step 4: Run test to verify it passes**

Run: `node --test services/shared/test/opensky-auth.test.cjs`
Expected: All 4 tests PASS

**Step 5: Commit**

```bash
git add services/shared/opensky-auth.cjs services/shared/test/opensky-auth.test.cjs
git commit -m "feat: add shared OpenSky OAuth2 helper for direct worker auth"
```

---

## Task 2: Rewrite strategic-posture.cjs to use direct OAuth2

Remove all relay proxy logic. Use the new `opensky-auth.cjs` module.

**Files:**
- Modify: `services/shared/channels/strategic-posture.cjs`
- Modify: `services/shared/channels/test/strategic-posture.test.cjs`

**Step 1: Write/update the failing tests**

Replace the test file completely:

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { _resetForTest } = require('../../opensky-auth.cjs');

const mockRedis = { get: async () => null, setex: async () => {} };
const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

test('fetchStrategicPosture returns success with military flights', async () => {
  _resetForTest();
  const fetchStrategicPosture = require('../strategic-posture.cjs');
  const mockHttp = {
    fetchJson: async () => ({
      states: [
        ['AE1234', 'RCH123', null, null, null, 10, 50, 35000, false, 450, 90],
        ['AD5678', 'EVAC1', null, null, null, 12, 52, 30000, false, 400, 85],
      ],
    }),
  };

  const result = await fetchStrategicPosture({
    config: { OPENSKY_CLIENT_ID: 'test', OPENSKY_CLIENT_SECRET: 'test' },
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'strategic-posture');
  assert.ok(result.timestamp);
  assert.ok(Array.isArray(result.data.theaters));
  assert.ok(result.data.theaters.length > 0);
});

test('fetchStrategicPosture returns error when all region fetches fail', async () => {
  _resetForTest();
  const fetchStrategicPosture = require('../strategic-posture.cjs');
  const mockHttp = {
    fetchJson: async () => { throw new Error('Network error'); },
  };

  const result = await fetchStrategicPosture({
    config: { OPENSKY_CLIENT_ID: 'test', OPENSKY_CLIENT_SECRET: 'test' },
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.ok(result.errors.includes('All OpenSky region fetches failed'));
});

test('fetchStrategicPosture returns error when no credentials configured', async () => {
  _resetForTest();
  const fetchStrategicPosture = require('../strategic-posture.cjs');
  const mockHttp = {
    fetchJson: async () => { throw new Error('should not be called'); },
  };

  const result = await fetchStrategicPosture({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.ok(result.errors[0].includes('OpenSky credentials not configured'));
});

test('fetchStrategicPosture does NOT use WS_RELAY_URL', async () => {
  _resetForTest();
  const fetchStrategicPosture = require('../strategic-posture.cjs');
  let capturedUrl = null;
  const mockHttp = {
    fetchJson: async (url) => {
      capturedUrl = url;
      return { states: [] };
    },
  };

  await fetchStrategicPosture({
    config: {
      OPENSKY_CLIENT_ID: 'test',
      OPENSKY_CLIENT_SECRET: 'test',
      WS_RELAY_URL: 'https://should-not-be-used.example.com',
    },
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.ok(capturedUrl, 'fetchJson should have been called');
  assert.ok(capturedUrl.includes('opensky-network.org'), `URL should be direct OpenSky, got: ${capturedUrl}`);
  assert.ok(!capturedUrl.includes('should-not-be-used'), 'Should NOT use relay URL');
});

test('fetchStrategicPosture includes Bearer token in headers', async () => {
  _resetForTest();
  const fetchStrategicPosture = require('../strategic-posture.cjs');
  let capturedHeaders = null;
  const mockHttp = {
    fetchJson: async (url, opts) => {
      capturedHeaders = opts?.headers;
      return { states: [] };
    },
  };

  await fetchStrategicPosture({
    config: { OPENSKY_CLIENT_ID: 'test', OPENSKY_CLIENT_SECRET: 'test' },
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.ok(capturedHeaders, 'Headers should be provided');
  assert.ok(capturedHeaders.Authorization, 'Authorization header must be set');
  assert.ok(capturedHeaders.Authorization.startsWith('Bearer '), 'Must use Bearer token');
});
```

**Step 2: Run test to verify it fails**

Run: `node --test services/shared/channels/test/strategic-posture.test.cjs`
Expected: FAIL (still uses old relay logic)

**Step 3: Rewrite strategic-posture.cjs**

Replace entire file:

```javascript
'use strict';

const { getOpenSkyToken } = require('../opensky-auth.cjs');

const USER_AGENT = 'WorldMonitor/1.0';
const OPENSKY_API_URL = 'https://opensky-network.org/api/states/all';
const POSTURE_TIMEOUT_MS = 15_000;

const THEATER_QUERY_REGIONS = [
  { name: 'WESTERN', lamin: 10, lamax: 66, lomin: 9, lomax: 66 },
  { name: 'PACIFIC', lamin: 4, lamax: 44, lomin: 104, lomax: 133 },
];

const POSTURE_THEATERS = [
  { id: 'baltic', bounds: { north: 66, south: 54, east: 30, west: 9 }, thresholds: { critical: 15, elevated: 8 }, strikeIndicators: { minTankers: 2, minAwacs: 1, minFighters: 4 } },
  { id: 'eastern_med', bounds: { north: 42, south: 30, east: 40, west: 18 }, thresholds: { critical: 12, elevated: 6 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 } },
  { id: 'persian_gulf', bounds: { north: 30, south: 24, east: 60, west: 48 }, thresholds: { critical: 10, elevated: 5 }, strikeIndicators: { minTankers: 1, minAwacs: 0, minFighters: 2 } },
  { id: 'red_sea', bounds: { north: 30, south: 12, east: 44, west: 32 }, thresholds: { critical: 8, elevated: 4 }, strikeIndicators: { minTankers: 1, minAwacs: 0, minFighters: 2 } },
  { id: 'scs', bounds: { north: 25, south: 4, east: 122, west: 104 }, thresholds: { critical: 12, elevated: 6 }, strikeIndicators: { minTankers: 2, minAwacs: 1, minFighters: 4 } },
  { id: 'korea', bounds: { north: 44, south: 33, east: 133, west: 124 }, thresholds: { critical: 10, elevated: 5 }, strikeIndicators: { minTankers: 2, minAwacs: 1, minFighters: 4 } },
];

function isMilitaryCallsign(cs) {
  const c = (cs || '').trim().toUpperCase();
  return /^(RCH|EVAC|VALOR|SPAR|NAF|REACH|DUKE|VIPER|BLUE|COBRA|SNAKE|HAWK|EAGLE|WOLF|TIGER|BONE|HAMMER|SABRE|STRIKE|WILD|BULL|VIP|AF\d|NAVY|NAVY\d|MARINE|ARMY|ARMY\d)\d*$/.test(c) || /^[A-Z]{2}\d{2,}$/.test(c);
}

function isMilitaryHex(icao) {
  const h = (icao || '').toUpperCase();
  return /^[0-9A-F]{6}$/.test(h) && (h.startsWith('AE') || h.startsWith('AD') || h.startsWith('AC') || h.startsWith('43') || h.startsWith('48') || h.startsWith('39'));
}

module.exports = async function fetchStrategicPosture({ config, redis, log, http }) {
  log.debug('fetchStrategicPosture executing');
  const timestamp = new Date().toISOString();

  const token = await getOpenSkyToken(config);
  if (!token) {
    log.warn('fetchStrategicPosture: OpenSky credentials not configured or auth failed');
    return {
      timestamp,
      source: 'strategic-posture',
      data: { theaters: [] },
      status: 'error',
      errors: ['OpenSky credentials not configured or auth failed'],
    };
  }

  const headers = {
    Accept: 'application/json',
    'User-Agent': USER_AGENT,
    Authorization: `Bearer ${token}`,
  };

  let flights = [];
  let anySuccess = false;
  for (const region of THEATER_QUERY_REGIONS) {
    const params = `lamin=${region.lamin}&lamax=${region.lamax}&lomin=${region.lomin}&lomax=${region.lomax}`;
    const url = `${OPENSKY_API_URL}?${params}`;
    try {
      const data = await http.fetchJson(url, {
        headers,
        timeout: POSTURE_TIMEOUT_MS,
      });
      anySuccess = true;
      const states = data?.states || [];
      for (const s of states) {
        const [icao24, callsign, , , , lon, lat, altitude, onGround, velocity, heading] = s;
        if (lat == null || lon == null || onGround) continue;
        if (!isMilitaryCallsign(callsign) && !isMilitaryHex(icao24)) continue;
        flights.push({
          id: icao24,
          callsign: (callsign || '').trim(),
          lat,
          lon,
          altitude: altitude ?? 0,
          heading: heading ?? 0,
          speed: velocity ?? 0,
        });
      }
    } catch (err) {
      log.warn('fetchStrategicPosture region fetch failed', { region: region.name, error: err?.message });
    }
  }

  if (!anySuccess && flights.length === 0) {
    return {
      timestamp,
      source: 'strategic-posture',
      data: { theaters: [] },
      status: 'error',
      errors: ['All OpenSky region fetches failed'],
    };
  }

  const seen = new Set();
  flights = flights.filter((f) => !seen.has(f.id) && seen.add(f.id));

  const theaters = POSTURE_THEATERS.map((t) => {
    const theaterFlights = flights.filter(
      (f) => f.lat >= t.bounds.south && f.lat <= t.bounds.north && f.lon >= t.bounds.west && f.lon <= t.bounds.east
    );
    const total = theaterFlights.length;
    const byType = { tankers: 0, awacs: 0, fighters: 0 };
    for (const f of theaterFlights) {
      const c = (f.callsign || '').toUpperCase();
      if (/RCH|TANK|KC|KC\d/.test(c)) byType.tankers++;
      else if (/E3|AWACS|E-\d/.test(c)) byType.awacs++;
      else byType.fighters++;
    }
    const postureLevel = total >= t.thresholds.critical ? 'critical' : total >= t.thresholds.elevated ? 'elevated' : 'normal';
    const strikeCapable =
      byType.tankers >= t.strikeIndicators.minTankers &&
      byType.awacs >= t.strikeIndicators.minAwacs &&
      byType.fighters >= t.strikeIndicators.minFighters;
    const ops = [];
    if (strikeCapable) ops.push('strike_capable');
    if (byType.tankers > 0) ops.push('aerial_refueling');
    if (byType.awacs > 0) ops.push('airborne_early_warning');
    return {
      theater: t.id,
      postureLevel,
      activeFlights: total,
      trackedVessels: 0,
      activeOperations: ops,
      assessedAt: Date.now(),
    };
  });

  return {
    timestamp,
    source: 'strategic-posture',
    data: { theaters },
    status: 'success',
  };
};
```

**Step 4: Run test to verify it passes**

Run: `node --test services/shared/channels/test/strategic-posture.test.cjs`
Expected: All 5 tests PASS

**Step 5: Commit**

```bash
git add services/shared/channels/strategic-posture.cjs services/shared/channels/test/strategic-posture.test.cjs
git commit -m "fix: strategic-posture uses direct OpenSky OAuth2 instead of relay proxy"
```

---

## Task 3: Fix opensky.cjs to use OAuth2

`opensky.cjs` currently makes unauthenticated calls to OpenSky which will get rate-limited. Add OAuth2 support using the same shared module.

**Files:**
- Modify: `services/shared/channels/opensky.cjs`
- Modify: `services/shared/channels/test/opensky.test.cjs`

**Step 1: Update tests**

Add a test for authenticated access and Bearer token header:

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { _resetForTest } = require('../../opensky-auth.cjs');

const mockRedis = { get: async () => null, setex: async () => {} };
const mockLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

test('fetchOpensky returns worker-compatible format on success', async () => {
  _resetForTest();
  const fetchOpensky = require('../opensky.cjs');
  const mockHttp = {
    fetchJson: async () => ({
      time: 1234567890,
      states: [
        ['a12345', 'UAL123', 'United States', 1234567890, 1234567890, -122.5, 37.5, 35000, false, 450, 90],
      ],
    }),
  };

  const result = await fetchOpensky({
    config: { OPENSKY_CLIENT_ID: 'test', OPENSKY_CLIENT_SECRET: 'test' },
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.source, 'opensky');
  assert.ok(result.data.states.length >= 1);
  assert.strictEqual(result.data.states[0].icao24, 'a12345');
});

test('fetchOpensky handles fetch error gracefully', async () => {
  _resetForTest();
  const fetchOpensky = require('../opensky.cjs');
  const mockHttp = {
    fetchJson: async () => { throw new Error('OpenSky HTTP 429'); },
  };

  const result = await fetchOpensky({
    config: { OPENSKY_CLIENT_ID: 'test', OPENSKY_CLIENT_SECRET: 'test' },
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'error');
  assert.ok(result.errors.length > 0);
});

test('fetchOpensky uses custom bbox when configured', async () => {
  _resetForTest();
  const fetchOpensky = require('../opensky.cjs');
  let capturedUrl = null;
  const mockHttp = {
    fetchJson: async (url) => {
      capturedUrl = url;
      return { time: 0, states: [] };
    },
  };

  await fetchOpensky({
    config: { OPENSKY_BBOX: '47,5,48,6', OPENSKY_CLIENT_ID: 'test', OPENSKY_CLIENT_SECRET: 'test' },
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.ok(capturedUrl.includes('lamin=47'));
});

test('fetchOpensky includes Bearer token when credentials available', async () => {
  _resetForTest();
  const fetchOpensky = require('../opensky.cjs');
  let capturedHeaders = null;
  const mockHttp = {
    fetchJson: async (url, opts) => {
      capturedHeaders = opts?.headers;
      return { time: 0, states: [] };
    },
  };

  await fetchOpensky({
    config: { OPENSKY_CLIENT_ID: 'test', OPENSKY_CLIENT_SECRET: 'test' },
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.ok(capturedHeaders.Authorization, 'Authorization header must be set');
  assert.ok(capturedHeaders.Authorization.startsWith('Bearer '));
});

test('fetchOpensky still works without credentials (unauthenticated fallback)', async () => {
  _resetForTest();
  const fetchOpensky = require('../opensky.cjs');
  const mockHttp = {
    fetchJson: async () => ({ time: 0, states: [] }),
  };

  const result = await fetchOpensky({
    config: {},
    redis: mockRedis,
    log: mockLog,
    http: mockHttp,
  });

  assert.strictEqual(result.status, 'success');
});
```

**Step 2: Run test to verify it fails**

Run: `node --test services/shared/channels/test/opensky.test.cjs`
Expected: FAIL on Bearer token test

**Step 3: Rewrite opensky.cjs**

```javascript
'use strict';

const { getOpenSkyToken } = require('../opensky-auth.cjs');

const USER_AGENT = 'WorldMonitor/1.0';
const OPENSKY_API_URL = 'https://opensky-network.org/api/states/all';
const OPENSKY_TIMEOUT_MS = 15_000;

const DEFAULT_BBOX = [35, -10, 71, 40];

function parseBbox(bboxStr) {
  if (!bboxStr || typeof bboxStr !== 'string') return DEFAULT_BBOX;
  const parts = bboxStr.split(/[,\s]+/).map((p) => parseFloat(p.trim()));
  if (parts.length >= 4 && parts.every(Number.isFinite)) return parts;
  return DEFAULT_BBOX;
}

function transformState(s) {
  if (!Array.isArray(s) || s.length < 10) return null;
  const [icao24, callsign, originCountry, timePosition, lastContact, lon, lat, baroAltitude, onGround, velocity] = s;
  return {
    icao24: icao24 || '',
    callsign: (callsign || '').trim(),
    originCountry: originCountry || '',
    longitude: typeof lon === 'number' ? lon : null,
    latitude: typeof lat === 'number' ? lat : null,
    baroAltitude: typeof baroAltitude === 'number' ? baroAltitude : null,
    onGround: !!onGround,
    velocity: typeof velocity === 'number' ? velocity : null,
  };
}

module.exports = async function fetchOpensky({ config, redis, log, http }) {
  log.debug('fetchOpensky executing');
  const timestamp = new Date().toISOString();

  const bboxStr = config?.OPENSKY_BBOX || process.env.OPENSKY_BBOX;
  const [lamin, lomin, lamax, lomax] = parseBbox(bboxStr);

  let url = OPENSKY_API_URL;
  if (lamin != null && lomin != null && lamax != null && lomax != null) {
    url += `?lamin=${lamin}&lomin=${lomin}&lamax=${lamax}&lomax=${lomax}`;
  }

  const headers = { 'User-Agent': USER_AGENT, Accept: 'application/json' };

  const token = await getOpenSkyToken(config);
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  } else {
    log.info('fetchOpensky: no OAuth2 token, using unauthenticated access (rate-limited)');
  }

  try {
    const raw = await http.fetchJson(url, {
      headers,
      timeout: OPENSKY_TIMEOUT_MS,
    });

    const states = (raw?.states || []).map(transformState).filter(Boolean);

    return {
      timestamp,
      source: 'opensky',
      data: { time: raw?.time ?? Date.now(), states },
      status: 'success',
    };
  } catch (err) {
    log.error('fetchOpensky error', { error: err?.message ?? err });
    return {
      timestamp,
      source: 'opensky',
      data: { time: Date.now(), states: [] },
      status: 'error',
      errors: [err?.message ?? String(err)],
    };
  }
};
```

**Step 4: Run test to verify it passes**

Run: `node --test services/shared/channels/test/opensky.test.cjs`
Expected: All 5 tests PASS

**Step 5: Commit**

```bash
git add services/shared/channels/opensky.cjs services/shared/channels/test/opensky.test.cjs
git commit -m "fix: opensky.cjs uses OAuth2 Bearer token for authenticated API access"
```

---

## Task 4: Clean up docker-compose.yml — remove WS_RELAY_URL

The worker no longer needs `WS_RELAY_URL` or `RELAY_SHARED_SECRET` for OpenSky proxying. `RELAY_SHARED_SECRET` may still be needed by other services (gateway auth), so only remove `WS_RELAY_URL` from the worker.

**Files:**
- Modify: `services/docker-compose.yml:124`

**Step 1: Remove WS_RELAY_URL from worker environment**

In `services/docker-compose.yml`, remove line 124:

```yaml
      - WS_RELAY_URL=${WS_RELAY_URL:-}
```

Keep `RELAY_SHARED_SECRET` as it may be used by other channels or gateway auth. Keep `OPENSKY_CLIENT_ID` and `OPENSKY_CLIENT_SECRET` as they are now directly used by the worker.

**Step 2: Verify docker-compose.yml is valid**

Run: `docker compose -f services/docker-compose.yml config --quiet`
Expected: No errors

**Step 3: Commit**

```bash
git add services/docker-compose.yml
git commit -m "chore: remove WS_RELAY_URL from worker — no longer proxies OpenSky"
```

---

## Task 5: Verify Supabase Vault has correct OpenSky credentials

The worker now directly uses `OPENSKY_CLIENT_ID` and `OPENSKY_CLIENT_SECRET` via `secrets.cjs`. Verify they are in Vault with the correct values.

**Files:**
- Query: Supabase Vault via MCP

**Step 1: Verify get_vault_secret_value RPC function exists**

```sql
SELECT routine_name FROM information_schema.routines
WHERE routine_schema = 'public' AND routine_name = 'get_vault_secret_value';
```

Expected: Function exists

**Step 2: Verify OPENSKY_CLIENT_ID in Vault**

```sql
SELECT get_vault_secret_value('OPENSKY_CLIENT_ID') AS value;
```

Expected: `jlipton522-api-client`

**Step 3: Verify OPENSKY_CLIENT_SECRET in Vault**

```sql
SELECT get_vault_secret_value('OPENSKY_CLIENT_SECRET') AS value;
```

Expected: `ZLGqFsHjnQGpVLDq29Th9f2JFCIoC2ra`

**Step 4: Verify these are in KNOWN_SECRETS**

In `services/shared/secrets.cjs` lines 22-23:
```javascript
'OPENSKY_CLIENT_ID',
'OPENSKY_CLIENT_SECRET',
```

These are already there — no changes needed. The worker's `initSecrets()` will load them from Vault into memory cache, and `getAllCachedSecrets()` will include them in the enriched config passed to `strategic-posture.cjs` and `opensky.cjs`.

---

## Task 6: Audit all other worker channels for relay proxy usage

Verify no other channel incorrectly uses relay proxying.

**Files:**
- Audit: All files in `services/shared/channels/`

**Step 1: Search for relay patterns**

Run:
```bash
rg "WS_RELAY_URL|RELAY_SHARED_SECRET|relayBase|relay\.5ls" services/shared/channels/ --type js
```

Expected: Zero matches (after Task 2 fix). If any remain, they are bugs.

**Step 2: Search for unauthenticated OpenSky calls**

Run:
```bash
rg "opensky-network\.org" services/shared/channels/ --type js
```

Expected: Only `opensky-auth.cjs` should reference `auth.opensky-network.org`. Both `strategic-posture.cjs` and `opensky.cjs` should reference `opensky-network.org/api/states/all` but always with a Bearer token.

**Step 3: Verify all channels use config for credentials (not hardcoded)**

Run:
```bash
rg "process\.env\.(OPENSKY|RELAY)" services/shared/channels/ --type js
```

Expected: Zero matches in channel files. Credentials should come from `config` object (which is enriched with Vault secrets by `worker-runner.cjs`).

**Step 4: Review channels list for any other external APIs that may need auth**

Review `services/shared/channels/index.cjs` — all 35+ channels listed. The channels below access external APIs and should be verified:

| Channel | API | Auth Method | Status |
|---------|-----|-------------|--------|
| `strategic-posture.cjs` | OpenSky | OAuth2 Bearer | FIXED (Task 2) |
| `opensky.cjs` | OpenSky | OAuth2 Bearer | FIXED (Task 3) |
| `fred.cjs` | FRED | API key in URL | ✅ Uses config.FRED_API_KEY |
| `oil.cjs` | EIA | API key | ✅ Uses config.EIA_API_KEY |
| `conflict.cjs` | ACLED | Token header | ✅ Uses config.ACLED_ACCESS_TOKEN |
| `natural.cjs` | NASA FIRMS | API key | ✅ Uses config.NASA_FIRMS_API_KEY |
| `flights.cjs` | Aviationstack | API key | ✅ Uses config.AVIATIONSTACK_API_KEY |
| `ucdp-events.cjs` | UCDP | Token header | ✅ Uses config.UCDP_ACCESS_TOKEN |
| `trade.cjs` | WTO | API key | ✅ Uses config.WTO_API_KEY |
| `markets.cjs` | Finnhub | API key | ✅ Uses config.FINNHUB_API_KEY |
| `oref.cjs` | OREF Proxy | Auth header | ✅ Uses config.OREF_PROXY_AUTH |

**Step 5: Document audit results**

```bash
git commit --allow-empty -m "audit: all worker channels verified — no other relay proxy usage"
```

---

## Task 7: Verify frontend WebSocket subscription (not HTTP)

Verify the frontend panel receives data exclusively via WebSocket, not HTTP polling.

**Files:**
- Read: `src/components/StrategicPosturePanel.ts`
- Read: `src/config/channel-registry.ts`

**Step 1: Verify channelKeys subscription**

`src/components/StrategicPosturePanel.ts` line 14:
```typescript
override readonly channelKeys = ['strategic-posture'];
```

**Step 2: Verify CHANNEL_REGISTRY mapping**

`src/config/channel-registry.ts` lines 350-358:
```typescript
'strategic-posture': {
  key: 'strategic-posture',
  redisKey: 'theater-posture:sebuf:v1',
  panels: ['strategic-posture'],
  domain: 'intelligence',
  staleAfterMs: 15 * 60_000,
  timeoutMs: 30_000,
  required: true,
},
```

No `applyMethod` — handled via Panel base class `applyPush()`, not DataLoader.

**Step 3: Verify gateway channel-keys.json**

`services/gateway/channel-keys.json` line 32:
```json
"strategic-posture": "theater-posture:sebuf:v1"
```

This maps the WebSocket channel name to the Redis key the gateway reads from on initial connect (`pushCurrentData`).

**Step 4: Verify refresh() is manual only**

`src/components/StrategicPosturePanel.ts` line 256:
```typescript
public async refresh(): Promise<void> {
```

Called only from button click handlers (lines 296, 316). No `setInterval` or automatic polling.

**Step 5: Verify gateway broadcast routing**

`services/gateway/index.cjs` line 584-600: Gateway gRPC `Broadcast` handler calls `handleBroadcast(channel, data, channelToClients)` which sends `{ type: 'wm-push', channel, data }` to all subscribed WebSocket clients.

Worker broadcasts with `service_key` = `'strategic-posture'` (worker/index.cjs line 103 + worker-runner.cjs line 68).

Full chain verified:
```
worker → grpcBroadcast('strategic-posture', result)
  → gateway Broadcast handler
  → handleBroadcast('strategic-posture', data, channelToClients)
  → ws.send({ type:'wm-push', channel:'strategic-posture', data, ts })
  → frontend Panel.applyPush()
```

---

## Task 8: Run all tests and verify build

**Step 1: Run strategic-posture and opensky tests**

```bash
node --test services/shared/channels/test/strategic-posture.test.cjs
node --test services/shared/channels/test/opensky.test.cjs
node --test services/shared/test/opensky-auth.test.cjs
```

Expected: All tests PASS

**Step 2: Run full test suite**

```bash
cd services && npm test
```

Expected: All tests PASS

**Step 3: Verify TypeScript build**

```bash
npm run build
```

Expected: No errors (changes are in CJS backend, TypeScript frontend unchanged)

**Step 4: Final commit**

```bash
git add -A
git commit -m "feat: strategic-posture direct OAuth2 — complete implementation and audit"
```

---

## Summary of changes

| File | Action | What changed |
|------|--------|-------------|
| `services/shared/opensky-auth.cjs` | CREATE | Shared OAuth2 helper (token fetch, cache, cooldown, retry) |
| `services/shared/test/opensky-auth.test.cjs` | CREATE | Tests for OAuth2 helper |
| `services/shared/channels/strategic-posture.cjs` | REWRITE | Removed relay proxy, uses direct OAuth2 |
| `services/shared/channels/test/strategic-posture.test.cjs` | REWRITE | Tests for direct OAuth2, no relay URL |
| `services/shared/channels/opensky.cjs` | MODIFY | Added OAuth2 Bearer token support |
| `services/shared/channels/test/opensky.test.cjs` | REWRITE | Tests for OAuth2 token in headers |
| `services/docker-compose.yml` | MODIFY | Remove `WS_RELAY_URL` from worker env |
