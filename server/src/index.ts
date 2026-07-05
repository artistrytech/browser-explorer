import express, { NextFunction, Request, Response } from 'express';
import http from 'node:http';
import { config } from './config.js';
import { fsRouter } from './routes/fs.js';
import { gitRouter } from './routes/git.js';
import { stateRouter } from './routes/state.js';
import { attachWatcher } from './ws/watcher.js';

const app = express();
app.use(express.json({ limit: '50mb' }));

/**
 * セキュリティガード (plan §2.2)
 * - 127.0.0.1 のみで待受 (listen 時)
 * - Host / Origin 検証: localhost 以外からの API 呼び出しを拒否 (DNS リバインディング対策)
 * - セッショントークン必須: フロントに埋め込んだトークンを全 API に要求 (CSRF 対策)
 */
const LOCAL_HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

app.use('/api', (req: Request, res: Response, next: NextFunction) => {
  const host = req.headers.host ?? '';
  if (!LOCAL_HOST_RE.test(host)) {
    res.status(403).json({ error: 'forbidden', message: 'invalid host' });
    return;
  }
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (!LOCAL_HOST_RE.test(new URL(origin).host)) {
        res.status(403).json({ error: 'forbidden', message: 'invalid origin' });
        return;
      }
    } catch {
      res.status(403).json({ error: 'forbidden', message: 'invalid origin' });
      return;
    }
  }
  if (req.headers['x-app-token'] !== config.token) {
    res.status(401).json({ error: 'unauthorized', message: 'invalid token' });
    return;
  }
  next();
});

app.use('/api/fs', fsRouter);
app.use('/api/git', gitRouter);
app.use('/api/state', stateRouter);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, platform: process.platform });
});

// エラーハンドラ: 種別付き JSON で返す (plan §10)
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error & { status?: number; code?: string }, _req: Request, res: Response, _next: NextFunction) => {
  const status =
    err.status ??
    (err.code === 'ENOENT' ? 404 : err.code === 'EACCES' || err.code === 'EPERM' ? 403 : 500);
  res.status(status).json({
    error: err.code ?? 'internal',
    message: err.message,
  });
});

const server = http.createServer(app);
attachWatcher(server);

server.listen(config.port, config.host, () => {
  console.log(`[server] listening on http://${config.host}:${config.port}`);
});
