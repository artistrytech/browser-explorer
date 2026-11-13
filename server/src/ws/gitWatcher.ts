import path from 'node:path';
import chokidar, { FSWatcher } from 'chokidar';
import { simpleGit } from 'simple-git';
import { norm } from '../services/fsService.js';
import { READ_ONLY_GIT_ENV } from '../services/gitEnv.js';

/**
 * Git 管理情報 (.git) の監視。
 * 表示中フォルダの監視 (depth 0) では、AI やターミナルが行った git add / commit / checkout 等
 * (.git 内の変化) を検知できないため、リポジトリの .git も監視して Git ステータスの更新を促す。
 *
 * 監視対象は status / ブランチ表示に関わるものに絞る:
 * - .git 直下のファイル (index, HEAD, MERGE_HEAD, CHERRY_PICK_HEAD, packed-refs, ...)
 * - .git 直下の rebase-merge / rebase-apply の出現・消滅
 * - refs/ 配下 (ブランチ・タグ・リモート・stash)
 * objects / logs 等の大きなディレクトリと *.lock は除外する。
 */

/** .git 直下で監視しないディレクトリ */
const IGNORED_TOP = new Set(['objects', 'logs', 'hooks', 'info', 'modules', 'worktrees', 'lfs']);

/** 変更が連続したときにまとめる待ち時間 (ms) */
const DEBOUNCE_MS = 300;

export interface GitDirWatch {
  /** 監視中の .git (ワークツリーの場合はその gitdir) */
  gitDir: string;
  close: () => Promise<void>;
}

export interface GitDirs {
  /** 作業ツリーのルート (区切りは /) */
  root: string;
  /** gitdir (ワークツリーなら commonDir/worktrees/<name>) */
  gitDir: string;
  /** refs 等を持つ共通の .git */
  commonDir: string;
}

/** dirPath が属するリポジトリの gitdir と common dir を返す (リポジトリ外なら null) */
export async function resolveGitDirs(dirPath: string): Promise<GitDirs | null> {
  try {
    const out = await simpleGit(dirPath).revparse(['--show-toplevel', '--absolute-git-dir', '--git-common-dir']);
    const [root, gitDir, common] = out.split(/\r?\n/).map((s) => s.trim());
    if (!root || !gitDir || !common) return null;
    return { root: norm(root), gitDir: path.resolve(gitDir), commonDir: path.resolve(dirPath, common) };
  } catch {
    return null;
  }
}

/**
 * 作業ツリーの status (index の書き戻しはしない)。
 * git status / git diff は index の stat 情報だけを書き戻すことがあり、そのたびに通知すると
 * 「通知 → クライアントが status・差分を取得 → index 書き戻し → 通知」と回り続けるため、
 * index だけの変化は status の中身が変わったときに限って通知する
 */
async function statusSignature(root: string): Promise<string | null> {
  try {
    return await simpleGit(root)
      .env(READ_ONLY_GIT_ENV())
      .raw(['status', '--porcelain=v2', '-z', '--untracked-files=no']);
  } catch {
    return null;
  }
}

/** 監視ルート (gitDir / commonDir) からの相対パスで、監視不要なものを判定する */
function makeIgnored(bases: string[]): (p: string) => boolean {
  // 長いものから判定 (worktree の gitdir は commonDir/worktrees/<name> で、commonDir の配下になる)
  const sorted = [...bases].sort((a, b) => b.length - a.length);
  return (p: string) => {
    const abs = path.resolve(p);
    if (abs.endsWith('.lock')) return true;
    const base = sorted.find((b) => abs === b || abs.startsWith(b + path.sep));
    if (!base) return false;
    const rel = path.relative(base, abs);
    if (rel === '') return false;
    const parts = rel.split(path.sep);
    if (IGNORED_TOP.has(parts[0])) return true;
    // 深い階層は refs/ 配下だけ追う (rebase-merge の中身などは出現・消滅だけで十分)
    return parts.length > 1 && parts[0] !== 'refs';
  };
}

/** リポジトリの .git を監視し、変化があれば onChange(repoRoot) を呼ぶ */
export function watchGitDir(
  dirs: GitDirs,
  onChange: (root: string) => void,
  onError: (err: unknown) => void,
): GitDirWatch {
  const bases = dirs.gitDir === dirs.commonDir ? [dirs.gitDir] : [dirs.gitDir, dirs.commonDir];
  const watcher: FSWatcher = chokidar.watch(bases, {
    ignoreInitial: true,
    persistent: true,
    ignored: makeIgnored(bases),
  });
  let timer: NodeJS.Timeout | undefined;
  /** index 以外 (HEAD・refs・マージ状態等) の変化があったか */
  let otherChanged = false;
  /** 直近に通知したときの status (index だけの変化で中身が同じなら通知しない) */
  let lastStatus: string | null = null;
  void statusSignature(dirs.root).then((sig) => {
    if (lastStatus === null) lastStatus = sig;
  });
  const flush = async () => {
    const sig = await statusSignature(dirs.root);
    const changed = otherChanged || sig === null || sig !== lastStatus;
    otherChanged = false;
    lastStatus = sig;
    if (changed) onChange(dirs.root);
  };
  watcher.on('all', (_event, p) => {
    if (path.basename(p) !== 'index' || path.dirname(path.resolve(p)) !== dirs.gitDir) otherChanged = true;
    clearTimeout(timer);
    timer = setTimeout(() => void flush(), DEBOUNCE_MS);
  });
  watcher.on('error', onError);
  return {
    gitDir: dirs.gitDir,
    close: async () => {
      clearTimeout(timer);
      await watcher.close().catch(() => {});
    },
  };
}
