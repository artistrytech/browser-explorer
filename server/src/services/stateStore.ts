import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { dataDir } from '../config.js';

mkdirSync(dataDir, { recursive: true });
// 設定 (settings テーブル) は appConfigStore も共有するので db をエクスポートする
export const db = new Database(path.join(dataDir, 'app.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS favorites (id INTEGER PRIMARY KEY, path TEXT NOT NULL, label TEXT NOT NULL, sort INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS repositories (id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, added_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS recents (id INTEGER PRIMARY KEY, path TEXT NOT NULL, kind TEXT NOT NULL, opened_at TEXT NOT NULL);
-- リポジトリ単位の認証設定。秘密情報は持たず「どの認証を使うか」の参照のみ保存する
CREATE TABLE IF NOT EXISTS git_auth (
  repo TEXT PRIMARY KEY,
  ssh_key TEXT,            -- SSH 秘密鍵ファイルのパス (空なら既定の鍵)
  credential_helper TEXT   -- HTTPS の資格情報ヘルパー名 (空なら git の既定)
);
-- 過去のコミットメッセージ (再利用候補)。message は一意で、重複時は日時を更新する
CREATE TABLE IF NOT EXISTS commit_messages (
  message TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
-- アプリ起点のリベースセッション (repo 単位)。この行の存在が「リベース中ロック」を表す。
-- バックアップブランチ名や成功時削除フラグ等、git 自身の状態には無いメタデータを保持する。
CREATE TABLE IF NOT EXISTS rebase_sessions (
  repo TEXT PRIMARY KEY,
  onto TEXT NOT NULL,                          -- リベース先 (この上に移動する)
  base_branch TEXT NOT NULL,                   -- 書き換えられる側 (開始時の現在ブランチ)
  backup_branch TEXT NOT NULL,                 -- backup/rebase/<ts>-<name>
  delete_backup_on_success INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
`);

export interface Favorite {
  path: string;
  label: string;
}

export interface AppState {
  settings: Record<string, unknown>;
  favorites: Favorite[];
  repositories: string[];
  recents: { path: string; kind: string; openedAt: string }[];
}

export function getState(): AppState {
  const settings: Record<string, unknown> = {};
  for (const row of db.prepare('SELECT key, value FROM settings').all() as {
    key: string;
    value: string;
  }[]) {
    try {
      settings[row.key] = JSON.parse(row.value);
    } catch {
      settings[row.key] = row.value;
    }
  }
  const favorites = (
    db.prepare('SELECT path, label FROM favorites ORDER BY sort').all() as Favorite[]
  );
  const repositories = (
    db.prepare('SELECT path FROM repositories ORDER BY added_at').all() as { path: string }[]
  ).map((r) => r.path);
  const recents = (
    db
      .prepare('SELECT path, kind, opened_at FROM recents ORDER BY opened_at DESC LIMIT 30')
      .all() as { path: string; kind: string; opened_at: string }[]
  ).map((r) => ({ path: r.path, kind: r.kind, openedAt: r.opened_at }));
  return { settings, favorites, repositories, recents };
}

export function putState(partial: Partial<AppState>): void {
  const tx = db.transaction(() => {
    if (partial.settings) {
      const stmt = db.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      );
      for (const [k, v] of Object.entries(partial.settings)) {
        stmt.run(k, JSON.stringify(v));
      }
    }
    if (partial.favorites) {
      db.prepare('DELETE FROM favorites').run();
      const stmt = db.prepare('INSERT INTO favorites (path, label, sort) VALUES (?, ?, ?)');
      partial.favorites.forEach((f, i) => stmt.run(f.path, f.label, i));
    }
    if (partial.repositories) {
      db.prepare('DELETE FROM repositories').run();
      const stmt = db.prepare('INSERT INTO repositories (path, added_at) VALUES (?, ?)');
      partial.repositories.forEach((p, i) =>
        stmt.run(p, new Date(Date.now() + i).toISOString()),
      );
    }
    if (partial.recents) {
      db.prepare('DELETE FROM recents').run();
      const stmt = db.prepare('INSERT INTO recents (path, kind, opened_at) VALUES (?, ?, ?)');
      for (const r of partial.recents.slice(0, 30)) {
        stmt.run(r.path, r.kind, r.openedAt);
      }
    }
  });
  tx();
}

// --- クイックアクセス (favorites) 単体操作 (002.md §7.4) ---

export function listFavorites(): Favorite[] {
  return db.prepare('SELECT path, label FROM favorites ORDER BY sort').all() as Favorite[];
}

/** ピン止め追加。パス重複は無視して false を返す。追加位置は末尾 (sort 採番) */
export function addFavoriteRow(path: string, label: string): boolean {
  const exists = db.prepare('SELECT 1 FROM favorites WHERE path = ?').get(path);
  if (exists) return false;
  const max = db.prepare('SELECT COALESCE(MAX(sort), -1) AS m FROM favorites').get() as { m: number };
  db.prepare('INSERT INTO favorites (path, label, sort) VALUES (?, ?, ?)').run(path, label, max.m + 1);
  return true;
}

export function removeFavoriteRow(path: string): boolean {
  return db.prepare('DELETE FROM favorites WHERE path = ?').run(path).changes > 0;
}

export function reorderFavorites(paths: string[]): void {
  const tx = db.transaction(() => {
    const stmt = db.prepare('UPDATE favorites SET sort = ? WHERE path = ?');
    paths.forEach((p, i) => stmt.run(i, p));
  });
  tx();
}

// --- リポジトリ単位の認証設定 (A 案: 秘密情報は保持せず参照のみ) ---

export interface GitAuth {
  /** SSH 秘密鍵ファイルのパス (空文字なら既定の鍵を使う) */
  sshKey: string;
  /** HTTPS の資格情報ヘルパー名 (空文字なら git の既定設定に従う) */
  credentialHelper: string;
}

const NO_AUTH: GitAuth = { sshKey: '', credentialHelper: '' };

export function getGitAuth(repo: string): GitAuth {
  const row = db.prepare('SELECT ssh_key, credential_helper FROM git_auth WHERE repo = ?').get(repo) as
    | { ssh_key: string | null; credential_helper: string | null }
    | undefined;
  if (!row) return { ...NO_AUTH };
  return { sshKey: row.ssh_key ?? '', credentialHelper: row.credential_helper ?? '' };
}

export function setGitAuth(repo: string, auth: GitAuth): void {
  if (!auth.sshKey && !auth.credentialHelper) {
    db.prepare('DELETE FROM git_auth WHERE repo = ?').run(repo);
    return;
  }
  db.prepare(
    `INSERT INTO git_auth (repo, ssh_key, credential_helper) VALUES (?, ?, ?)
     ON CONFLICT(repo) DO UPDATE SET ssh_key = excluded.ssh_key, credential_helper = excluded.credential_helper`,
  ).run(repo, auth.sshKey, auth.credentialHelper);
}

// --- 過去のコミットメッセージ (再利用候補) ---

/** 選択候補として直近のコミットメッセージを返す (新しい順・最大件数)。既定 20 件 */
export function listCommitMessages(limit = 20): string[] {
  const n = Math.max(1, Math.min(limit, 100));
  return (
    db
      .prepare('SELECT message FROM commit_messages ORDER BY created_at DESC LIMIT ?')
      .all(n) as { message: string }[]
  ).map((r) => r.message);
}

/**
 * コミットメッセージを記録する (コミット成功時に呼ぶ)。
 * 同一メッセージが既にあれば日時だけ最新へ更新し (実質「過去分を消して先頭へ」)、
 * 肥大化を防ぐため新しい 50 件を超える古い行は削除する。空文字は無視。
 */
export function addCommitMessage(message: string): void {
  const m = message.trim();
  if (!m) return;
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO commit_messages (message, created_at) VALUES (?, ?)
       ON CONFLICT(message) DO UPDATE SET created_at = excluded.created_at`,
    ).run(m, new Date().toISOString());
    db.prepare(
      `DELETE FROM commit_messages WHERE message NOT IN (
         SELECT message FROM commit_messages ORDER BY created_at DESC LIMIT 50
       )`,
    ).run();
  });
  tx();
}

