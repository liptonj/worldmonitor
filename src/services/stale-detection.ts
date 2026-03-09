/**
 * Periodic stale detection for channel data.
 *
 * Runs a check every minute to transition channels from `ready` to `stale`
 * when their data is older than the channel's `staleAfterMs` from the registry.
 *
 * @see docs/plans/2026-03-09-frontend-refactor.md Task 3.2
 */

import { CHANNEL_REGISTRY } from '@/config/channel-registry';
import { getChannelState, setChannelState } from '@/services/channel-state';

const STALE_CHECK_INTERVAL_MS = 60_000; // 1 minute

let staleCheckTimer: ReturnType<typeof setInterval> | null = null;

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
      setChannelState(channel, 'stale');
    }
  }
}

/**
 * Starts the periodic stale check. Safe to call multiple times (no-op if already running).
 */
export function startStaleDetection(): void {
  if (staleCheckTimer) return;
  staleCheckTimer = setInterval(runStaleCheck, STALE_CHECK_INTERVAL_MS);
}

/**
 * Stops the periodic stale check. Safe to call when not running.
 */
export function stopStaleDetection(): void {
  if (staleCheckTimer) {
    clearInterval(staleCheckTimer);
    staleCheckTimer = null;
  }
}
