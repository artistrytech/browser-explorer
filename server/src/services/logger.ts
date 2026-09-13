import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { dataDir } from '../config.js';

/**
 * アプリログ。data/logs.db (app.db とは別ファイル) に蓄積し、画面のアプリログビューから検索する。
 *
 * - requestId: HTTP リクエストごとにサーバが発行 (レスポンスの x-request-id ヘッダ / エラー JSON にも含める)
 * - sessionId: ブラウザのタブ単位でクライアントが発行 (x-session-id ヘッダ / WS の ?session=)
 * 両者でクライアントのトースト表示とサーバ側の記録を突き合わせる。
 *
 * 保存期間は設定 logRetentionDays (既定 30 日)。起動時と 1 時間ごとに古い行を削除する。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogSource = 'server' | 'client';

export interface LogEntry {
  id: number;
  /** ISO 8601 (ローカル時刻ではなく UTC) */
  ts: string;
  level: LogLevel;
  source: LogSource;
  /** 種別 (access / error / event / client 等)。検索の補助 */
  event: string;
  sessionId: string | null;
  requestId: string | null;
  message: string;
  /** 任意の付加情報 (JSON)。アクセスログの method/path/status、エラーのスタック等 */
  detail: Record<string, unknown> | null;
}

export interface LogWriteOptions {
  event?: string;
  source?: LogSource;
  sessionId?: string | null;
  requestId?: string | null;
  detail?: Record<string, unknown> | null;
}

export interface LogQuery {
  /** message / detail の部分一致 (大文字小文字区別なし) */
  q?: string;
  /** これ以上のレベルのみ */
  minLevel?: LogLevel;
  source?: LogSource;
  sessionId?: string;
  requestId?: string;
  /** ISO 8601 (これ以降) */
  from?: string;
  /** ISO 8601 (これ以前) */
  to?: string;
  /** この id より小さい (古い) 行のみ。ページング用 */
  beforeId?: number;
  limit?: number;
}

export interface LogSessionSummary {
  sessionId: string;
  firstTs: string;
  lastTs: string;
  count: number;
  errors: number;
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

export function isLogLevel(v: unknown): v is LogLevel {
  return typeof v === 'string' && (LEVELS as string[]).includes(v);
}

/** ID の妥当性 (ヘッダ由来なので形式を絞る)。英数字と - _ のみ、64 文字まで */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export function sanitizeId(v: unknown): string | null {
  return typeof v === 'string' && ID_RE.test(v) ? v : null;
}

/** リクエスト ID: 短くて目視で扱いやすい 12 桁の hex */
export function newRequestId(): string {
  return randomBytes(6).toString('hex');
}

mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'logs.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.exec(`
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  level TEXT NOT NULL,
  source TEXT NOT NULL,
  event TEXT NOT NULL,
  session_id TEXT,
  request_id TEXT,
  message TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS logs_ts ON logs (ts);
CREATE INDEX IF NOT EXISTS logs_session ON logs (session_id, id);
CREATE INDEX IF NOT EXISTS logs_request ON logs (request_id);
CREATE INDEX IF NOT EXISTS logs_level ON logs (level, id);
`);

const insertStmt = db.prepare(
  `INSERT INTO logs (ts, level, source, event, session_id, request_id, message, detail)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
);

/** コンソールにも 1 行で出す (開発時の確認用。ファイルへの永続化は DB 側) */
function echo(level: LogLevel, ts: string, sid: string | null, rid: string | null, message: string): void {
  const tag = `[${ts.slice(11, 19)}] ${level.padEnd(5)} ${sid ? `s:${sid.slice(0, 8)} ` : ''}${rid ? `r:${rid} ` : ''}`;
  const line = tag + message;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/** JSON 化できない値 (循環参照等) があっても記録自体は落とさない */
function safeJson(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  try {
    return JSON.stringify(v);
  } catch {
    return JSON.stringify({ unserializable: String(v) });
  }
}

export function log(level: LogLevel, message: string, opts: LogWriteOptions = {}): void {
  const ts = new Date().toISOString();
  const sid = opts.sessionId ?? null;
  const rid = opts.requestId ?? null;
  try {
    insertStmt.run(
      ts,
      level,
      opts.source ?? 'server',
      opts.event ?? 'event',
      sid,
      rid,
      message,
      safeJson(opts.detail),
    );
  } catch (e) {
    // ログ書き込み失敗で本処理を止めない
    console.error('[logger] write failed:', e);
  }
  echo(level, ts, sid, rid, message);
}

export const logger = {
  debug: (message: string, opts?: LogWriteOptions) => log('debug', message, opts),
  info: (message: string, opts?: LogWriteOptions) => log('info', message, opts),
  warn: (message: string, opts?: LogWriteOptions) => log('warn', message, opts),
  error: (message: string, opts?: LogWriteOptions) => log('error', message, opts),
};

/** Error オブジェクトを detail に入れやすい形へ (message / stack / code / status) */
export function errorDetail(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const e = err as Error & { code?: unknown; status?: unknown; cause?: unknown };
    return {
      name: e.name,
      message: e.message,
      stack: e.stack,
      ...(e.code !== undefined ? { code: e.code } : {}),
      ...(e.status !== undefined ? { status: e.status } : {}),
      ...(e.cause !== undefined ? { cause: String(e.cause) } : {}),
    };
  }
  return { value: String(err) };
}

