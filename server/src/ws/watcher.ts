import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import chokidar, { FSWatcher } from 'chokidar';
import { norm } from '../services/fsService.js';
import { config } from '../config.js';

interface ClientState {
  watcher: FSWatcher | null;
  watchedPath: string | null;
}

const sockets = new Set<WebSocket>();

/** 接続中の全クライアントへイベントをプッシュする (clone 進捗等、§3.4) */
export function broadcastEvent(event: string, data: unknown): void {
  const msg = JSON.stringify({ event, data });
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

/**
 * WS 監視: クライアントは { type: 'watch', path } を送って表示中フォルダを購読する。
 * 変更があれば { event: 'fs:change', data: { type, path } } をプッシュする。
 */
export function attachWatcher(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Map<WebSocket, ClientState>();

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws' || url.searchParams.get('token') !== config.token) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    clients.set(ws, { watcher: null, watchedPath: null });
    sockets.add(ws);

    ws.on('message', async (raw) => {
      let msg: { type: string; path?: string };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      const state = clients.get(ws);
      if (!state) return;

      if (msg.type === 'watch' && msg.path) {
        if (state.watchedPath === msg.path) return;
        await state.watcher?.close().catch(() => {});
        state.watchedPath = msg.path;
        const watcher = chokidar.watch(msg.path, {
          depth: 0,
          ignoreInitial: true,
          persistent: true,
        });
        watcher.on('all', (event, p) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({ event: 'fs:change', data: { type: event, path: norm(p) } }),
            );
          }
        });
        watcher.on('error', () => {});
        state.watcher = watcher;
      } else if (msg.type === 'unwatch') {
        await state.watcher?.close().catch(() => {});
        state.watcher = null;
        state.watchedPath = null;
      }
    });

    ws.on('close', async () => {
      sockets.delete(ws);
      const state = clients.get(ws);
      await state?.watcher?.close().catch(() => {});
      clients.delete(ws);
    });
  });
}
