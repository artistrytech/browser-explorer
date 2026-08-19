import { Router } from 'express';
import { SimpleGit } from 'simple-git';
import path from 'node:path';
import { norm } from '../services/fsService.js';
import {
  addComment,
  clearViewed,
  createReview,
  deleteComment,
  deleteReview,
  getReview,
  listComments,
  listReviews,
  listViewed,
  markOutdated,
  setViewed,
  updateComment,
  updateReview,
  type Review,
  type ReviewComment,
} from '../services/reviewStore.js';
import {
  changedPaths,
  commitExists,
  countNewCommits,
  mergeBase,
  openGit,
  pinReviewRefs,
  rangeFilePatch,
  rangeFiles,
  resolveCommit,
  unpinReviewRefs,
} from '../services/reviewGit.js';

export const reviewRouter = Router();

function badRequest(message: string): never {
  const err = new Error(message) as Error & { status?: number };
  err.status = 400;
  throw err;
}

function notFound(message: string): never {
  const err = new Error(message) as Error & { status?: number };
  err.status = 404;
  throw err;
}

function reviewId(v: unknown): number {
  const id = Number(v);
  if (!Number.isInteger(id) || id <= 0) badRequest('id is required');
  return id;
}

function mustGetReview(id: number): Review {
  const r = getReview(id);
  if (!r) notFound('review not found');
  return r;
}

/** リポジトリルート相対パスの検証 (ルート外への脱出を拒否) */
function relPath(p: unknown): string {
  if (typeof p !== 'string' || p.length === 0) badRequest('path is required');
  const rel = norm(p);
  if (path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel.split('/').includes('..')) {
    badRequest('path must be repo-relative');
  }
  return rel;
}

