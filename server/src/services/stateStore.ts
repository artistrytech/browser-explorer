import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { dataDir } from '../config.js';

mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'app.db'));
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
