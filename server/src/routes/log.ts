import { Router } from 'express';
import {
  clearLogs,
  countLogs,
  isLogLevel,
  listSessions,
  log,
  queryLogs,
  sanitizeId,
  type LogQuery,
} from '../services/logger.js';
import { getLogRetentionDays } from '../services/appConfigStore.js';

/**
 * アプリログ API (画面のアプリログビュー用)。
 * このルート自身へのアクセスは index.ts 側でアクセスログの対象外にしている
 * (ビューの自動更新でログが埋まるのを避けるため。エラー時のみ記録)。
 */
export const logRouter = Router();

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** 日時パラメータ: ISO 文字列ならそのまま、不正なら無視 */
function isoOrUndefined(v: unknown): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

logRouter.get('/', (req, res) => {
  const q = req.query;
  const minLevel = isLogLevel(q.level) ? q.level : undefined;
  const source = q.source === 'server' || q.source === 'client' ? q.source : undefined;
  const beforeId = Number(q.before);
  const limit = Number(q.limit);
  const query: LogQuery = {
    q: str(q.q),
    minLevel,
    source,
    sessionId: sanitizeId(q.session) ?? undefined,
    requestId: sanitizeId(q.request) ?? undefined,
    from: isoOrUndefined(q.from),
    to: isoOrUndefined(q.to),
    beforeId: Number.isInteger(beforeId) && beforeId > 0 ? beforeId : undefined,
    limit: Number.isInteger(limit) && limit > 0 ? limit : undefined,
  };
  res.json(queryLogs(query));
});

logRouter.get('/sessions', (_req, res) => {
  res.json({ sessions: listSessions() });
});

logRouter.get('/stats', (_req, res) => {
  res.json({ count: countLogs(), retentionDays: getLogRetentionDays() });
});

/**
 * クライアント側 (ブラウザ) からのログ投入。未捕捉例外・サーバに届かなかった API エラー等。
 * セッション ID はヘッダから (index.ts の共通ミドルウェアで res.locals に入る)
 */
logRouter.post('/client', (req, res) => {
  const body = (req.body ?? {}) as { level?: unknown; message?: unknown; event?: unknown; detail?: unknown };
  const level = isLogLevel(body.level) ? body.level : 'error';
  const message = typeof body.message === 'string' ? body.message.slice(0, 4000) : '(no message)';
  const event = typeof body.event === 'string' ? body.event.slice(0, 64) : 'client';
  const detail = body.detail && typeof body.detail === 'object' ? (body.detail as Record<string, unknown>) : null;
  log(level, message, {
    source: 'client',
    event,
    sessionId: res.locals.sessionId as string | null,
    // クライアント側で拾ったエラーに紐づくリクエスト ID があればそれを優先する
    requestId: sanitizeId(detail?.requestId) ?? (res.locals.requestId as string),
    detail,
  });
  res.json({ ok: true });
});

logRouter.delete('/', (req, res) => {
  const n = clearLogs();
  log('info', `ログを全削除しました (${n} 件)`, {
    event: 'log',
    sessionId: res.locals.sessionId as string | null,
    requestId: res.locals.requestId as string,
  });
  res.json({ ok: true, deleted: n });
});
