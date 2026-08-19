import { db } from './stateStore.js';

/**
 * コードレビュー機能の永続化 (レビュー / 行コメント / 確認済みファイル)。
 * DB は stateStore と同じ data/app.db を共有する。
 *
 * レビューは「作成時に確定した 2 つのコミット (merge-base と head) の差分」であり、
 * ブランチが進んでも表示は変わらない (明示的な「最新に更新」でのみ動く)。
 * 固定したコミットは routes/review.ts が refs/reviews/<id>/{base,head} に打って
 * gc から保護するため、ブランチを削除してもレビューは丸ごと残る。
 */
db.exec(`
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY,
  repo TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  base_branch TEXT NOT NULL,               -- 取り込み先 (比較の基準)
  head_branch TEXT NOT NULL,               -- レビュー対象
  base_commit TEXT NOT NULL,               -- 確定した merge-base のコミット
  head_commit TEXT NOT NULL,               -- 確定した head のコミット
  status TEXT NOT NULL DEFAULT 'open',     -- open / closed
  closed_reason TEXT,                      -- manual / branch-deleted
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS review_comments (
  id INTEGER PRIMARY KEY,
  review_id INTEGER NOT NULL,
  path TEXT NOT NULL,                      -- 変更後のパス (削除ファイルは変更前のパス)
  old_path TEXT,                           -- 名前変更時の変更前パス
  side TEXT NOT NULL,                      -- old (変更前) / new (変更後)
  line_start INTEGER NOT NULL,             -- side 側の行番号 (単一行なら end と同値)
  line_end INTEGER NOT NULL,
  body TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  outdated INTEGER NOT NULL DEFAULT 0,     -- 「最新に更新」で差分が変わり位置を保証できない
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_comments_review ON review_comments(review_id);
CREATE TABLE IF NOT EXISTS review_viewed (
  review_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  PRIMARY KEY (review_id, path)
);
`);

