# Test Migration Status (Relay Push)

Status of tests after the frontend relay migration (Tasks 1–13). Tests were audited for polling-related patterns.

## Tests That Reference Polling / scheduleRefresh

| Test File | Reference | Status |
|-----------|-----------|--------|
| `relay-push-wiring.test.mjs` | `scheduleRefresh` | **Migration guard** — asserts App.ts does NOT call `scheduleRefresh`. Aligned with migration. |
| `zero-browser-api-calls.test.mjs` | `scheduleRefresh`, `RefreshScheduler` | **Migration guard** — asserts App.ts does not use polling. Aligned with migration. |
| `refresh-scheduler-deferred-registration.test.mjs` | `scheduleRefresh` | **Different domain** — tests `registerDeferred` in refresh-scheduler.ts, which internally calls `scheduleRefresh` for non-relay deferred registration. Not relay channel polling. |
| `ttl-acled-ais-guards.test.mjs` | `polling` | **Different domain** — Maritime AIS visibility guard (pause polling when tab hidden). Not relay-related. |

## Tests That Reference fetchRelayPanel

None. No tests mock or assert on `fetchRelayPanel`. It is used in production code for fallback loading only.

## Tests Already Updated / Removed (Task 12)

- Unused polling infrastructure was removed from `data-loader.ts`.
- No tests were removed; existing tests enforce migration invariants (no scheduleRefresh in App, no fetch in data-loader).

## Additional Test Updates Needed

**None.** Current tests are static analysis guards that verify:

- App.ts uses `initRelayPush` and `subscribe` from relay-push
- App.ts does not call `scheduleRefresh` or `loadAllData` for API fetches
- data-loader.ts has no direct `fetch()` calls
- Panels do not use ServiceClient (data arrives via relay push)

These remain valid post-migration.

## Future Work: WebSocket Mocking

If integration tests are added that exercise data flow end-to-end, WebSocket mocking may be needed. Example pattern (for future reference):

```typescript
// Example WebSocket mock pattern (for future reference)
jest.mock('@/services/relay-push', () => ({
  subscribe: jest.fn((channel, handler) => {
    setTimeout(() => handler({ data: 'mock' }), 100);
    return () => {}; // unsubscribe
  }),
  initRelayPush: jest.fn()
}));
```

No implementation required for current migration completion.
