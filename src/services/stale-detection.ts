/**
 * Periodic stale and timeout detection for channel data.
 *
 * - Stale: Runs every minute to transition channels from `ready` to `stale`
 *   when their data is older than the channel's `staleAfterMs` from the registry.
 * - Timeout: Runs every 5 seconds to transition channels from `loading` to `error`
 *   when they have been loading longer than the channel's `timeoutMs`.
 *
 * @see docs/plans/2026-03-09-frontend-refactor.md Task 3.2, Task 3.3
 */

import { CHANNEL_REGISTRY } from '@/config/channel-registry';
import { getChannelState, setChannelState } from '@/services/channel-state';

const STALE_CHECK_INTERVAL_MS = 60_000; // 1 minute
const TIMEOUT_CHECK_INTERVAL_MS = 5_000; // 5 seconds

const TIMEOUT_ERROR_MESSAGE = 'Service unavailable — data not received';

let staleCheckTimer: ReturnType<typeof setInterval> | null = null;
let timeoutCheckTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Runs one pass of stale detection.
 * For each channel in the registry, if state is `ready` and data is older
 * than `staleAfterMs`, transitions to `stale`.
 *
 * Exported for testing.
 */
export function runStaleCheck(): void {
  const now = Date.now();
  for (const [channel, def] of Object.entries(CHANNEL_REGISTRY)) {
    const status = getChannelState(channel);
    if (status.state !== 'ready' || status.lastDataAt === null) continue;
    const age = now - status.lastDataAt;
    if (age > def.staleAfterMs) {
      setChannelState(channel, 'stale', undefined, { lastDataAt: status.lastDataAt });
    }
  }
}

/**
 * Runs one pass of timeout detection.
 * For each channel in the registry that is `loading`, if it has been loading
 * longer than the channel's `timeoutMs`, transitions to `error`.
 *
 * Exported for testing.
 */
export function runTimeoutCheck(): void {
  const now = Date.now();
  for (const [channel, def] of Object.entries(CHANNEL_REGISTRY)) {
    const status = getChannelState(channel);
    if (status.state !== 'loading') continue;
    const startedAt = status.loadingStartedAt ?? now; // fallback for legacy state
    const elapsed = now - startedAt;
    if (elapsed > def.timeoutMs) {
      setChannelState(channel, 'error', undefined, { error: TIMEOUT_ERROR_MESSAGE });
    }
  }
}

/**
 * Starts the periodic stale and timeout checks. Safe to call multiple times (no-op if already running).
 * Runs an initial check immediately to surface stale/timeout data sooner.
 */
export function startStaleDetection(): void {
  if (staleCheckTimer) return;
  runStaleCheck();
  runTimeoutCheck();
  staleCheckTimer = setInterval(runStaleCheck, STALE_CHECK_INTERVAL_MS);
  timeoutCheckTimer = setInterval(runTimeoutCheck, TIMEOUT_CHECK_INTERVAL_MS);
}

/**
 * Stops the periodic stale and timeout checks. Safe to call when not running.
 */
export function stopStaleDetection(): void {
  if (staleCheckTimer) {
    clearInterval(staleCheckTimer);
    staleCheckTimer = null;
  }
  if (timeoutCheckTimer) {
    clearInterval(timeoutCheckTimer);
    timeoutCheckTimer = null;
  }
}
