import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import chokidar, { FSWatcher } from 'chokidar';
import { norm } from '../services/fsService.js';
import { config } from '../config.js';
import { errorDetail, logger, sanitizeId } from '../services/logger.js';
import { handleTerminalUpgrade } from './terminal.js';
import { resolveGitDirs, watchGitDir, type GitDirWatch } from './gitWatcher.js';

interface ClientState {
  watcher: FSWatcher | null;
  watchedPath: string | null;
  /** 表示中フォルダが属するリポジトリの .git の監視 (リポジトリ外なら null) */
  gitWatch: GitDirWatch | null;
  /** watch 要求の世代番号 (.git の解決を待つ間に次の watch が来たら古い結果を捨てる) */
  watchSeq: number;
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
 * フォルダがリポジトリ配下なら .git も監視し、変化があれば { event: 'git:change', data: { root } } をプッシュする
 * (AI・ターミナルによる git add / commit 等を Git ステータスへすぐ反映するため)。
 */
export function attachWatcher(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Map<WebSocket, ClientState>();

  server.on('upgrade', (req, socket, head) => {
    // 切断 (ECONNRESET 等) で未処理の 'error' が投げられないようにしておく
    socket.on('error', () => {});
    const url = new URL(req.url ?? '/', 'http://localhost');
    const isTerminal = url.pathname === '/ws/terminal';
    if ((url.pathname !== '/ws' && !isTerminal) || url.searchParams.get('token') !== config.token) {
      logger.warn(`ws upgrade rejected: ${url.pathname}`, { event: 'ws' });
      socket.destroy();
      return;
    }
    // ターミナルの入出力は専用の接続 (ws/terminal.ts)
    if (isTerminal) {
      handleTerminalUpgrade(req, socket, head);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    const sessionId = sanitizeId(new URL(req.url ?? '/', 'http://localhost').searchParams.get('session'));
    clients.set(ws, { watcher: null, watchedPath: null, gitWatch: null, watchSeq: 0, sessionId });
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
        void updateGitWatch(ws, state, msg.path);
      } else if (msg.type === 'unwatch') {
        state.watchSeq++;
        await state.watcher?.close().catch(() => {});
        await state.gitWatch?.close();
        state.watcher = null;
        state.gitWatch = null;
        state.watchedPath = null;
      }
    });

    ws.on('close', async (code) => {
      sockets.delete(ws);
      const state = clients.get(ws);
      logger.debug(`ws closed (${code})`, { event: 'ws', sessionId: state?.sessionId ?? sessionId });
      if (state) state.watchSeq++;
      await state?.watcher?.close().catch(() => {});
      await state?.gitWatch?.close();
      clients.delete(ws);
    });
  });
}

/** 表示中フォルダが属するリポジトリの .git の監視を張り替える (同じ .git なら張ったまま) */
async function updateGitWatch(ws: WebSocket, state: ClientState, dirPath: string): Promise<void> {
  const seq = ++state.watchSeq;
  const dirs = await resolveGitDirs(dirPath);
  // 待っている間に次の watch / unwatch / 切断があった
  if (seq !== state.watchSeq) return;
  // 同じリポジトリ内の移動なら既存の監視をそのまま使う
  if (dirs && state.gitWatch?.gitDir === dirs.gitDir) return;
  await state.gitWatch?.close();
  state.gitWatch = null;
  if (!dirs) return;
  state.gitWatch = watchGitDir(
    dirs,
    (root) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event: 'git:change', data: { root } }));
    },
    (err) => {
      logger.warn(`git dir watcher error (${dirs.gitDir}): ${err instanceof Error ? err.message : String(err)}`, {
        event: 'watcher',
        sessionId: state.sessionId,
        detail: { path: dirs.gitDir, ...errorDetail(err) },
      });
    },
  );
}
