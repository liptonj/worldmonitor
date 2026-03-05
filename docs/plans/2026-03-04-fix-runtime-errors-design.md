# Fix Runtime Errors: GDELT RPC + Analysis Worker Timeout

**Date:** 2026-03-04  
**Status:** Approved

## Problem

Three runtime errors observed in both dev and production:

1. **GDELT RPC "Parenthese... is not valid JSON"** — Redis path-based GET/SET rejects cache keys containing parentheses from GDELT queries. Additionally, GDELT may return non-JSON error responses that bypass the content-type guard.
2. **Analysis Worker timeout** — The worker must import heavy modules (`analysis-core`, `entity-extraction`, `ENTITY_REGISTRY`) before signaling readiness. The 10-second timeout is too tight for slow devices/networks, and there is no retry after failure.
3. **ML Worker content-length warning** — Harmless; `@xenova/transformers` handles missing `Content-Length` correctly. No fix needed.

## Design

### Fix 1: GDELT RPC — Deploy Redis fix + harden response parsing

**Redis (already written):** The `server/_shared/redis.ts` file already has uncommitted changes switching `getCachedJson` and `setCachedJson` from path-based URLs to pipeline POST. This avoids SRH path-routing issues with special characters. Commit these changes.

**GDELT response hardening:** In `search-gdelt-documents.ts`, wrap `response.json()` in a try/catch so that if GDELT returns invalid JSON despite a content-type that includes "json", the error is caught and a meaningful message is returned instead of a raw `JSON.parse` error.

### Fix 2: Analysis Worker — Lazy-load imports + increase timeout + retry

**Lazy-load heavy imports:** In `analysis.worker.ts`, send `{ type: 'ready' }` immediately when the worker script runs. Dynamically import `analysis-core` on the first `cluster` or `correlation` message.

**Increase timeout:** Raise `READY_TIMEOUT_MS` from 10s to 20s as a safety margin.

**Add retry:** On timeout, re-create the worker once before giving up. This handles transient slow loads.

**Add worker error handler:** Log `onerror` details in the worker itself so load failures are visible.

## Files Changed

| File | Change |
|------|--------|
| `server/_shared/redis.ts` | Commit existing pipeline POST changes |
| `server/worldmonitor/intelligence/v1/search-gdelt-documents.ts` | Wrap `response.json()` in try/catch |
| `src/workers/analysis.worker.ts` | Send ready immediately, lazy-load `analysis-core` |
| `src/services/analysis-worker.ts` | Increase timeout to 20s, add 1-retry logic |

## Out of Scope

- ML Worker content-length warning (harmless, upstream library behavior)
- Performance optimization of `analysis-core` imports (separate effort)
