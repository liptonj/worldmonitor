# Phase 10: Admin Portal Relay Services

The admin portal can query and trigger relay services via two Supabase RPC functions.

## RPC Functions

### 1. `wm_admin.get_relay_service_statuses()`

Returns the status of all relay services.

**Returns:** Table with columns:

| Column | Type | Description |
|--------|------|-------------|
| `service_key` | TEXT | Service identifier |
| `enabled` | BOOLEAN | Whether the service is enabled |
| `cron_schedule` | TEXT | Cron expression |
| `last_run_at` | TIMESTAMPTZ | Last run timestamp |
| `last_status` | TEXT | `ok` or `error` |
| `last_error` | TEXT | Error message if failed |
| `consecutive_failures` | INTEGER | Current failure count |
| `max_consecutive_failures` | INTEGER | Threshold before alert |
| `alert_on_failure` | BOOLEAN | Whether to send alerts |
| `description` | TEXT | Human-readable description |

### 2. `wm_admin.trigger_relay_service(p_service_key TEXT)`

Manually triggers a service. The orchestrator picks up the request via Realtime and runs the service.

**Parameters:** `p_service_key` — e.g. `markets`, `ai:intel-digest`

**Returns:** UUID of the trigger request. The admin portal can optionally poll `trigger_requests` for completion.

## Calling from the Admin Portal

### List services

```typescript
const { data, error } = await supabase
  .schema('wm_admin')
  .rpc('get_relay_service_statuses');
// data: Array<{ service_key, enabled, cron_schedule, last_run_at, ... }>
```

### Trigger a service

```typescript
const { data, error } = await supabase
  .schema('wm_admin')
  .rpc('trigger_relay_service', { p_service_key: 'markets' });
// data: UUID (trigger request id)
```

## Expected Data Shape

`get_relay_service_statuses` returns an array of objects:

```json
[
  {
    "service_key": "markets",
    "enabled": true,
    "cron_schedule": "*/5 * * * *",
    "last_run_at": "2026-03-07T12:00:00Z",
    "last_status": "ok",
    "last_error": null,
    "consecutive_failures": 0,
    "max_consecutive_failures": 5,
    "alert_on_failure": true,
    "description": "Polymarket dashboard data"
  }
]
```

## Permissions

Both RPCs are granted to `authenticated`. Restrict the admin portal UI to admin users; the RPCs run as `SECURITY DEFINER` and bypass RLS.
