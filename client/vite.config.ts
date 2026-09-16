import { defineConfig, createLogger, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

/** JSONC のコメント除去 (server/src/config.ts と同等の簡易実装) */
function stripJsonComments(src: string): string {
  let out = '';
  let inStr = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === '*' && n === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inStr) {
      out += c;
      if (c === '\\') {
        out += n ?? '';
        i++;
      } else if (c === '"') {
        inStr = false;
      }
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === '/' && n === '/') {
      inLine = true;
      i++;
      continue;
    }
    if (c === '/' && n === '*') {
      inBlock = true;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

const jsoncPath = path.resolve(__dirname, '..', 'config.jsonc');
const jsonPath = path.resolve(__dirname, '..', 'config.json');
const config = JSON.parse(
  stripJsonComments(readFileSync(existsSync(jsoncPath) ? jsoncPath : jsonPath, 'utf-8')),
);

const serverHost = '127.0.0.1';
const serverOrigin = `http://${serverHost}:${config.port}`;

/**
 * API サーバが listen するまで /api リクエストを待たせる。
 * `npm run dev` では vite の方が先に立ち上がる (API 側は tsx の変換や DB 初期化で数秒かかる) ため、
 * 起動直後にブラウザがページを読み込むとプロキシが ECONNREFUSED → 空の 500 を返してしまい、
 * 画面に「サーバーに接続できません」が出る (--watch による再起動中も同様)。
 * リクエストごとに TCP 接続を試し、繋がるまで (上限あり) 待ってからプロキシへ渡すことで、
 * リクエストは失敗せず遅れて応答する形になる (ローカルへの接続確認なので通常時のコストは無視できる)。
 */
const API_WAIT_MAX_MS = 30_000;
const API_PROBE_INTERVAL_MS = 200;

const probeApiServer = () =>
  new Promise<boolean>((resolve) => {
    const sock = net.connect({ host: serverHost, port: config.port });
    sock.once('connect', () => {
      sock.destroy();
      resolve(true);
    });
    sock.once('error', () => resolve(false));
  });

async function waitForApiServer(): Promise<void> {
  const deadline = Date.now() + API_WAIT_MAX_MS;
  while (!(await probeApiServer())) {
    // 上限を超えたら諦めてプロキシに渡す (通常どおり接続エラーの応答になる)
    if (Date.now() > deadline) return;
    await new Promise((r) => setTimeout(r, API_PROBE_INTERVAL_MS));
  }
}

const waitForApiServerPlugin: Plugin = {
  name: 'wait-for-api-server',
  // configureServer で登録したミドルウェアは vite 内蔵のプロキシより前に実行される
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (!req.url?.startsWith('/api/')) {
        next();
        return;
      }
      void waitForApiServer().then(() => next());
    });
  },
};

/**
 * WS プロキシのログ抑制。
 * ブラウザがタブを閉じる/リロードすると WebSocket の TCP が RST で終わることがあり、
 * vite が "ws proxy error: ECONNRESET" を出す。切断は正常系で実害が無いうえ、
 * 本当のエラーが埋もれるのでこのケースだけログから除外する (プロキシ側の後始末は vite が行う)。
 */
const logger = createLogger();
const baseError = logger.error;
logger.error = (msg, opts) => {
  const code = (opts?.error as NodeJS.ErrnoException | undefined)?.code;
  if ((code === 'ECONNRESET' || code === 'EPIPE') && /ws proxy/.test(msg)) return;
  baseError(msg, opts);
};

export default defineConfig({
  plugins: [react(), waitForApiServerPlugin],
  customLogger: logger,
  define: {
    __APP_TOKEN__: JSON.stringify(config.token),
  },
  server: {
    host: '127.0.0.1',
    port: config.clientPort,
    proxy: {
      '/api': { target: serverOrigin, changeOrigin: false },
      '/ws': { target: serverOrigin, ws: true, changeOrigin: false },
    },
  },
});