// --- リベースセッション (アプリ起点のリベース中ロック + メタデータ) ---

export interface RebaseSession {
  repo: string;
  /** リベース先 (この上に base_branch を移動する) */
  onto: string;
  /** 書き換えられる側 (開始時の現在ブランチ) */
  baseBranch: string;
  /** 退避用バックアップブランチ名 (backup/rebase/<ts>-<name>) */
  backupBranch: string;
  /** リベース成功後にバックアップブランチを削除するか */
  deleteBackupOnSuccess: boolean;
  createdAt: string;
}

export function getRebaseSession(repo: string): RebaseSession | null {
  const row = db
    .prepare(
      'SELECT repo, onto, base_branch, backup_branch, delete_backup_on_success, created_at FROM rebase_sessions WHERE repo = ?',
    )
    .get(repo) as
    | {
        repo: string;
        onto: string;
        base_branch: string;
        backup_branch: string;
        delete_backup_on_success: number;
        created_at: string;
      }
    | undefined;
  if (!row) return null;
  return {
    repo: row.repo,
    onto: row.onto,
    baseBranch: row.base_branch,
    backupBranch: row.backup_branch,
    deleteBackupOnSuccess: row.delete_backup_on_success === 1,
    createdAt: row.created_at,
  };
}

export function setRebaseSession(s: RebaseSession): void {
  db.prepare(
    `INSERT INTO rebase_sessions (repo, onto, base_branch, backup_branch, delete_backup_on_success, created_at)
     VALUES (@repo, @onto, @baseBranch, @backupBranch, @deleteBackupOnSuccess, @createdAt)
     ON CONFLICT(repo) DO UPDATE SET
       onto = excluded.onto,
       base_branch = excluded.base_branch,
       backup_branch = excluded.backup_branch,
       delete_backup_on_success = excluded.delete_backup_on_success,
       created_at = excluded.created_at`,
  ).run({
    repo: s.repo,
    onto: s.onto,
    baseBranch: s.baseBranch,
    backupBranch: s.backupBranch,
    deleteBackupOnSuccess: s.deleteBackupOnSuccess ? 1 : 0,
    createdAt: s.createdAt,
  });
}

export function clearRebaseSession(repo: string): void {
  db.prepare('DELETE FROM rebase_sessions WHERE repo = ?').run(repo);
}

export function importState(state: Partial<AppState>): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM settings').run();
    db.prepare('DELETE FROM favorites').run();
    db.prepare('DELETE FROM repositories').run();
    db.prepare('DELETE FROM recents').run();
  });
  tx();
  putState(state);
}
