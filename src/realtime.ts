import type { ClientMessage, ServerMessage } from './protocol';

type RealtimeOptions = {
  role: 'board' | 'controls';
  onMessage: (message: ServerMessage) => void;
  onConnectionChange?: (connected: boolean) => void;
};

export type RealtimeClient = {
  send: (message: ClientMessage) => void;
  close: () => void;
};

export function connectRealtime(options: RealtimeOptions): RealtimeClient {
  let socket: WebSocket | null = null;
  let retryTimer: number | null = null;
  let closed = false;
  const queued: ClientMessage[] = [];

  const connect = (): void => {
    if (closed) return;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${protocol}//${window.location.host}/ws`);

    socket.addEventListener('open', () => {
      socket?.send(JSON.stringify({ type: 'hello', role: options.role } satisfies ClientMessage));
      queued.splice(0).forEach((message) => socket?.send(JSON.stringify(message)));
      options.onConnectionChange?.(true);
    });

    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      try { options.onMessage(JSON.parse(event.data) as ServerMessage); }
      catch (error) { console.warn('Ignored an invalid server message.', error); }
    });

    socket.addEventListener('close', () => {
      socket = null;
      options.onConnectionChange?.(false);
      if (!closed) retryTimer = window.setTimeout(connect, 1500);
    });

    socket.addEventListener('error', () => socket?.close());
  };

  connect();

  return {
    send(message) {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
      else if (message.type !== 'hello') queued.push(message);
    },
    close() {
      closed = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      socket?.close();
    },
  };
}
