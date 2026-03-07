'use strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'test-anon-key';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildTriggerRequest,
  shouldRouteToAiEngine,
  updateServiceStatus,
  triggerService,
  scheduleCronJobs,
} = require('../index.cjs');

describe('shouldRouteToAiEngine', () => {
  it('returns true for ai: prefix', () => {
    assert.equal(shouldRouteToAiEngine('ai:intel-digest'), true);
    assert.equal(shouldRouteToAiEngine('ai:panel-summary'), true);
  });

  it('returns false for non-ai keys', () => {
    assert.equal(shouldRouteToAiEngine('markets'), false);
    assert.equal(shouldRouteToAiEngine('news:full'), false);
  });

  it('returns false for invalid input', () => {
    assert.equal(shouldRouteToAiEngine(null), false);
    assert.equal(shouldRouteToAiEngine(123), false);
  });
});

describe('buildTriggerRequest', () => {
  it('builds request from service config', () => {
    const cfg = {
      service_key: 'markets',
      redis_key: 'market:dashboard:v1',
      ttl_seconds: 300,
      settings: { foo: 'bar' },
      fetch_type: 'custom',
    };
    const req = buildTriggerRequest(cfg);
    assert.equal(req.serviceKey, 'markets');
    assert.equal(req.redisKey, 'market:dashboard:v1');
    assert.equal(req.ttlSeconds, 300);
    assert.equal(req.settingsJson, '{"foo":"bar"}');
    assert.equal(req.fetchType, 'custom');
  });

  it('handles missing optional fields', () => {
    const cfg = { service_key: 'x', redis_key: '', fetch_type: 'custom' };
    const req = buildTriggerRequest(cfg);
    assert.equal(req.redisKey, '');
    assert.equal(req.ttlSeconds, 600);
    assert.equal(req.settingsJson, '{}');
  });
});

describe('updateServiceStatus', () => {
  it('calls supabase update with correct payload', async () => {
    const updates = [];
    const mockSupabase = {
      schema: () => ({
        from: () => ({
          update: (data) => {
            updates.push(data);
            return { eq: () => ({ error: null }) };
          },
        }),
      }),
    };

    await updateServiceStatus(mockSupabase, 'markets', {
      status: 'ok',
      duration_ms: 100,
      consecutive_failures: 0,
    });

    assert.equal(updates.length, 1);
    assert.equal(updates[0].last_status, 'ok');
    assert.equal(updates[0].last_duration_ms, 100);
    assert.equal(updates[0].consecutive_failures, 0);
  });

  it('sets consecutive_failures from result on error', async () => {
    const updates = [];
    const mockSupabase = {
      schema: () => ({
        from: () => ({
          update: (data) => {
            updates.push(data);
            return { eq: () => ({ error: null }) };
          },
        }),
      }),
    };

    await updateServiceStatus(mockSupabase, 'markets', {
      status: 'error',
      duration_ms: 50,
      error: 'gRPC failed',
      consecutive_failures: 3,
    });

    assert.equal(updates[0].consecutive_failures, 3);
    assert.equal(updates[0].last_error, 'gRPC failed');
  });
});