export interface Review {
  id: number;
  repo: string;
  title: string;
  summary: string;
  baseBranch: string;
  headBranch: string;
  baseCommit: string;
  headCommit: string;
  status: 'open' | 'closed';
  closedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewComment {
  id: number;
  reviewId: number;
  path: string;
  oldPath: string | null;
  side: 'old' | 'new';
  lineStart: number;
  lineEnd: number;
  body: string;
  resolved: boolean;
  outdated: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ReviewRow {
  id: number;
  repo: string;
  title: string;
  summary: string;
  base_branch: string;
  head_branch: string;
  base_commit: string;
  head_commit: string;
  status: string;
  closed_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface CommentRow {
  id: number;
  review_id: number;
  path: string;
  old_path: string | null;
  side: string;
  line_start: number;
  line_end: number;
  body: string;
  resolved: number;
  outdated: number;
  created_at: string;
  updated_at: string;
}

function toReview(r: ReviewRow): Review {
  return {
    id: r.id,
    repo: r.repo,
    title: r.title,
    summary: r.summary,
    baseBranch: r.base_branch,
    headBranch: r.head_branch,
    baseCommit: r.base_commit,
    headCommit: r.head_commit,
    status: r.status === 'closed' ? 'closed' : 'open',
    closedReason: r.closed_reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toComment(r: CommentRow): ReviewComment {
  return {
    id: r.id,
    reviewId: r.review_id,
    path: r.path,
    oldPath: r.old_path,
    side: r.side === 'old' ? 'old' : 'new',
    lineStart: r.line_start,
    lineEnd: r.line_end,
    body: r.body,
    resolved: r.resolved !== 0,
    outdated: r.outdated !== 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const now = () => new Date().toISOString();

export function listReviews(repo: string): Review[] {
  return (
    db.prepare('SELECT * FROM reviews WHERE repo = ? ORDER BY created_at DESC').all(repo) as ReviewRow[]
  ).map(toReview);
}

export function getReview(id: number): Review | null {
  const row = db.prepare('SELECT * FROM reviews WHERE id = ?').get(id) as ReviewRow | undefined;
  return row ? toReview(row) : null;
}

export function createReview(r: {
  repo: string;
  title: string;
  baseBranch: string;
  headBranch: string;
  baseCommit: string;
  headCommit: string;
}): Review {
  const ts = now();
  const info = db
    .prepare(
      `INSERT INTO reviews (repo, title, summary, base_branch, head_branch, base_commit, head_commit, status, created_at, updated_at)
       VALUES (?, ?, '', ?, ?, ?, ?, 'open', ?, ?)`,
    )
    .run(r.repo, r.title, r.baseBranch, r.headBranch, r.baseCommit, r.headCommit, ts, ts);
  return getReview(Number(info.lastInsertRowid))!;
}

/** レビュー本体の部分更新 (タイトル・概要・状態・固定コミット) */
export function updateReview(
  id: number,
  patch: Partial<
    Pick<Review, 'title' | 'summary' | 'status' | 'closedReason' | 'baseCommit' | 'headCommit'>
  >,
): Review | null {
  const cols: Record<string, string> = {
    title: 'title',
    summary: 'summary',
    status: 'status',
    closedReason: 'closed_reason',
    baseCommit: 'base_commit',
    headCommit: 'head_commit',
  };
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, col] of Object.entries(cols)) {
    const v = (patch as Record<string, unknown>)[key];
    if (v !== undefined) {
      sets.push(`${col} = ?`);
      values.push(v);
    }
  }
  if (sets.length === 0) return getReview(id);
  sets.push('updated_at = ?');
  values.push(now(), id);
  db.prepare(`UPDATE reviews SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getReview(id);
}

export function deleteReview(id: number): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM review_comments WHERE review_id = ?').run(id);
    db.prepare('DELETE FROM review_viewed WHERE review_id = ?').run(id);
    db.prepare('DELETE FROM reviews WHERE id = ?').run(id);
  });
  tx();
}

export function listComments(reviewId: number): ReviewComment[] {
  return (
    db
      .prepare('SELECT * FROM review_comments WHERE review_id = ? ORDER BY path, line_start, id')
      .all(reviewId) as CommentRow[]
  ).map(toComment);
}

export function addComment(c: {
  reviewId: number;
  path: string;
  oldPath: string | null;
  side: 'old' | 'new';
  lineStart: number;
  lineEnd: number;
  body: string;
}): ReviewComment {
  const ts = now();
  const info = db
    .prepare(
      `INSERT INTO review_comments (review_id, path, old_path, side, line_start, line_end, body, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(c.reviewId, c.path, c.oldPath, c.side, c.lineStart, c.lineEnd, c.body, ts, ts);
  touchReview(c.reviewId);
  return toComment(
    db
      .prepare('SELECT * FROM review_comments WHERE id = ?')
      .get(Number(info.lastInsertRowid)) as CommentRow,
  );
}

export function updateComment(
  id: number,
  patch: { body?: string; resolved?: boolean },
): ReviewComment | null {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.body !== undefined) {
    sets.push('body = ?');
    values.push(patch.body);
  }
  if (patch.resolved !== undefined) {
    sets.push('resolved = ?');
    values.push(patch.resolved ? 1 : 0);
  }
  if (sets.length === 0) return null;
  sets.push('updated_at = ?');
  values.push(now(), id);
  db.prepare(`UPDATE review_comments SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  const row = db.prepare('SELECT * FROM review_comments WHERE id = ?').get(id) as CommentRow | undefined;
  if (row) touchReview(row.review_id);
  return row ? toComment(row) : null;
}

export function deleteComment(id: number): void {
  const row = db.prepare('SELECT review_id FROM review_comments WHERE id = ?').get(id) as
    | { review_id: number }
    | undefined;
  db.prepare('DELETE FROM review_comments WHERE id = ?').run(id);
  if (row) touchReview(row.review_id);
}

/**
 * 「最新に更新」でファイルの差分が変わったコメントに outdated を立てる。
 * paths は変更後パス。行内容の照合は行わない (差分が変わっていないファイルは位置が保証される)。
 */
export function markOutdated(reviewId: number, paths: string[]): number {
  if (paths.length === 0) return 0;
  const stmt = db.prepare(
    'UPDATE review_comments SET outdated = 1 WHERE review_id = ? AND outdated = 0 AND path = ?',
  );
  let n = 0;
  const tx = db.transaction(() => {
    for (const p of paths) n += stmt.run(reviewId, p).changes;
  });
  tx();
  return n;
}

export function listViewed(reviewId: number): string[] {
  return (
    db.prepare('SELECT path FROM review_viewed WHERE review_id = ?').all(reviewId) as { path: string }[]
  ).map((r) => r.path);
}

export function setViewed(reviewId: number, path: string, viewed: boolean): void {
  if (viewed) {
    db.prepare('INSERT OR IGNORE INTO review_viewed (review_id, path) VALUES (?, ?)').run(reviewId, path);
  } else {
    db.prepare('DELETE FROM review_viewed WHERE review_id = ? AND path = ?').run(reviewId, path);
  }
}

/** 差分が変わったファイルは「確認済み」も外す (再確認が必要なため) */
export function clearViewed(reviewId: number, paths: string[]): void {
  const stmt = db.prepare('DELETE FROM review_viewed WHERE review_id = ? AND path = ?');
  const tx = db.transaction(() => {
    for (const p of paths) stmt.run(reviewId, p);
  });
  tx();
}

function touchReview(reviewId: number): void {
  db.prepare('UPDATE reviews SET updated_at = ? WHERE id = ?').run(now(), reviewId);
}
