import { APP_TOKEN } from './client';

export interface FsChangeEvent {
  type: string;
  path: string;
}

type Listener = (e: FsChangeEvent) => void;
type EventListener = (data: unknown) => void;

let socket: WebSocket | null = null;
let watchedPath: string | null = null;
const listeners = new Set<Listener>();
const eventListeners = new Map<string, Set<EventListener>>();

function connect(): WebSocket {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?token=${APP_TOKEN}`);
  ws.onopen = () => {
    if (watchedPath) ws.send(JSON.stringify({ type: 'watch', path: watchedPath }));
  };
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data as string);
      if (msg.event === 'fs:change') {
        for (const l of listeners) l(msg.data as FsChangeEvent);
      } else if (typeof msg.event === 'string') {
        for (const l of eventListeners.get(msg.event) ?? []) l(msg.data);
      }
    } catch {
      /* ignore */
    }
  };
  ws.onclose = () => {
    socket = null;
    setTimeout(() => {
      if (!socket) socket = connect();
    }, 2000);
  };
  return ws;
}

export function watchPath(path: string): void {
  watchedPath = path;
  if (!socket) socket = connect();
  else if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'watch', path }));
  }
}

export function onFsChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** fs:change 以外のサーバープッシュ (git:clone-progress 等) を購読する */
export function onWsEvent(event: string, listener: EventListener): () => void {
  if (!socket) socket = connect();
  if (!eventListeners.has(event)) eventListeners.set(event, new Set());
  eventListeners.get(event)!.add(listener);
  return () => eventListeners.get(event)?.delete(listener);
}
