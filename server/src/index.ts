import express, { NextFunction, Request, Response } from 'express';
import http from 'node:http';
import { config } from './config.js';
import { fsRouter } from './routes/fs.js';
import { gitRouter } from './routes/git.js';
import { stateRouter } from './routes/state.js';
import { reviewRouter } from './routes/review.js';
import { osRouter } from './routes/os.js';
import { quickaccessRouter } from './routes/quickaccess.js';
import { logRouter } from './routes/log.js';
import { attachWatcher } from './ws/watcher.js';
import {
  getAppConfig,
  getLogRetentionDays,
  saveAppConfig,
  type AppConfigKey,
} from './services/appConfigStore.js';
import { errorDetail, logger, newRequestId, purgeLogs, sanitizeId } from './services/logger.js';

const app = express();

/**
 * リクエスト ID / セッション ID (services/logger.ts)
 * - requestId: ここで発行し、レスポンスヘッダ x-request-id とエラー JSON で返す
 * - sessionId: クライアント (ブラウザのタブ) が x-session-id で送ってくる
 * 認証より前に置き、401/403 も記録できるようにする。
 */
app.use('/api', (req: Request, res: Response, next: NextFunction) => {
  const requestId = newRequestId();
  const sessionId = sanitizeId(req.headers['x-session-id']);
  res.locals.requestId = requestId;
  res.locals.sessionId = sessionId;
  res.setHeader('x-request-id', requestId);
  const started = process.hrtime.bigint();
  // ログビュー自身のポーリングで埋まらないよう、/api/log は失敗時のみ記録する
  // (finish 時点では req.path がマウント前の値に戻っているので、ここで判定しておく)
  const isLogApi = req.path.startsWith('/log');
  res.on('finish', () => {
    const status = res.statusCode;
    if (isLogApi && status < 400) return;
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    // 4xx は通常操作で起こり得る応答 (ファイルパスを一覧しようとした等) なので info に留める
    const level = status >= 500 ? 'error' : 'info';
    logger[level](`${req.method} ${req.originalUrl} ${status} ${ms.toFixed(1)}ms`, {
      event: 'access',
      requestId,
      sessionId,
      detail: {
        method: req.method,
        path: req.path,
        url: req.originalUrl,
        status,
        durationMs: Math.round(ms * 10) / 10,
        ...(res.locals.error ? { error: res.locals.error } : {}),
      },
    });
  });
  next();
});

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
app.use('/api/review', reviewRouter);
app.use('/api/os', osRouter);
app.use('/api/quickaccess', quickaccessRouter);
app.use('/api/log', logRouter);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, platform: process.platform });
});

// クライアント向けの UI 設定 (メニュー描画用の最小情報。command/args は返さない)
app.get('/api/config', (_req, res) => {
  const cfg = getAppConfig();
  res.json({
    contextMenu: cfg.contextMenu,
    // 外部ツールは描画・実行に必要な情報のみ (id が /api/os/run-tool の識別子)
    externalTools: cfg.externalTools.map((t) => ({
      id: t.id,
      label: t.label,
      group: t.group,
      kind: t.kind ?? 'any',
      extensions: t.extensions ?? [],
      confirm: t.confirm === true,
    })),
    // 外部差分ツール (id が /api/git/difftool の識別子)。
    // isDefault はダブルクリック時に使うツール (先頭の 1 つだけ有効)
    diffTools: cfg.diffTools.map((t, i, all) => ({
      id: t.id,
      label: t.label,
      isDefault: t.default === true && all.findIndex((x) => x.default === true) === i,
    })),
    // 拡張子 → 既定起動ツール id (ダブルクリック上書き)
    extDefaults: cfg.extDefaults,
  });
});

// 設定編集用: command/args も含む全項目を返す (token 認証済み前提)
app.get('/api/settings', (_req, res) => {
  res.json(getAppConfig());
});

// 設定保存: 指定キーのみ検証・正規化して DB へ (再起動不要で即時反映)
app.put('/api/settings', (req, res) => {
  const body = (req.body ?? {}) as Partial<Record<AppConfigKey, unknown>>;
  const saved = saveAppConfig(body);
  logger.info(`設定を保存しました (${Object.keys(body).join(', ')})`, {
    event: 'settings',
    requestId: res.locals.requestId as string,
    sessionId: res.locals.sessionId as string | null,
  });
  res.json(saved);
});

/**
 * エラーハンドラ: 種別付き JSON で返す (plan §10)。
 * スタックはログ (アプリログビュー) に残し、レスポンスには requestId を付けて突き合わせられるようにする。
 * ステータスが不正な値 (数値以外・範囲外) だと res.status() 自体が例外になり Express 既定の
 * "Internal Server Error" (非 JSON) に落ちるので、ここで 500 に丸める。
 */
app.use((err: Error & { status?: unknown; code?: string }, req: Request, res: Response, next: NextFunction) => {
  const rawStatus = typeof err.status === 'number' ? err.status : Number(err.status);
  const status =
    Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599
      ? rawStatus
      : err.code === 'ENOENT'
        ? 404
        : err.code === 'ENOTDIR'
          ? 400
          : err.code === 'EACCES' || err.code === 'EPERM'
            ? 403
            : 500;
  const requestId = res.locals.requestId as string | undefined;
  const sessionId = res.locals.sessionId as string | null | undefined;
  // アクセスログ (finish 時) にも要約を載せる
  res.locals.error = { code: err.code ?? 'internal', message: err.message };
  logger[status >= 500 ? 'error' : 'warn'](`${req.method} ${req.originalUrl} → ${status}: ${err.message}`, {
    event: 'error',
    requestId,
    sessionId,
    detail: { ...errorDetail(err), method: req.method, url: req.originalUrl, status },
  });
  if (res.headersSent) {
    // 送信途中で失敗した場合は JSON を返せない。接続を閉じて終える
    next(err);
    return;
  }
  res.status(status).json({
    error: err.code ?? 'internal',
    message: err.message,
    requestId,
  });
});

/**
 * プロセス全体の未捕捉例外。ルート外 (WS / chokidar / タイマー等) で起きたものはここでしか拾えない。
 * uncaughtException は状態が壊れている可能性があるので記録してから終了 (start.bat / --watch が再起動する前提)。
 * unhandledRejection は記録のみ (Node 既定は終了だが、ローカルツールとしては継続を優先)
 */
process.on('uncaughtException', (err) => {
  logger.error(`uncaughtException: ${err instanceof Error ? err.message : String(err)}`, {
    event: 'crash',
    detail: errorDetail(err),
  });
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.error(`unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`, {
    event: 'crash',
    detail: errorDetail(reason),
  });
});

// ログの保存期間 (設定 logRetentionDays) を超えた行を起動時と 1 時間ごとに削除する
function runLogPurge(): void {
  const days = getLogRetentionDays();
  const n = purgeLogs(days);
  if (n > 0) logger.info(`保存期間 (${days} 日) を超えたログを ${n} 件削除しました`, { event: 'log' });
}
runLogPurge();
setInterval(runLogPurge, 60 * 60 * 1000).unref();

const server = http.createServer(app);
attachWatcher(server);

server.listen(config.port, config.host, () => {
  logger.info(`server started: http://${config.host}:${config.port} (pid ${process.pid}, node ${process.version})`, {
    event: 'lifecycle',
    detail: { pid: process.pid, node: process.version, platform: process.platform },
  });
});
// listen 失敗 (ポート使用中等) は続行できないので記録して終了する
server.on('error', (err) => {
  logger.error(`server error: ${err.message}`, { event: 'lifecycle', detail: errorDetail(err) });
  process.exit(1);
});
