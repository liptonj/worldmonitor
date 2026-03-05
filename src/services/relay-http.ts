/**
 * Relay HTTP fetch helpers for bootstrap, panel, and map layer data.
 * Used when frontend fetches directly from relay.5ls.us instead of Vercel.
 */

export const RELAY_HTTP_BASE = import.meta.env.VITE_RELAY_HTTP_URL || 'https://relay.5ls.us';

export function getRelayFetchHeaders(): HeadersInit {
  const token = import.meta.env.VITE_WS_RELAY_TOKEN as string | undefined;
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