interface Row {
  id: number;
  ts: string;
  level: LogLevel;
  source: LogSource;
  event: string;
  session_id: string | null;
  request_id: string | null;
  message: string;
  detail: string | null;
}

function toEntry(r: Row): LogEntry {
  let detail: Record<string, unknown> | null = null;
  if (r.detail) {
    try {
      detail = JSON.parse(r.detail) as Record<string, unknown>;
    } catch {
      detail = { raw: r.detail };
    }
  }
  return {
    id: r.id,
    ts: r.ts,
    level: r.level,
    source: r.source,
    event: r.event,
    sessionId: r.session_id,
    requestId: r.request_id,
    message: r.message,
    detail,
  };
}

export const MAX_QUERY_LIMIT = 1000;

/** 新しい順に返す。hasMore は「さらに古い行がある」 */
export function queryLogs(q: LogQuery): { entries: LogEntry[]; hasMore: boolean } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.q) {
    where.push('(message LIKE ? ESCAPE \'\\\' OR detail LIKE ? ESCAPE \'\\\')');
    const like = `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    params.push(like, like);
  }
  if (q.minLevel && q.minLevel !== 'debug') {
    const allowed = LEVELS.filter((l) => LEVEL_RANK[l] >= LEVEL_RANK[q.minLevel!]);
    where.push(`level IN (${allowed.map(() => '?').join(',')})`);
    params.push(...allowed);
  }
  if (q.source) {
    where.push('source = ?');
    params.push(q.source);
  }
  if (q.sessionId) {
    where.push('session_id = ?');
    params.push(q.sessionId);
  }
  if (q.requestId) {
    where.push('request_id = ?');
    params.push(q.requestId);
  }
  if (q.from) {
    where.push('ts >= ?');
    params.push(q.from);
  }
  if (q.to) {
    where.push('ts <= ?');
    params.push(q.to);
  }
  if (q.beforeId !== undefined) {
    where.push('id < ?');
    params.push(q.beforeId);
  }
  const limit = Math.min(MAX_QUERY_LIMIT, Math.max(1, q.limit ?? 200));
  const sql =
    `SELECT * FROM logs${where.length ? ` WHERE ${where.join(' AND ')}` : ''}` +
    ` ORDER BY id DESC LIMIT ?`;
  const rows = db.prepare(sql).all(...params, limit + 1) as Row[];
  const hasMore = rows.length > limit;
  return { entries: rows.slice(0, limit).map(toEntry), hasMore };
}

/** 直近のセッション一覧 (フィルタ候補用)。最終記録が新しい順 */
export function listSessions(limit = 50): LogSessionSummary[] {
  const rows = db
    .prepare(
      `SELECT session_id, MIN(ts) AS first_ts, MAX(ts) AS last_ts, COUNT(*) AS cnt,
              SUM(CASE WHEN level = 'error' THEN 1 ELSE 0 END) AS errors
         FROM logs WHERE session_id IS NOT NULL
         GROUP BY session_id ORDER BY last_ts DESC LIMIT ?`,
    )
    .all(limit) as { session_id: string; first_ts: string; last_ts: string; cnt: number; errors: number }[];
  return rows.map((r) => ({
    sessionId: r.session_id,
    firstTs: r.first_ts,
    lastTs: r.last_ts,
    count: r.cnt,
    errors: r.errors,
  }));
}

/** 保存期間を過ぎた行を削除する。削除件数を返す */
export function purgeLogs(retentionDays: number): number {
  const days = Number.isFinite(retentionDays) && retentionDays > 0 ? retentionDays : 30;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const r = db.prepare('DELETE FROM logs WHERE ts < ?').run(cutoff);
  return r.changes;
}

/** 全消去 (画面の「すべて削除」用) */
export function clearLogs(): number {
  return db.prepare('DELETE FROM logs').run().changes;
}

export function countLogs(): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM logs').get() as { c: number }).c;
}
