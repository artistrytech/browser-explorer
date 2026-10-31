import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { attachTerminal, resizeTerminal, TERMINAL_INSTANCE, writeTerminal } from '../services/terminal.js';
import { errorDetail, logger, sanitizeId } from '../services/logger.js';

/**
 * ターミナルの入出力の中継 (/ws/terminal?token=&id=&instance=)。ターミナル 1 つにつき接続 1 本。
 * サーバ → クライアント: { t: 'r', d } 接続時の直近の出力 / { t: 'o', d } 出力 /
 *   { t: 'e', code } シェルの終了 / { t: 'x' } セッションが無い
 * クライアント → サーバ: { t: 'i', d } 入力 / { t: 's', cols, rows } 画面の大きさ
 */

const wss = new WebSocketServer({ noServer: true });
const LOCAL_HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

/** 任意のコマンドを実行できる接続なので、トークンに加えて Host / Origin も localhost に限る */
function isLocalRequest(req: IncomingMessage): boolean {
  if (!LOCAL_HOST_RE.test(req.headers.host ?? '')) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return LOCAL_HOST_RE.test(new URL(origin).host);
  } catch {
    return false;
  }
}

/** watcher.ts の upgrade から呼ぶ (トークンは確認済み) */
export function handleTerminalUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  if (!isLocalRequest(req)) {
    logger.warn('ws upgrade rejected: /ws/terminal (host / origin)', { event: 'ws' });
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, req));
}

function send(ws: WebSocket, msg: object): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function onConnection(ws: WebSocket, req: IncomingMessage): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const id = Number(url.searchParams.get('id'));
  const sessionId = sanitizeId(url.searchParams.get('session'));
  ws.on('error', (err) => {
    logger.warn(`terminal ws error: ${err.message}`, { event: 'ws', sessionId, detail: errorDetail(err) });
  });

  // 再起動前のサーバのターミナル (instance が違う) は、同じ id があってもつながない
  const attached =
    Number.isInteger(id) && url.searchParams.get('instance') === TERMINAL_INSTANCE
      ? attachTerminal(id, {
          output: (d) => send(ws, { t: 'o', d }),
          exit: (code) => {
            send(ws, { t: 'e', code });
            ws.close(1000);
          },
        })
      : null;
  if (!attached) {
    send(ws, { t: 'x' });
    ws.close(1000);
    return;
  }
  send(ws, { t: 'r', d: attached.scrollback });

  ws.on('message', (raw) => {
    let msg: { t?: unknown; d?: unknown; cols?: unknown; rows?: unknown };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.t === 'i' && typeof msg.d === 'string') writeTerminal(id, msg.d);
    else if (msg.t === 's') resizeTerminal(id, msg.cols, msg.rows);
  });
  ws.on('close', () => attached.detach());
}