describe('triggerService', () => {
  const workerClient = { _marker: 'worker' };
  const aiEngineClient = { _marker: 'ai-engine' };

  it('routes ai: keys to ai-engine client', async () => {
    let capturedClient = null;
    const executeFn = async (client) => {
      capturedClient = client;
      return { status: 'ok', duration_ms: 1 };
    };

    const mockSupabase = {
      schema: () => ({
        from: () => ({
          update: () => ({ eq: () => ({ error: null }) }),
        }),
      }),
    };

    const cfg = {
      service_key: 'ai:intel-digest',
      redis_key: 'ai:digest:v1',
      ttl_seconds: 600,
      fetch_type: 'custom',
      settings: {},
    };

    await triggerService(mockSupabase, cfg, workerClient, aiEngineClient, null, executeFn);
    assert.equal(capturedClient._marker, 'ai-engine');
  });

  it('routes non-ai keys to worker client', async () => {
    let capturedClient = null;
    const executeFn = async (client) => {
      capturedClient = client;
      return { status: 'ok', duration_ms: 1 };
    };

    const mockSupabase = {
      schema: () => ({
        from: () => ({
          update: () => ({ eq: () => ({ error: null }) }),
        }),
      }),
    };

    const cfg = {
      service_key: 'markets',
      redis_key: 'market:dashboard:v1',
      ttl_seconds: 300,
      fetch_type: 'custom',
      settings: {},
    };

    await triggerService(mockSupabase, cfg, workerClient, aiEngineClient, null, executeFn);
    assert.equal(capturedClient._marker, 'worker');
  });

  it('increments consecutive_failures on gRPC error', async () => {
    const executeFn = async () => {
      throw new Error('gRPC connection refused');
    };

    const updates = [];
    const mockSupabase = {
      schema: () => ({
        from: () => ({
          update: (data) => {
            updates.push(data);
            return { eq: () => ({ error: null }) };
          },
        }),
      }),
    };

    const cfg = {
      service_key: 'markets',
      redis_key: 'market:dashboard:v1',
      ttl_seconds: 300,
      fetch_type: 'custom',
      settings: {},
      consecutive_failures: 2,
    };

    await triggerService(mockSupabase, cfg, workerClient, aiEngineClient, null, executeFn);

    assert.equal(updates.length, 1);
    assert.equal(updates[0].consecutive_failures, 3);
    assert.equal(updates[0].last_status, 'error');
  });

  it('passes triggerId to execute when triggerRequestId is provided', async () => {
    let capturedReq = null;
    const executeFn = async (client, req) => {
      capturedReq = req;
      return { status: 'ok', duration_ms: 1 };
    };

    const mockSupabase = {
      schema: () => ({
        from: () => ({
          update: () => ({ eq: () => ({ error: null }) }),
        }),
      }),
    };

    const cfg = {
      service_key: 'markets',
      redis_key: 'market:dashboard:v1',
      ttl_seconds: 300,
      fetch_type: 'custom',
      settings: {},
    };

    await triggerService(mockSupabase, cfg, workerClient, aiEngineClient, 'req-uuid-123', executeFn);

    assert.equal(capturedReq.triggerId, 'req-uuid-123');
  });

  it('updates trigger_requests when triggerRequestId is provided', async () => {
    const executeFn = async () => ({ status: 'ok', duration_ms: 20 });
    const triggerUpdates = [];
    const serviceUpdates = [];

    const mockSupabase = {
      schema: () => ({
        from: (table) => ({
          update: (data) => {
            if (table === 'trigger_requests') triggerUpdates.push(data);
            else serviceUpdates.push(data);
            return { eq: () => ({ error: null }) };
          },
        }),
      }),
    };

    const cfg = {
      service_key: 'markets',
      redis_key: 'market:dashboard:v1',
      ttl_seconds: 300,
      fetch_type: 'custom',
      settings: {},
      consecutive_failures: 0,
    };

    await triggerService(mockSupabase, cfg, workerClient, aiEngineClient, 'req-uuid-123', executeFn);

    assert.equal(triggerUpdates.length, 1);
    assert.equal(triggerUpdates[0].status, 'completed');
    assert.ok(triggerUpdates[0].completed_at);
    assert.ok(triggerUpdates[0].result);
  });

  it('resets consecutive_failures on success', async () => {
    const executeFn = async () => ({ status: 'ok', duration_ms: 10 });

    const updates = [];
    const mockSupabase = {
      schema: () => ({
        from: () => ({
          update: (data) => {
            updates.push(data);
            return { eq: () => ({ error: null }) };
          },
        }),
      }),
    };

    const cfg = {
      service_key: 'markets',
      redis_key: 'market:dashboard:v1',
      ttl_seconds: 300,
      fetch_type: 'custom',
      settings: {},
      consecutive_failures: 3,
    };

    await triggerService(mockSupabase, cfg, workerClient, aiEngineClient, null, executeFn);

    assert.equal(updates.length, 1);
    assert.equal(updates[0].consecutive_failures, 0);
    assert.equal(updates[0].last_status, 'ok');
  });
  it('sets trigger_requests to failed when gRPC throws and triggerRequestId provided', async () => {
    const executeFn = async () => {
      throw new Error('gRPC timeout');
    };
    const triggerUpdates = [];
    const serviceUpdates = [];

    const mockSupabase = {
      schema: () => ({
        from: (table) => ({
          update: (data) => {
            if (table === 'trigger_requests') triggerUpdates.push(data);
            else serviceUpdates.push(data);
            return { eq: () => ({ error: null }) };
          },
        }),
      }),
    };

    const cfg = {
      service_key: 'markets',
      redis_key: 'market:dashboard:v1',
      ttl_seconds: 300,
      fetch_type: 'custom',
      settings: {},
      consecutive_failures: 0,
    };

    await triggerService(mockSupabase, cfg, workerClient, aiEngineClient, 'req-uuid-fail', executeFn);

    assert.equal(triggerUpdates.length, 1);
    assert.equal(triggerUpdates[0].status, 'failed');
    assert.ok(triggerUpdates[0].completed_at);
  });
});

describe('scheduleCronJobs / config reload', () => {
  it('returns 0 when loadServiceConfigs returns empty array', async () => {
    const jobsRef = { current: [] };
    const mockSupabase = {
      schema: () => ({
        from: () => ({
          select: () => ({
            eq: () => Promise.resolve({ data: [], error: null }),
          }),
        }),
      }),
    };
    const count = await scheduleCronJobs(mockSupabase, {}, {}, jobsRef);
    assert.equal(count, 0);
    assert.equal(jobsRef.current.length, 0);
  });

  it('clears existing jobs and rebuilds from fresh DB read', async () => {
    const jobsRef = { current: [] };
    const workerClient = {};
    const aiEngineClient = {};

    const mockSupabase = {
      schema: () => ({
        from: () => ({
          select: () => ({
            eq: () =>
              Promise.resolve({
                data: [
                  {
                    service_key: 'markets',
                    cron_schedule: '*/5 * * * *',
                    redis_key: 'market:v1',
                    ttl_seconds: 300,
                    fetch_type: 'custom',
                    enabled: true,
                  },
                ],
                error: null,
              }),
          }),
        }),
      }),
    };

    const count1 = await scheduleCronJobs(mockSupabase, workerClient, aiEngineClient, jobsRef);
    assert.equal(count1, 1);
    assert.equal(jobsRef.current.length, 1);

    const count2 = await scheduleCronJobs(mockSupabase, workerClient, aiEngineClient, jobsRef);
    assert.equal(count2, 1);
    assert.equal(jobsRef.current.length, 1);

    jobsRef.current.forEach((j) => j.stop());
    jobsRef.current = [];
  });
});
