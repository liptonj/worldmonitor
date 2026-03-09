/**
 * Relay HTTP fetch helpers for bootstrap, panel, map layer, and RSS proxy data.
 * All data routes go through the relay server — never through Vercel API routes.
 */

const _env = (typeof import.meta !== 'undefined' && import.meta.env) || ({} as Record<string, string | undefined>);
export const RELAY_HTTP_BASE = _env.VITE_RELAY_HTTP_URL || 'https://relay.5ls.us';

/**
 * Builds a relay RSS proxy URL for the given feed URL.
 * Use this only for non-relay RSS feeds (e.g. government travel advisories, external news).
 * For relay channels, prefer fetchRelayPanel() + WebSocket push instead.
 */
export function relayRssUrl(feedUrl: string): string {
  return `${RELAY_HTTP_BASE}/rss?url=${encodeURIComponent(feedUrl)}`;
}

export function getRelayFetchHeaders(): HeadersInit {
  const token = _env.VITE_WS_RELAY_TOKEN as string | undefined;
  const headers: Record<string, string> = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

/** Fetch panel data from relay /panel/{channel}. Returns parsed JSON or null. */
export async function fetchRelayPanel<T = unknown>(channel: string): Promise<T | null> {
  try {
    const resp = await fetch(`${RELAY_HTTP_BASE}/panel/${channel}`, {
      signal: AbortSignal.timeout(10_000),
      headers: getRelayFetchHeaders(),
    });
    if (!resp.ok || resp.status === 204) return null;
    return (await resp.json()) as T;
  } catch {
    return null;
  }
}

/** Fetch map layer data from relay /map/{layer}. Returns parsed JSON or null. */
export async function fetchRelayMap<T = unknown>(layer: string): Promise<T | null> {
  try {
    const resp = await fetch(`${RELAY_HTTP_BASE}/map/${layer}`, {
      signal: AbortSignal.timeout(10_000),
      headers: getRelayFetchHeaders(),
    });
    if (!resp.ok || resp.status === 204) return null;
    return (await resp.json()) as T;
  } catch {
    return null;
  }
}