/** 一覧に出すブランチ名は remotes/ を落とした形 (origin/foo) に揃える */
function normalizeBranch(name: unknown): string {
  if (typeof name !== 'string' || name.trim().length === 0) badRequest('branch is required');
  return name.trim().replace(/^remotes\//, '');
}

/**
 * リポジトリを開く。フォルダごと消えている場合は null。
 * (レビューはコメントを DB に持つので、リポジトリを失っても閲覧・出力・削除はできる)
 */
function tryOpenGit(repo: string): SimpleGit | null {
  try {
    return openGit(repo);
  } catch {
    return null;
  }
}

/** リポジトリが今も参照できるか (フォルダごと消えている場合に自動クローズしないため) */
async function repoAvailable(g: SimpleGit | null): Promise<boolean> {
  if (!g) return false;
  try {
    await g.raw(['rev-parse', '--git-dir']);
    return true;
  } catch {
    return false;
  }
}

/** ブランチ (ローカル + リモート追跡) の短縮名一覧 */
async function branchNames(g: SimpleGit): Promise<Set<string>> {
  const raw = await g.raw(['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes']);
  return new Set(raw.split('\n').map((s) => s.trim()).filter(Boolean));
}

/**
 * レビュー対象ブランチが消えていたら自動でクローズする。
 * リポジトリ自体が参照できない場合 (フォルダ移動・取り外しドライブ) は判定しない。
 */
function autoClose(review: Review, existing: Set<string>): Review {
  if (review.status === 'closed') return review;
  if (existing.has(review.headBranch)) return review;
  return updateReview(review.id, { status: 'closed', closedReason: 'branch-deleted' }) ?? review;
}

export interface ReviewSummary extends Review {
  comments: number;
  unresolved: number;
}

function summarize(review: Review): ReviewSummary {
  const comments = listComments(review.id);
  return {
    ...review,
    comments: comments.length,
    unresolved: comments.filter((c) => !c.resolved && !c.outdated).length,
  };
}

/** レビュー一覧 (新しい順)。開くたびにブランチの存在を突き合わせて自動クローズする */
reviewRouter.get('/list', async (req, res) => {
  const repo = req.query.repo;
  if (typeof repo !== 'string' || repo.length === 0) badRequest('repo is required');
  const reviews = listReviews(repo);
  let list = reviews;
  if (reviews.some((r) => r.status === 'open')) {
    const g = tryOpenGit(repo);
    if (g && (await repoAvailable(g))) {
      const existing = await branchNames(g);
      list = reviews.map((r) => autoClose(r, existing));
    }
  }
  res.json({ reviews: list.map(summarize) });
});

/**
 * レビュー作成: base...head の merge-base と head のコミットを確定し、
 * refs/reviews/<id>/{base,head} に打って gc から保護する。
 */
reviewRouter.post('/', async (req, res) => {
  const { repo, title } = (req.body ?? {}) as { repo?: string; title?: string };
  if (typeof repo !== 'string' || repo.length === 0) badRequest('repo is required');
  const baseBranch = normalizeBranch((req.body ?? {}).baseBranch);
  const headBranch = normalizeBranch((req.body ?? {}).headBranch);
  if (baseBranch === headBranch) badRequest('比較対象に同じブランチは指定できません');

  const g = openGit(repo);
  const headCommit = await resolveCommit(g, headBranch);
  if (!headCommit) badRequest(`ブランチが見つかりません: ${headBranch}`);
  const baseHead = await resolveCommit(g, baseBranch);
  if (!baseHead) badRequest(`ブランチが見つかりません: ${baseBranch}`);
  const baseCommit = await mergeBase(g, baseBranch, headBranch);
  if (!baseCommit) badRequest('2 つのブランチに共通の祖先がありません (比較できません)');

  const review = createReview({
    repo,
    title: (title ?? '').trim() || `${headBranch} → ${baseBranch}`,
    baseBranch,
    headBranch,
    baseCommit,
    headCommit,
  });
  await pinReviewRefs(g, review.id, baseCommit, headCommit);
  res.json({ review: summarize(review) });
});

/** タイトル・概要の更新 */
reviewRouter.put('/', (req, res) => {
  const id = reviewId((req.body ?? {}).id);
  mustGetReview(id);
  const { title, summary } = (req.body ?? {}) as { title?: string; summary?: string };
  const review = updateReview(id, {
    ...(typeof title === 'string' ? { title: title.trim() || '(無題)' } : {}),
    ...(typeof summary === 'string' ? { summary } : {}),
  });
  res.json({ review: summarize(review!) });
});

/** 手動でのクローズ / 再オープン */
reviewRouter.post('/status', (req, res) => {
  const id = reviewId((req.body ?? {}).id);
  mustGetReview(id);
  const status = (req.body ?? {}).status === 'closed' ? 'closed' : 'open';
  const review = updateReview(id, {
    status,
    closedReason: status === 'closed' ? 'manual' : null,
  });
  res.json({ review: summarize(review!) });
});

reviewRouter.delete('/', async (req, res) => {
  const id = reviewId((req.body ?? {}).id);
  const review = mustGetReview(id);
  const g = tryOpenGit(review.repo);
  if (g && (await repoAvailable(g))) await unpinReviewRefs(g, id);
  deleteReview(id);
  res.json({ ok: true });
});

/**
 * レビュー詳細: 固定した 2 コミットの差分ファイル一覧・コメント・確認済み。
 * 併せて「対象ブランチに新しいコミットがあるか」も返す (更新バナー用)。
 */
reviewRouter.get('/detail', async (req, res) => {
  const id = reviewId(req.query.id);
  let review = mustGetReview(id);
  const g = tryOpenGit(review.repo);
  const available = g !== null && (await repoAvailable(g));
  if (g && available) review = autoClose(review, await branchNames(g));

  const snapshotOk =
    g !== null &&
    available &&
    (await commitExists(g, review.headCommit)) &&
    (await commitExists(g, review.baseCommit));
  const files = g && snapshotOk ? await rangeFiles(g, review.baseCommit, review.headCommit) : [];
  const headBranchCommit = g && available ? await resolveCommit(g, review.headBranch) : null;
  const newCommits =
    g && headBranchCommit && headBranchCommit !== review.headCommit
      ? await countNewCommits(g, review.headCommit, review.headBranch)
      : 0;

  res.json({
    review: summarize(review),
    files,
    comments: listComments(id),
    viewed: listViewed(id),
    /** 差分を表示できるか (リポジトリ喪失・コミットが gc された場合に false) */
    available: snapshotOk,
    /** 対象ブランチが今も存在するか */
    headExists: headBranchCommit !== null,
    /** 固定したコミット以降の新しいコミット数 */
    newCommits,
  });
});

/** レビュー内 1 ファイルの unified 差分 */
reviewRouter.get('/file-patch', async (req, res) => {
  const id = reviewId(req.query.id);
  const review = mustGetReview(id);
  const rel = relPath(req.query.path);
  const oldPath = typeof req.query.oldPath === 'string' && req.query.oldPath ? relPath(req.query.oldPath) : null;
  const g = tryOpenGit(review.repo);
  if (!g) badRequest('リポジトリを参照できません');
  res.json({ diff: await rangeFilePatch(g, review.baseCommit, review.headCommit, rel, oldPath) });
});

/**
 * 「最新に更新」: 対象ブランチの先端と merge-base を取り直し、ref を張り替える。
 * 差分が変わったファイルのコメントは位置を保証できないため outdated にし、確認済みも外す。
 */
reviewRouter.post('/refresh', async (req, res) => {
  const id = reviewId((req.body ?? {}).id);
  const review = mustGetReview(id);
  const g = tryOpenGit(review.repo);
  if (!g || !(await repoAvailable(g))) badRequest('リポジトリを参照できません');
  const headCommit = await resolveCommit(g, review.headBranch);
  if (!headCommit) badRequest(`ブランチが見つかりません: ${review.headBranch}`);
  const baseCommit = (await mergeBase(g, review.baseBranch, review.headBranch)) ?? review.baseCommit;
  if (headCommit === review.headCommit && baseCommit === review.baseCommit) {
    res.json({ review: summarize(review), outdated: 0, changed: [] });
    return;
  }

  // 旧スナップショットと新スナップショットで内容が変わったファイル (両側を見る)
  const changed = new Set([
    ...(await changedPaths(g, review.headCommit, headCommit)),
    ...(await changedPaths(g, review.baseCommit, baseCommit)),
  ]);
  const paths = [...changed];
  const outdated = markOutdated(id, paths);
  clearViewed(id, paths);

  const updated = updateReview(id, { headCommit, baseCommit })!;
  await pinReviewRefs(g, id, baseCommit, headCommit);
  res.json({ review: summarize(updated), outdated, changed: paths });
});

/* ---------- コメント ---------- */

reviewRouter.post('/comment', (req, res) => {
  const body = (req.body ?? {}) as {
    id?: number;
    path?: string;
    oldPath?: string | null;
    side?: string;
    lineStart?: number;
    lineEnd?: number;
    body?: string;
  };
  const id = reviewId(body.id);
  mustGetReview(id);
  const text = (body.body ?? '').trim();
  if (!text) badRequest('コメントが空です');
  const lineStart = Number(body.lineStart);
  const lineEnd = Number(body.lineEnd ?? body.lineStart);
  if (!Number.isInteger(lineStart) || !Number.isInteger(lineEnd) || lineStart < 1 || lineEnd < lineStart) {
    badRequest('行番号が不正です');
  }
  const comment = addComment({
    reviewId: id,
    path: relPath(body.path),
    oldPath: body.oldPath ? relPath(body.oldPath) : null,
    side: body.side === 'old' ? 'old' : 'new',
    lineStart,
    lineEnd,
    body: text,
  });
  res.json({ comment });
});

reviewRouter.put('/comment', (req, res) => {
  const { id, body, resolved } = (req.body ?? {}) as { id?: number; body?: string; resolved?: boolean };
  const cid = reviewId(id);
  const text = typeof body === 'string' ? body.trim() : undefined;
  if (text !== undefined && !text) badRequest('コメントが空です');
  const comment = updateComment(cid, {
    ...(text !== undefined ? { body: text } : {}),
    ...(typeof resolved === 'boolean' ? { resolved } : {}),
  });
  if (!comment) notFound('comment not found');
  res.json({ comment });
});

reviewRouter.delete('/comment', (req, res) => {
  deleteComment(reviewId((req.body ?? {}).id));
  res.json({ ok: true });
});

reviewRouter.post('/viewed', (req, res) => {
  const body = (req.body ?? {}) as { id?: number; path?: string; viewed?: boolean };
  const id = reviewId(body.id);
  mustGetReview(id);
  setViewed(id, relPath(body.path), body.viewed === true);
  res.json({ ok: true });
});

/* ---------- Markdown 出力 ---------- */

/** 出力対象: 未解決かつ outdated でないコメントのみ */
function exportComments(comments: ReviewComment[]): ReviewComment[] {
  return comments
    .filter((c) => !c.resolved && !c.outdated)
    .sort((a, b) => a.path.localeCompare(b.path) || a.lineStart - b.lineStart || a.id - b.id);
}

function lineLabel(c: ReviewComment): string {
  const range = c.lineStart === c.lineEnd ? `L${c.lineStart}` : `L${c.lineStart}-L${c.lineEnd}`;
  return `${range} (${c.side === 'old' ? '変更前' : '変更後'})`;
}

export function buildMarkdown(review: Review, comments: ReviewComment[]): string {
  const target = exportComments(comments);
  const out: string[] = [];
  out.push(`# レビュー: ${review.title}`, '');
  out.push(`- 対象: \`${review.headBranch}\` → \`${review.baseBranch}\``);
  out.push(`- 比較: \`${review.baseCommit.slice(0, 7)}\` … \`${review.headCommit.slice(0, 7)}\``);
  out.push(`- 出力日時: ${new Date().toLocaleString('ja-JP')}`);
  out.push('');
  if (review.summary.trim()) {
    out.push(review.summary.trim(), '');
  }
  if (target.length === 0) {
    out.push('未解決のコメントはありません。', '');
    return out.join('\n');
  }
  let currentPath = '';
  for (const c of target) {
    if (c.path !== currentPath) {
      currentPath = c.path;
      out.push(`## ${c.oldPath && c.oldPath !== c.path ? `${c.oldPath} → ${c.path}` : c.path}`, '');
    }
    out.push(`### ${lineLabel(c)}`, '');
    out.push(c.body.trim(), '');
  }
  return out.join('\n');
}

reviewRouter.get('/export', (req, res) => {
  const id = reviewId(req.query.id);
  const review = mustGetReview(id);
  const comments = listComments(id);
  res.json({
    markdown: buildMarkdown(review, comments),
    count: exportComments(comments).length,
  });
});
