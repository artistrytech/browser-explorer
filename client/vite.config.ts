import { defineConfig, createLogger } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, existsSync } from 'node:fs';
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

const serverOrigin = `http://127.0.0.1:${config.port}`;

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
  plugins: [react()],
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
