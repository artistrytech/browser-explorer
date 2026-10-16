import { simpleGit, SimpleGit } from 'simple-git';
import fs from 'node:fs/promises';
import path from 'node:path';
import { norm } from './fsService.js';
import { parseNameStatusZ, parseNumstatZ } from './gitParse.js';

/**
 * レビュー機能が使う git 操作。
 *
 * 差分は GitHub の PR と同じ three-dot (base...head = merge-base 基準) で取る。
 * ただし merge-base はレビュー作成時に一度だけ解決して DB に固定するため、
 * 実際の diff は「固定した 2 コミットの two-dot」として実行する (結果は同じで、
 * ブランチが後から進んでも表示が動かない)。
 */

const QUOTE_PATH_CONFIG = 'core.quotepath=false';

export function openGit(repo: string): SimpleGit {
  return simpleGit(repo, { config: [QUOTE_PATH_CONFIG] });
}

/** ref (ブランチ名・remotes/origin/x・ハッシュ) をコミットへ解決する。存在しなければ null */
export async function resolveCommit(g: SimpleGit, ref: string): Promise<string | null> {
  try {
    return (await g.raw(['rev-parse', '--verify', `${ref}^{commit}`])).trim();
  } catch {
    return null;
  }
}

/** 2 つの ref の merge-base。共通の祖先が無ければ null */
export async function mergeBase(g: SimpleGit, a: string, b: string): Promise<string | null> {
  try {
    const out = (await g.raw(['merge-base', a, b])).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** レビュー対象ブランチに、固定したコミット以降の新しいコミットが何件あるか */
export async function countNewCommits(g: SimpleGit, snapshot: string, branch: string): Promise<number> {
  try {
    const out = (await g.raw(['rev-list', '--count', `${snapshot}..${branch}`])).trim();
    const n = Number(out);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

export interface ReviewFile {
  path: string;
  oldPath: string | null;
  status: string;
  added: number | null;
  deleted: number | null;
  binary: boolean;
}

/** 固定した 2 コミット間の変更ファイル一覧 (commit-files と同じ形式) */
export async function rangeFiles(
  g: SimpleGit,
  base: string,
  head: string,
): Promise<ReviewFile[]> {
  const [numstatRaw, nameStatusRaw] = await Promise.all([
    g.raw(['diff', '-M', '--numstat', '-z', base, head]),
    g.raw(['diff', '-M', '--name-status', '-z', base, head]),
  ]);
  const status = parseNameStatusZ(nameStatusRaw);
  return parseNumstatZ(numstatRaw).map((f) => {
    const st = status.get(f.path);
    return {
      path: f.path,
      oldPath: st?.oldPath ?? null,
      status: st?.status ?? 'M',
      added: f.added,
      deleted: f.deleted,
      binary: f.added === null,
    };
  });
}

/**
 * 固定した 2 コミット間の、1 ファイルの unified 差分。
 * 文脈行は広め (既定 10 行) に取る (文脈の展開機能を持たないため)。
 */
export async function rangeFilePatch(
  g: SimpleGit,
  base: string,
  head: string,
  path: string,
  oldPath: string | null,
  context = 10,
): Promise<string> {
  // 変更後だけを渡すと名前変更が「新規追加」に見えるため、変更前後の両方を渡す
  const paths = oldPath && oldPath !== path ? [oldPath, path] : [path];
  return g.raw(['diff', '-M', `-U${context}`, base, head, '--', ...paths]);
}

/* ---------- 未コミットの変更 (作業ツリー vs HEAD) ---------- */

/** 空のツリー。コミットが 1 つも無いリポジトリで HEAD の代わりに比較の基準にする */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** 行数を数える未追跡ファイルの上限サイズ (超えたら +/- を出さない) */
const UNTRACKED_COUNT_LIMIT = 16 * 1024 * 1024;

/** 未追跡ファイルを「全行追加」の変更として扱う */
async function untrackedFile(repo: string, rel: string): Promise<ReviewFile> {
  const file = path.join(repo, rel);
  const st = await fs.stat(file).catch(() => null);
  const buf = st && st.size <= UNTRACKED_COUNT_LIMIT ? await fs.readFile(file).catch(() => null) : null;
  const binary = buf !== null && buf.includes(0);
  let added: number | null = null;
  if (buf && !binary) {
    added = 0;
    for (const b of buf) if (b === 0x0a) added++;
    if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) added++; // 末尾に改行が無い最終行
  }
  return { path: rel, oldPath: null, status: 'A', added, deleted: added === null ? null : 0, binary };
}

/**
 * 作業ツリーと base (通常は HEAD) の差分ファイル一覧。
 * ステージ済み・未ステージの両方を含み、未追跡ファイル (.gitignore 対象を除く) は追加として扱う。
 */
export async function worktreeFiles(g: SimpleGit, repo: string, base: string): Promise<ReviewFile[]> {
  const [numstatRaw, nameStatusRaw, untrackedRaw] = await Promise.all([
    g.raw(['diff', '-M', '--numstat', '-z', base]),
    g.raw(['diff', '-M', '--name-status', '-z', base]),
    g.raw(['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  const status = parseNameStatusZ(nameStatusRaw);
  const tracked: ReviewFile[] = parseNumstatZ(numstatRaw).map((f) => {
    const st = status.get(f.path);
    return {
      path: f.path,
      oldPath: st?.oldPath ?? null,
      status: st?.status ?? 'M',
      added: f.added,
      deleted: f.deleted,
      binary: f.added === null,
    };
  });
  const untracked = await Promise.all(
    untrackedRaw
      .split('\0')
      .filter((t) => t.length > 0)
      .map((p) => untrackedFile(repo, norm(p))),
  );
  return [...tracked, ...untracked].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** 未追跡ファイル (.gitignore 対象を除く) か。git rm でステージした削除は未追跡ではない */
export async function isUntracked(g: SimpleGit, rel: string): Promise<boolean> {
  const out = await g.raw(['ls-files', '--others', '--exclude-standard', '-z', '--', rel]).catch(() => '');
  return out.length > 0;
}

/** 作業ツリーと base の、1 ファイルの unified 差分 (追跡済みファイル用) */
export async function worktreeFilePatch(
  g: SimpleGit,
  base: string,
  path: string,
  oldPath: string | null,
  context = 10,
): Promise<string> {
  const paths = oldPath && oldPath !== path ? [oldPath, path] : [path];
  return g.raw(['diff', '-M', `-U${context}`, base, '--', ...paths]);
}

/** 2 コミット間で内容が変わったファイル (変更後パス) の集合 */
export async function changedPaths(g: SimpleGit, a: string, b: string): Promise<string[]> {
  if (a === b) return [];
  const raw = await g.raw(['diff', '-M', '--name-only', '-z', a, b]);
  return raw
    .split('\0')
    .filter((t) => t.length > 0)
    .map((p) => norm(p));
}

/**
 * スナップショットのコミットを refs/reviews/<id>/{base,head} に固定する。
 * refs/heads の外なのでブランチ一覧には出ず、ブランチを削除しても gc で刈られない。
 * ref を打てなくてもレビュー自体は成立するので、失敗は握りつぶす (best effort)。
 */
export async function pinReviewRefs(
  g: SimpleGit,
  id: number,
  base: string,
  head: string,
): Promise<void> {
  await Promise.all([
    g.raw(['update-ref', reviewRef(id, 'base'), base]).catch(() => undefined),
    g.raw(['update-ref', reviewRef(id, 'head'), head]).catch(() => undefined),
  ]);
}

export async function unpinReviewRefs(g: SimpleGit, id: number): Promise<void> {
  await Promise.all([
    g.raw(['update-ref', '-d', reviewRef(id, 'base')]).catch(() => undefined),
    g.raw(['update-ref', '-d', reviewRef(id, 'head')]).catch(() => undefined),
  ]);
}

function reviewRef(id: number, kind: 'base' | 'head'): string {
  return `refs/reviews/${id}/${kind}`;
}

/** 固定したコミットが実体として残っているか (ref を打てなかった + gc された場合に false) */
export async function commitExists(g: SimpleGit, sha: string): Promise<boolean> {
  try {
    await g.raw(['cat-file', '-e', `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}
