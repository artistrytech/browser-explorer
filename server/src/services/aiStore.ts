import { db } from './stateStore.js';

/**
 * AI チャット (Codex / Claude の CLI との対話) の保存先。
 * - ai_boxes: 会話の Box。名前・ベースフォルダと、AI ごとに「続ける」対象の会話 (sessions) を持つ
 * - ai_turns: 依頼 1 回分 (人間の依頼 + AI の出力)。出力は表示用に整えた項目 (AiItem) の配列で持つ
 *
 * 会話 (thread) は Box 内の通し番号。「新しい会話」で採番し、「続ける」は同じ AI の最後の会話を引き継ぐ。
 * ベースフォルダを変えたら sessions を空にして、以降はすべて新しい会話にする
 * (CLI の会話の再開はフォルダ単位のため)。
 */

db.exec(`
CREATE TABLE IF NOT EXISTS ai_boxes (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  cwd TEXT NOT NULL,
  sessions TEXT NOT NULL DEFAULT '{}',  -- AiAgent → AiSession (JSON)
  next_thread INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_turns (
  id INTEGER PRIMARY KEY,
  box_id INTEGER NOT NULL,
  thread INTEGER NOT NULL,
  agent TEXT NOT NULL,
  mode TEXT NOT NULL,                   -- new / continue
  model TEXT NOT NULL DEFAULT '',       -- 空 = CLI の既定
  effort TEXT NOT NULL DEFAULT '',      -- 空 = CLI の既定
  permission TEXT NOT NULL DEFAULT '',  -- Codex のサンドボックス / Claude の権限モード
  prompt TEXT NOT NULL,
  cwd TEXT NOT NULL,
  items TEXT NOT NULL DEFAULT '[]',     -- AiItem[] (JSON)
  status TEXT NOT NULL,                 -- running / done / error / canceled
  error TEXT,
  session_id TEXT,
  usage TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS ai_turns_box ON ai_turns (box_id, id);
`);

// 権限 (permission) の列が無い旧スキーマに追加する
{
  const cols = db.prepare('PRAGMA table_info(ai_turns)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'permission')) {
    db.exec("ALTER TABLE ai_turns ADD COLUMN permission TEXT NOT NULL DEFAULT ''");
  }
}

// 実行中のままサーバが終了したターンは中断扱いにする (子プロセスは残っていない)
db.prepare(
  `UPDATE ai_turns SET status = 'error', error = 'サーバの再起動により中断しました', finished_at = ?
   WHERE status = 'running'`,
).run(new Date().toISOString());

export type AiAgent = 'codex' | 'claude';
export const AI_AGENTS: AiAgent[] = ['codex', 'claude'];

export function isAiAgent(v: unknown): v is AiAgent {
  return v === 'codex' || v === 'claude';
}

/** 「続ける」の対象 (AI ごとに最後の会話)。sessionId は CLI から受け取るまで null */
export interface AiSession {
  thread: number;
  sessionId: string | null;
}

export interface AiBox {
  id: number;
  name: string;
  cwd: string;
  sessions: Partial<Record<AiAgent, AiSession>>;
  createdAt: string;
  updatedAt: string;
}

/** AI の出力を表示用に整えた項目 */
export type AiItem =
  | { kind: 'text'; key: string; text: string }
  | { kind: 'reasoning'; key: string; text: string }
  | {
      kind: 'tool';
      key: string;
      /** 1 行の要約 (コマンド・対象ファイル等) */
      title: string;
      /** 入力の詳細 (変更ファイルの一覧・ツールの引数等) */
      detail?: string;
      output?: string;
      status: 'running' | 'done' | 'error';
    }
  | { kind: 'error'; key: string; text: string };

export type AiTurnStatus = 'running' | 'done' | 'error' | 'canceled';

export interface AiTurn {
  id: number;
  boxId: number;
  thread: number;
  agent: AiAgent;
  mode: 'new' | 'continue';
  model: string;
  effort: string;
  /** Codex のサンドボックス / Claude の権限モード (実行時の値) */
  permission: string;
  prompt: string;
  cwd: string;
  items: AiItem[];
  status: AiTurnStatus;
  error: string | null;
  sessionId: string | null;
  /** トークン数・費用などの要約 (表示用の文字列) */
  usage: string | null;
  createdAt: string;
  finishedAt: string | null;
}

interface BoxRow {
  id: number;
  name: string;
  cwd: string;
  sessions: string;
  next_thread: number;
  created_at: string;
  updated_at: string;
}

interface TurnRow {
  id: number;
  box_id: number;
  thread: number;
  agent: string;
  mode: string;
  model: string;
  effort: string;
  permission: string;
  prompt: string;
  cwd: string;
  items: string;
  status: string;
  error: string | null;
  session_id: string | null;
  usage: string | null;
  created_at: string;
  finished_at: string | null;
}

function parseJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function toBox(r: BoxRow): AiBox {
  return {
    id: r.id,
    name: r.name,
    cwd: r.cwd,
    sessions: parseJson(r.sessions, {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toTurn(r: TurnRow): AiTurn {
  return {
    id: r.id,
    boxId: r.box_id,
    thread: r.thread,
    agent: r.agent === 'claude' ? 'claude' : 'codex',
    mode: r.mode === 'continue' ? 'continue' : 'new',
    model: r.model,
    effort: r.effort,
    permission: r.permission,
    prompt: r.prompt,
    cwd: r.cwd,
    items: parseJson(r.items, []),
    status: r.status as AiTurnStatus,
    error: r.error,
    sessionId: r.session_id,
    usage: r.usage,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
  };
}

/** Box の一覧 (新しい順) */
export function listBoxes(): AiBox[] {
  return (db.prepare('SELECT * FROM ai_boxes ORDER BY id DESC').all() as BoxRow[]).map(toBox);
}

export function getBox(id: number): AiBox | null {
  const row = db.prepare('SELECT * FROM ai_boxes WHERE id = ?').get(id) as BoxRow | undefined;
  return row ? toBox(row) : null;
}

export function createBox(name: string, cwd: string): AiBox {
  const now = new Date().toISOString();
  const r = db
    .prepare('INSERT INTO ai_boxes (name, cwd, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(name, cwd, now, now);
  return getBox(Number(r.lastInsertRowid))!;
}

/** 名前・ベースフォルダの変更。フォルダを変えたら「続ける」対象を消し、次からは新しい会話にする */
export function updateBox(id: number, patch: { name?: string; cwd?: string }): AiBox | null {
  const box = getBox(id);
  if (!box) return null;
  const name = patch.name ?? box.name;
  const cwdChanged = patch.cwd !== undefined && patch.cwd !== box.cwd;
  db.prepare('UPDATE ai_boxes SET name = ?, cwd = ?, sessions = ?, updated_at = ? WHERE id = ?').run(
    name,
    patch.cwd ?? box.cwd,
    JSON.stringify(cwdChanged ? {} : box.sessions),
    new Date().toISOString(),
    id,
  );
  return getBox(id);
}

export function deleteBox(id: number): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM ai_turns WHERE box_id = ?').run(id);
    db.prepare('DELETE FROM ai_boxes WHERE id = ?').run(id);
  });
  tx();
}

export function listTurns(boxId: number): AiTurn[] {
  return (db.prepare('SELECT * FROM ai_turns WHERE box_id = ? ORDER BY id').all(boxId) as TurnRow[]).map(toTurn);
}

export function getTurn(id: number): AiTurn | null {
  const row = db.prepare('SELECT * FROM ai_turns WHERE id = ?').get(id) as TurnRow | undefined;
  return row ? toTurn(row) : null;
}

/**
 * ターンを開始する (実行中の行を作る)。
 * 新しい会話なら会話番号を採番し、その AI の「続ける」対象をこの会話に差し替える。
 * 続ける場合は引き継ぐセッション ID を返す。
 */
export function startTurn(input: {
  box: AiBox;
  agent: AiAgent;
  mode: 'new' | 'continue';
  model: string;
  effort: string;
  permission: string;
  prompt: string;
}): { turn: AiTurn; resumeId: string | null } {
  const { box, agent, mode } = input;
  const now = new Date().toISOString();
  let thread: number;
  let resumeId: string | null = null;
  const tx = db.transaction(() => {
    if (mode === 'continue') {
      const s = box.sessions[agent]!;
      thread = s.thread;
      resumeId = s.sessionId;
    } else {
      const row = db.prepare('SELECT next_thread FROM ai_boxes WHERE id = ?').get(box.id) as { next_thread: number };
      thread = row.next_thread;
      const sessions = { ...box.sessions, [agent]: { thread, sessionId: null } };
      db.prepare('UPDATE ai_boxes SET next_thread = ?, sessions = ?, updated_at = ? WHERE id = ?').run(
        thread + 1,
        JSON.stringify(sessions),
        now,
        box.id,
      );
    }
    const r = db
      .prepare(
        `INSERT INTO ai_turns (box_id, thread, agent, mode, model, effort, permission, prompt, cwd, status, session_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
      )
      .run(box.id, thread, agent, mode, input.model, input.effort, input.permission, input.prompt, box.cwd, resumeId, now);
    return Number(r.lastInsertRowid);
  });
  const id = tx();
  return { turn: getTurn(id)!, resumeId };
}

/** 実行中の出力を書き込む (途中経過も保存し、画面の再読み込みで消えないようにする) */
export function saveTurnProgress(turn: AiTurn): void {
  db.prepare(
    'UPDATE ai_turns SET items = ?, status = ?, error = ?, session_id = ?, usage = ?, finished_at = ? WHERE id = ?',
  ).run(
    JSON.stringify(turn.items),
    turn.status,
    turn.error,
    turn.sessionId,
    turn.usage,
    turn.finishedAt,
    turn.id,
  );
}

/**
 * CLI から受け取ったセッション ID を Box の「続ける」対象に記録する。
 * 実行中に別の新しい会話が始まっていたら (会話番号が違えば) 上書きしない
 */
export function recordSession(boxId: number, agent: AiAgent, thread: number, sessionId: string): void {
  const box = getBox(boxId);
  const s = box?.sessions[agent];
  if (!box || !s || s.thread !== thread || s.sessionId === sessionId) return;
  const sessions = { ...box.sessions, [agent]: { thread, sessionId } };
  db.prepare('UPDATE ai_boxes SET sessions = ? WHERE id = ?').run(JSON.stringify(sessions), boxId);
}
