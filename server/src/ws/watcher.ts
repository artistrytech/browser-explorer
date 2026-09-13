import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import chokidar, { FSWatcher } from 'chokidar';
import { norm } from '../services/fsService.js';
import { config } from '../config.js';
import { errorDetail, logger, sanitizeId } from '../services/logger.js';

interface ClientState {
  watcher: FSWatcher | null;
  watchedPath: string | null;
  /** クライアント (ブラウザのタブ) のセッション ID (?session=)。ログの紐づけ用 */
  sessionId: string | null;
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
    // 切断 (ECONNRESET 等) で未処理の 'error' が投げられないようにしておく
    socket.on('error', () => {});
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws' || url.searchParams.get('token') !== config.token) {
      logger.warn(`ws upgrade rejected: ${url.pathname}`, { event: 'ws' });
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    const sessionId = sanitizeId(new URL(req.url ?? '/', 'http://localhost').searchParams.get('session'));
    clients.set(ws, { watcher: null, watchedPath: null, sessionId });
    sockets.add(ws);
    logger.debug('ws connected', { event: 'ws', sessionId });
    // クライアントが切断すると 'error' が飛ぶことがある。リスナが無いと例外になるため受けておく
    ws.on('error', (err) => {
      logger.warn(`ws error: ${err.message}`, { event: 'ws', sessionId, detail: errorDetail(err) });
    });

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
        watcher.on('error', (err) => {
          logger.warn(`fs watcher error (${msg.path}): ${err instanceof Error ? err.message : String(err)}`, {
            event: 'watcher',
            sessionId: state.sessionId,
            detail: { path: msg.path, ...errorDetail(err) },
          });
        });
        state.watcher = watcher;
      } else if (msg.type === 'unwatch') {
        await state.watcher?.close().catch(() => {});
        state.watcher = null;
        state.watchedPath = null;
      }
    });

    ws.on('close', async (code) => {
      sockets.delete(ws);
      const state = clients.get(ws);
      logger.debug(`ws closed (${code})`, { event: 'ws', sessionId: state?.sessionId ?? sessionId });
      await state?.watcher?.close().catch(() => {});
      clients.delete(ws);
    });
  });
}
