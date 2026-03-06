/**
 * Singleton WebSocket client that connects to the relay, subscribes to
 * typed data channels, and dispatches payloads to registered handler functions.
 */

type ChannelHandler = (payload: unknown) => void;

const handlers = new Map<string, Set<ChannelHandler>>();
let socket: WebSocket | null = null;
let subscribedChannels: string[] = [];
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelayMs = 2_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const STALE_THRESHOLD_MS = 30_000;
let destroyed = false;
let relayUrl = '';
let lastMessageAt = 0;

export function subscribe(channel: string, handler: ChannelHandler): () => void {
  if (!handlers.has(channel)) handlers.set(channel, new Set());
  handlers.get(channel)!.add(handler);
  return () => handlers.get(channel)?.delete(handler);
}

function dispatch(channel: string, payload: unknown): void {
  const channelHandlers = handlers.get(channel);
  if (!channelHandlers) return;
  for (const h of channelHandlers) {
    try {
      h(payload);
    } catch (err) {
      console.error(`[relay-push] handler error (${channel}):`, err);
    }
  }
}

function sendSubscribe(): void {
  if (!socket || socket.readyState !== WebSocket.OPEN || subscribedChannels.length === 0) return;
  socket.send(JSON.stringify({ type: 'wm-subscribe', channels: subscribedChannels }));
}

function scheduleReconnect(relayWsUrl: string): void {
  if (destroyed || reconnectTimer) return;
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!destroyed) connect(relayWsUrl, subscribedChannels);
  }, reconnectDelayMs);
}

function connect(relayWsUrl: string, channels: string[]): void {
  if (destroyed) return;
  subscribedChannels = channels;

  try {
    socket = new WebSocket(relayWsUrl);
  } catch {
    scheduleReconnect(relayWsUrl);
    return;
  }

  socket.addEventListener('open', () => {
    reconnectDelayMs = 2_000;
    console.log('[relay-push] connected, subscribing to', subscribedChannels);
    sendSubscribe();
  });

  socket.addEventListener('message', (event) => {
    lastMessageAt = Date.now();
    const raw = typeof event.data === 'string' ? event.data : '';
    if (!raw) return;
    try {
      const msg = JSON.parse(raw) as Record<string, unknown>;
      if (msg.type === 'wm-push' && typeof msg.channel === 'string') {
        dispatch(msg.channel, msg.payload);
      }
    } catch {
      console.warn('[relay-push] received unparseable message');
    }
  });

  socket.addEventListener('close', () => {
    socket = null;
    if (!destroyed) scheduleReconnect(relayWsUrl);
  });

  socket.addEventListener('error', () => {
    socket?.close();
  });
}

function forceReconnect(): void {
  if (destroyed || !relayUrl) return;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (socket) {
    try { socket.close(); } catch {}
    socket = null;
  }
  reconnectDelayMs = 2_000;
  connect(relayUrl, subscribedChannels);
}

function isConnectionStale(): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) return true;
  return lastMessageAt > 0 && Date.now() - lastMessageAt > STALE_THRESHOLD_MS;
}

function handleVisibilityChange(): void {
  if (destroyed || document.hidden) return;
  if (isConnectionStale()) {
    console.log('[relay-push] tab visible, connection stale — reconnecting');
    forceReconnect();
  } else if (socket?.readyState === WebSocket.OPEN) {
    sendSubscribe();
  }
}

export function initRelayPush(channels: string[]): void {
  const relayWsUrl = import.meta.env.VITE_WS_RELAY_URL as string | undefined;
  if (!relayWsUrl) {
    console.warn('[relay-push] VITE_WS_RELAY_URL not set — push disabled, polling fallback active');
    return;
  }
  if (socket) return;
  destroyed = false;

  const wsToken = import.meta.env.VITE_WS_RELAY_TOKEN as string | undefined;
  let url = relayWsUrl;
  if (wsToken) {
    const sep = relayWsUrl.includes('?') ? '&' : '?';
    url = `${relayWsUrl}${sep}token=${encodeURIComponent(wsToken)}`;
  }
  relayUrl = url;
  document.addEventListener('visibilitychange', handleVisibilityChange);
  connect(url, channels);
}

export function destroyRelayPush(): void {
  destroyed = true;
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  socket?.close();
  socket = null;
  handlers.clear();
}

export function isRelayConnected(): boolean {
  return socket?.readyState === WebSocket.OPEN;
}

/** For tests only: simulate an incoming wm-push message. */
export function dispatchForTesting(channel: string, payload: unknown): void {
  dispatch(channel, payload);
}
