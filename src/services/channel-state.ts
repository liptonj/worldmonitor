/**
 * Channel Data State Machine
 *
 * Tracks whether each channel is idle, loading, ready, stale, or errored.
 * Panels can subscribe to state changes and show appropriate UI (loading spinner,
 * data, stale warning, or error message).
 *
 * This module does not integrate with bootstrap/WebSocket/HTTP — that wiring
 * happens in Task 3.2. It provides the state storage and subscription API only.
 *
 * @see docs/plans/2026-03-09-frontend-refactor.md
 */

/** Possible states for a channel's data. */
export type ChannelState = 'idle' | 'loading' | 'ready' | 'stale' | 'error';

/** Source that last updated the channel data. */
export type ChannelSource = 'bootstrap' | 'websocket' | 'http-fallback';

/** Status snapshot for a channel. */
export interface ChannelStatus {
  state: ChannelState;
  lastDataAt: number | null;
  error: string | null;
  source: ChannelSource | null;
}

/** Default status for a channel that has never been touched. */
const DEFAULT_STATUS: ChannelStatus = {
  state: 'idle',
  lastDataAt: null,
  error: null,
  source: null,
};

/** Internal storage: channel key → current status. */
const channelStates = new Map<string, ChannelStatus>();

/** Subscribers per channel: channel key → Set of callbacks. */
const subscribers = new Map<string, Set<(status: ChannelStatus) => void>>();

/** Valid source values for type narrowing. */
const VALID_SOURCES: ChannelSource[] = ['bootstrap', 'websocket', 'http-fallback'];

function isValidSource(s: string | undefined): s is ChannelSource {
  return s !== undefined && VALID_SOURCES.includes(s as ChannelSource);
}

function copyStatus(s: ChannelStatus): ChannelStatus {
  return { ...s };
}

/**
 * Sets the state for a channel and notifies all subscribers.
 *
 * When transitioning to `error` without providing `options.error`, defaults to `"Unknown error"`.
 *
 * **Re-entrancy:** Subscribers must not call `setChannelState` (or `subscribeChannelState` for
 * the same channel) from within their callback; behavior is undefined if they do.
 *
 * @param channel - Channel key (e.g. 'markets', 'fred')
 * @param state - New state to set
 * @param source - Optional source that produced this state (bootstrap, websocket, http-fallback)
 * @param options - Optional overrides: lastDataAt (timestamp), error (message)
 */
export function setChannelState(
  channel: string,
  state: ChannelState,
  source?: string,
  options?: { lastDataAt?: number; error?: string | null }
): void {
  const prev = channelStates.get(channel) ?? { ...DEFAULT_STATUS };
  const next: ChannelStatus = {
    state,
    lastDataAt: options?.lastDataAt ?? (state === 'ready' || state === 'stale' ? Date.now() : prev.lastDataAt),
    error:
      options?.error !== undefined
        ? options.error
        : state === 'error'
          ? prev.error ?? 'Unknown error'
          : null,
    source: isValidSource(source) ? source : prev.source,
  };
  channelStates.set(channel, next);

  const subs = subscribers.get(channel);
  if (subs) {
    for (const cb of subs) {
      cb(copyStatus(next));
    }
  }
}

/**
 * Gets the current status for a channel.
 * Returns the default idle status if the channel has never been set.
 * Returns a shallow copy so callers cannot mutate internal state.
 *
 * @param channel - Channel key
 * @returns Current ChannelStatus (never undefined)
 */
export function getChannelState(channel: string): ChannelStatus {
  const stored = channelStates.get(channel) ?? { ...DEFAULT_STATUS };
  return copyStatus(stored);
}

/**
 * Clears all channel state and subscriptions. For use in tests only.
 *
 * @internal
 */
export function resetChannelState(): void {
  channelStates.clear();
  subscribers.clear();
}

/**
 * Subscribes to state changes for a channel.
 * The callback is invoked immediately with the current status, then on every subsequent change.
 *
 * **Re-entrancy:** The callback must not call `setChannelState` or `subscribeChannelState` for
 * the same channel; behavior is undefined if it does.
 *
 * @param channel - Channel key
 * @param cb - Callback invoked with the new status whenever it changes
 * @returns Unsubscribe function. Call to stop receiving updates.
 */
export function subscribeChannelState(
  channel: string,
  cb: (status: ChannelStatus) => void
): () => void {
  let subs = subscribers.get(channel);
  if (!subs) {
    subs = new Set();
    subscribers.set(channel, subs);
  }
  subs.add(cb);

  // Fire immediately with current state
  cb(getChannelState(channel));

  return () => {
    subs!.delete(cb);
    if (subs!.size === 0) {
      subscribers.delete(channel);
    }
  };
}
