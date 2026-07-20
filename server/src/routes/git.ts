import { Router } from 'express';
import { simpleGit, SimpleGit } from 'simple-git';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { norm } from '../services/fsService.js';
import { broadcastEvent } from '../ws/watcher.js';
import { launchChecked } from './os.js';
import { getGitAuth, setGitAuth, listCommitMessages, addCommitMessage } from '../services/stateStore.js';
import { getDiffToolById, getAppConfig } from '../services/appConfigStore.js';

export const gitRouter = Router();

function badRequest(message: string): never {
  const err = new Error(message) as Error & { status?: number };
  err.status = 400;
  throw err;
}

function git(repo: unknown): SimpleGit {
  if (typeof repo !== 'string' || repo.length === 0) badRequest('repo is required');
  return simpleGit(repo);
}

/** リポジトリルート相対パスの検証 (ルート外への脱出を拒否, §1.3) */
function relPath(p: unknown): string {
  if (typeof p !== 'string' || p.length === 0) badRequest('path is required');
  const rel = norm(p);
  if (path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel.split('/').includes('..')) {
    badRequest('path must be repo-relative');
  }
  return rel;
}

type ProgressState = 'merge' | 'rebase' | 'cherry-pick' | null;

/** マージ/リベース/cherry-pick の進行状態と競合ファイルを返す (§2.2) */
async function getMergeState(g: SimpleGit): Promise<{ inProgress: ProgressState; conflicted: string[] }> {
  const gitDir = (await g.revparse(['--absolute-git-dir'])).trim();
  const has = (name: string) => existsSync(path.join(gitDir, name));
  const inProgress: ProgressState = has('MERGE_HEAD')
    ? 'merge'
    : has('rebase-merge') || has('rebase-apply')
      ? 'rebase'
      : has('CHERRY_PICK_HEAD')
        ? 'cherry-pick'
        : null;
  const st = await g.status();
  return { inProgress, conflicted: st.conflicted.map(norm) };
}

/** git ls-files -u のステージ番号から競合種別を判定 (§2.2) */
function conflictKind(stages: Set<number>): string {
  if (stages.has(1) && stages.has(2) && stages.has(3)) return 'both modified';
  if (!stages.has(1) && stages.has(2) && stages.has(3)) return 'both added';
  if (stages.has(1) && stages.has(2)) return 'deleted by them';
  if (stages.has(1) && stages.has(3)) return 'deleted by us';
  return 'conflicted';
}

async function isWorkingBinary(repo: string, rel: string): Promise<boolean> {
  try {
    const buf = await fs.readFile(path.join(repo, rel));
    return buf.subarray(0, 8000).includes(0);
  } catch {
    return false;
  }
}

gitRouter.get('/is-repo', async (req, res) => {
  const p = req.query.path;
  if (typeof p !== 'string') {
    res.status(400).json({ error: 'bad_request', message: 'path is required' });
    return;
  }
  try {
    const root = await simpleGit(p).revparse(['--show-toplevel']);
    res.json({ isRepo: true, root: norm(root.trim()) });
  } catch {
    res.json({ isRepo: false });
  }
});

gitRouter.get('/status', async (req, res) => {
  const g = git(req.query.repo);
  const st = await g.status();
  res.json({
    branch: st.current,
    tracking: st.tracking,
    ahead: st.ahead,
    behind: st.behind,
    files: st.files.map((f) => ({
      path: f.path.replace(/\\/g, '/'),
      index: f.index, // ステージ側の状態
      workingDir: f.working_dir, // 作業ツリー側の状態
    })),
    conflicted: st.conflicted,
  });
});

/**
 * 一覧表示用: 指定フォルダ直下エントリの「無視 (.gitignore)」「Git 管理外」判定。
 * 無視は check-ignore (stdin 一括)、管理外は ls-files の追跡ファイルから判定する。
 */
gitRouter.post('/entries-status', async (req, res) => {
  const { repo, dir, names } = (req.body ?? {}) as { repo?: unknown; dir?: unknown; names?: unknown };
  const g = git(repo);
  const relDir = typeof dir === 'string' && dir.length > 0 ? relPath(dir) : '';
  const NUL = String.fromCharCode(0);
  const valid = Array.isArray(names)
    ? names.filter(
        (n): n is string =>
          typeof n === 'string' && n.length > 0 && !/[/\\]/.test(n) &&
          n !== '.' && n !== '..' && n !== '.git' && !n.includes(NUL),
      )
    : [];
  if (valid.length === 0) {
    res.json({ ignored: [], untracked: [] });
    return;
  }
  const rels = valid.map((n) => (relDir ? `${relDir}/${n}` : n));

  // 無視判定: エントリ数によらず 1 プロセスで済むよう stdin で流し込む
  const ignoredSet = await new Promise<Set<string>>((resolve) => {
    const child = spawn('git', ['check-ignore', '-z', '--stdin'], { cwd: String(repo) });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.on('close', () =>
      resolve(new Set(Buffer.concat(chunks).toString('utf8').split(NUL).filter(Boolean))),
    );
    child.on('error', () => resolve(new Set()));
    child.stdin.on('error', () => {});
    child.stdin.end(rels.join(NUL) + NUL);
  });

  // 追跡判定: 対象フォルダ配下の追跡ファイルの「直下の子要素名」を集める
  // (フォルダは配下に追跡ファイルが 1 つでもあれば管理下とみなす)
  const lsArgs = relDir ? ['ls-files', '-z', '--', relDir] : ['ls-files', '-z'];
  const lsOut = await g.raw(lsArgs).catch(() => '');
  const prefix = relDir ? `${relDir}/` : '';
  const trackedChildren = new Set(
    lsOut
      .split(NUL)
      .filter((p) => p.length > prefix.length && p.startsWith(prefix))
      .map((p) => p.slice(prefix.length).split('/')[0]),
  );

  const ignored: string[] = [];
  const untracked: string[] = [];
  valid.forEach((name, i) => {
    if (trackedChildren.has(name)) return; // 管理下 (差分状態は /status 側で表示)
    if (ignoredSet.has(rels[i])) ignored.push(name);
    else untracked.push(name);
  });
  res.json({ ignored, untracked });
});

gitRouter.get('/log', async (req, res) => {
  const g = git(req.query.repo);
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const skip = Math.max(Number(req.query.skip) || 0, 0);
  const opts: Parameters<SimpleGit['log']>[0] & Record<string, unknown> = {
    maxCount: limit,
    format: {
      hash: '%H',
      parents: '%P',
      author: '%an',
      date: '%ad',
      message: '%s',
      refs: '%D',
    },
    '--date': 'iso',
  };
  if (skip > 0) opts['--skip'] = skip;
  // パス絞り込み (§1): repo ルート相対パスのみ受け付ける
  if (typeof req.query.path === 'string' && req.query.path.length > 0) {
    const rel = relPath(req.query.path);
    opts.file = rel;
    // --follow はリネーム追跡。単一ファイルのみ有効 (フォルダには付けない)
    if (req.query.follow === 'true') opts['--follow'] = null;
  }
  const log = await g.log(opts).catch(() => ({ all: [] as unknown[] }));
  res.json({ commits: log.all });
});

/**
 * グラフ用ログ (§5.2): %x1f 区切り・%x1e レコード区切りで安全にパース。
 * レーン割り当てはクライアント側で行う。
 */
gitRouter.get('/graph', async (req, res) => {
  const g = git(req.query.repo);
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const skip = Math.max(Number(req.query.skip) || 0, 0);
  const args = ['log', '--topo-order', `--max-count=${limit}`, `--skip=${skip}`,
    '--pretty=format:%H%x1f%P%x1f%an%x1f%aI%x1f%D%x1f%s%x1e'];
  if (req.query.all === 'true') args.splice(1, 0, '--all');
  // パス絞り込み (§1): --parents で %P を簡略化後の親に書き換えさせ、レーン描画の整合性を保つ
  if (typeof req.query.path === 'string' && req.query.path.length > 0) {
    const rel = relPath(req.query.path);
    args.splice(1, 0, '--parents');
    // --follow はリネーム追跡。単一ファイルのみ有効 (フォルダには付けない)
    if (req.query.follow === 'true') args.splice(1, 0, '--follow');
    args.push('--', rel);
  }
  const out = await g.raw(args).catch(() => '');
  const commits = out
    .split('\x1e')
    .map((rec) => rec.replace(/^\s+/, ''))
    .filter((rec) => rec.length > 0)
    .map((rec) => {
      const [hash, parents, author, date, refs, subject] = rec.split('\x1f');
      return {
        hash,
        parents: parents ? parents.split(' ').filter(Boolean) : [],
        author,
        date,
        refs: refs ? refs.split(', ').filter(Boolean) : [],
        subject: subject ?? '',
      };
    });
  res.json({ commits });
});

gitRouter.get('/show', async (req, res) => {
  const g = git(req.query.repo);
  const hash = String(req.query.hash ?? '');
  const body = await g.show([hash, '--stat', '--patch', '--format=%H%n%an%n%ad%n%B%x00', '--date=iso']);
  const [meta, patch] = body.split('\0');
  const [h, author, date, ...msg] = meta.split('\n');
  res.json({ hash: h, author, date, message: msg.join('\n').trim(), patch: patch ?? '' });
});

/**
 * コミットの差分ファイル一覧: パス・ステータス (追加/修正/削除)・追加行数・削除行数。
 * マージコミットは第 1 親との差分。リネーム検出はしない (--no-renames: D+A として扱う)。
 */
gitRouter.get('/commit-files', async (req, res) => {
  const g = git(req.query.repo);
  const hash = String(req.query.hash ?? '');
  if (!hash) badRequest('hash is required');
  const metaRaw = await g.show([hash, '--no-patch', '--format=%H%x1f%P%x1f%an%x1f%ad%x1f%B', '--date=iso']);
  const [h, parentsRaw, author, date, ...msg] = metaRaw.split('\x1f');
  const hasParent = parentsRaw.trim().length > 0;
  const base = hasParent
    ? ['diff', '--no-renames']
    : ['diff-tree', '-r', '--root', '--no-renames', '--format='];
  const revs = hasParent ? [`${hash}^`, hash] : [hash];
  const [numstatRaw, nameStatusRaw] = await Promise.all([
    g.raw([...base, '--numstat', ...revs]),
    g.raw([...base, '--name-status', ...revs]),
  ]);
  const status = new Map<string, string>();
  for (const line of nameStatusRaw.split('\n')) {
    const m = line.match(/^([A-Z])\d*\t(.+)$/);
    if (m) status.set(norm(m[2]), m[1]);
  }
  const files = numstatRaw
    .split('\n')
    .map((line) => line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => {
      const p = norm(m[3]);
      return {
        path: p,
        status: status.get(p) ?? 'M',
        added: m[1] === '-' ? null : Number(m[1]),
        deleted: m[2] === '-' ? null : Number(m[2]),
        binary: m[1] === '-', // numstat が '-' を返すのはバイナリ
      };
    });
  // 表示上限 (設定の commitFilesLimit)。絞り込みはクライアント側で全件に対して行う
  const limit = Math.max(1, Number(getAppConfig().commitFilesLimit) || 100);
  res.json({ hash: h, author, date, message: msg.join('\x1f').trim(), files, limit });
});

/** コミット前後のファイル内容 (2 ペイン差分表示用)。存在しない側は null */
gitRouter.get('/commit-file-diff', async (req, res) => {
  const g = git(req.query.repo);
  const hash = String(req.query.hash ?? '');
  if (!hash) badRequest('hash is required');
  const rel = relPath(req.query.path);
  const [before, after] = await Promise.all([
    g.show([`${hash}^:${rel}`]).catch(() => null),
    g.show([`${hash}:${rel}`]).catch(() => null),
  ]);
  const nul = String.fromCharCode(0);
  const binary = (before !== null && before.includes(nul)) || (after !== null && after.includes(nul));
  res.json({ path: rel, before, after, binary });
});

/* ---------- 外部差分ツール (config.jsonc の diffTools) ---------- */

const DIFF_TMP_ROOT = path.join(os.tmpdir(), 'expolorer-difftool');
const DIFF_MAX_BUFFER = 64 * 1024 * 1024;

/** 比較対象の指定。commit=コミット前後 / staged=HEAD vs ステージ / worktree=ステージ vs 作業ツリー */
type DiffToolMode = 'commit' | 'staged' | 'worktree';

/** 古い一時ファイル (24 時間以上前) を掃除する (best effort) */
async function cleanupDiffTemp(): Promise<void> {
  try {
    const now = Date.now();
    for (const name of await fs.readdir(DIFF_TMP_ROOT)) {
      const dir = path.join(DIFF_TMP_ROOT, name);
      const st = await fs.stat(dir).catch(() => null);
      if (st && now - st.mtimeMs > 24 * 60 * 60 * 1000) {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }
  } catch {
    /* 未作成なら何もしない */
  }
}

/** git show <spec> の内容。バイナリを壊さないよう Buffer で扱う。存在しなければ null */
async function gitShowBuffer(repo: string, spec: string): Promise<Buffer | null> {
  try {
    const { stdout } = await execFileAsync('git', ['show', spec], {
      cwd: repo,
      encoding: 'buffer',
      maxBuffer: DIFF_MAX_BUFFER,
    });
    return stdout as unknown as Buffer;
  } catch {
    return null; // そのリビジョンに存在しない (追加/削除されたファイル) → 空として扱う
  }
}

/** 比較用の一時ファイルを書き出す (元のファイル名のまま side ごとのサブフォルダに置く) */
async function writeSide(dir: string, side: string, rel: string, content: Buffer | null): Promise<string> {
  const sub = path.join(dir, side);
  await fs.mkdir(sub, { recursive: true });
  const file = path.join(sub, path.basename(rel));
  await fs.writeFile(file, content ?? Buffer.alloc(0));
  return file;
}

interface DiffSides {
  left: Buffer | null;
  right: Buffer | null;
  /** 作業ツリー側は実ファイルを直接開く (ツール上での編集を作業ツリーに反映できる) */
  rightPath: string | null;
  leftTitle: string;
  rightTitle: string;
}

async function diffSides(repo: string, rel: string, mode: DiffToolMode, hash: string): Promise<DiffSides> {
  if (mode === 'commit') {
    if (!hash) badRequest('hash is required');
    const short = hash.slice(0, 7);
    const [left, right] = await Promise.all([
      gitShowBuffer(repo, `${hash}^:${rel}`),
      gitShowBuffer(repo, `${hash}:${rel}`),
    ]);
    return { left, right, rightPath: null, leftTitle: `${rel} (${short}^)`, rightTitle: `${rel} (${short})` };
  }
  if (mode === 'staged') {
    const [left, right] = await Promise.all([
      gitShowBuffer(repo, `HEAD:${rel}`),
      gitShowBuffer(repo, `:${rel}`),
    ]);
    return { left, right, rightPath: null, leftTitle: `${rel} (HEAD)`, rightTitle: `${rel} (ステージ)` };
  }
  if (mode === 'worktree') {
    // ステージ済みの内容 (未追跡なら HEAD、それも無ければ空) と作業ツリーの実ファイルを比較
    const left = (await gitShowBuffer(repo, `:${rel}`)) ?? (await gitShowBuffer(repo, `HEAD:${rel}`));
    const abs = path.join(repo, rel);
    return {
      left,
      right: null,
      rightPath: existsSync(abs) ? abs : null,
      leftTitle: `${rel} (ステージ/HEAD)`,
      rightTitle: `${rel} (作業ツリー)`,
    };
  }
  badRequest('mode must be commit|staged|worktree');
}

/**
 * 外部差分ツールで比較を開く (config.jsonc の diffTools)。
 * クライアントが送るのはツールの index と比較対象 (repo/path/mode/hash) のみで、
 * 実行するコマンドと引数の雛形はサーバ側の設定からしか参照しない → 設定外のツールは実行できない。
 * 比較内容は一時ファイルに書き出し、引数配列で spawn する (シェル補間なし)。
 */
gitRouter.post('/difftool', async (req, res) => {
  const { tool, repo, mode, hash } = (req.body ?? {}) as {
    tool?: unknown;
    repo?: unknown;
    mode?: unknown;
    hash?: unknown;
  };
  const t = getDiffToolById(tool);
  if (!t || typeof t.command !== 'string' || t.command.trim().length === 0) badRequest('unknown diff tool');
  if (typeof repo !== 'string' || repo.length === 0) badRequest('repo is required');
  if (mode !== 'commit' && mode !== 'staged' && mode !== 'worktree') {
    badRequest('mode must be commit|staged|worktree');
  }
  const rel = relPath(req.body.path);
  const command = t.command.trim();
  // 絶対パス指定なら実在チェック (未インストール時に無反応にならないよう 400 で返す)
  if (/[\\/]/.test(command) && !existsSync(command)) badRequest(`ツールが見つかりません: ${command}`);

  const sides = await diffSides(repo, rel, mode, String(hash ?? ''));
  void cleanupDiffTemp();
  const dir = path.join(DIFF_TMP_ROOT, randomUUID());
  const leftPath = await writeSide(dir, 'left', rel, sides.left);
  const rightPath = sides.rightPath ?? (await writeSide(dir, 'right', rel, sides.right));

  const vars: Record<string, string> = {
    left: leftPath,
    right: rightPath,
    leftTitle: sides.leftTitle,
    rightTitle: sides.rightTitle,
  };
  const template = Array.isArray(t.args) ? t.args.filter((a): a is string => typeof a === 'string') : [];
  const args = template.map((a) => a.replace(/\$\{(left|right|leftTitle|rightTitle)\}/g, (_, k: string) => vars[k]));
  // プレースホルダが無い設定では末尾に左右のパスを渡す
  if (!template.some((a) => a.includes('${left}') || a.includes('${right}'))) args.push(leftPath, rightPath);

  await launchChecked(command, args, repo);
  res.json({ ok: true, command, left: leftPath, right: rightPath });
});

gitRouter.get('/diff', async (req, res) => {
  const g = git(req.query.repo);
  const repo = String(req.query.repo);
  const p = typeof req.query.path === 'string' ? req.query.path : undefined;
  const staged = req.query.staged === 'true';
  // 未追跡ファイルは通常の diff が空になるため、ファイル全体を追加行として表示する
  const untracked = req.query.untracked === 'true';
  if (untracked && !staged && p) {
    res.json({ diff: await untrackedDiff(repo, relPath(p)) });
    return;
  }
  const args: string[] = [];
  if (staged) args.push('--cached');
  if (p) args.push('--', p);
  const diff = await g.diff(args);
  res.json({ diff });
});

/**
 * 未追跡ファイルの差分を「全行追加」として得る (git diff --no-index -- /dev/null <file>)。
 * --no-index は差分があると終了コード 1 を返すため、stdout を拾って正常扱いにする。
 * /dev/null は git が全プラットフォームで空ファイルとして特別扱いする。
 */
async function untrackedDiff(repo: string, rel: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['diff', '--no-index', '--', '/dev/null', rel], {
      cwd: repo,
      maxBuffer: DIFF_MAX_BUFFER,
    });
    return stdout;
  } catch (e) {
    const err = e as { code?: number; stdout?: string };
    if (err.code === 1 && typeof err.stdout === 'string') return err.stdout; // 差分あり (正常)
    return '';
  }
}

/**
 * 部分ステージ/解除 (SourceTree のような Hunk・行単位)。
 * クライアントが組み立てた unified patch を git apply --cached に流し込む。
 * reverse=true でステージ解除 (--reverse)。--recount で行数のズレを許容する。
 */
gitRouter.post('/apply-patch', (req, res) => {
  const { repo, patch, reverse, cached } = (req.body ?? {}) as {
    repo?: unknown;
    patch?: unknown;
    reverse?: unknown;
    cached?: unknown;
  };
  if (typeof repo !== 'string' || repo.length === 0) badRequest('repo is required');
  if (typeof patch !== 'string' || patch.length === 0) badRequest('patch is required');
  // cached 既定 true (index へ)。false なら作業ツリーへ適用 (Hunk の破棄などに使う)
  const args = ['apply', '--recount', '--whitespace=nowarn'];
  if (cached !== false) args.push('--cached');
  if (reverse) args.push('--reverse');
  args.push('-');
  const child = spawn('git', args, { cwd: repo, windowsHide: true });
  let err = '';
  child.stderr.on('data', (c: Buffer) => {
    err += c.toString('utf8');
  });
  let sent = false;
  const done = (fn: () => void) => {
    if (sent) return;
    sent = true;
    fn();
  };
  child.on('error', (e) => done(() => res.status(500).json({ error: 'apply_failed', message: e.message })));
  child.on('close', (code) =>
    done(() =>
      code === 0
        ? res.json({ ok: true })
        : res.status(400).json({ error: 'apply_failed', message: err.trim() || `git apply exited ${code}` }),
    ),
  );
  child.stdin.on('error', () => {});
  child.stdin.end(patch);
});

gitRouter.post('/stage', async (req, res) => {
  const g = git(req.body.repo);
  await g.add(req.body.paths as string[]);
  res.json({ ok: true });
});

gitRouter.post('/unstage', async (req, res) => {
  const g = git(req.body.repo);
  await g.raw(['restore', '--staged', '--', ...(req.body.paths as string[])]);
  res.json({ ok: true });
});

gitRouter.post('/discard', async (req, res) => {
  const g = git(req.body.repo);
  const paths = req.body.paths as string[];
  // full=true はファイル全体の変更 (ステージ済み含む) を HEAD 状態へ戻す。
  // 先に index を HEAD へ戻すと、ステージ済みの変更も未ステージ扱いになり以降の処理で破棄される。
  const full = req.body.full === true;
  if (full && paths.length > 0) await g.raw(['reset', '-q', '--', ...paths]).catch(() => {});
  const st = await g.status();
  const untracked = new Set(st.not_added);
  const tracked = paths.filter((p) => !untracked.has(p));
  const toClean = paths.filter((p) => untracked.has(p));
  if (tracked.length > 0) await g.raw(['restore', '--', ...tracked]);
  if (toClean.length > 0) await g.raw(['clean', '-f', '--', ...toClean]);
  res.json({ ok: true });
});

gitRouter.post('/commit', async (req, res) => {
  const g = git(req.body.repo);
  const { message, amend } = req.body as { message: string; amend?: boolean };
  const result = await g.commit(message, undefined, amend ? { '--amend': null } : {});
  res.json({ ok: true, commit: result.commit });
});

// --- コミットメッセージ履歴 (再利用候補) ---

/** 直近のコミットメッセージ一覧 (新しい順・重複なし・最大 20 件) */
gitRouter.get('/commit-messages', (_req, res) => {
  res.json({ messages: listCommitMessages(20) });
});

/** コミット成功時にメッセージを記録する (重複は最新日時へ更新) */
gitRouter.post('/commit-messages', (req, res) => {
  const { message } = (req.body ?? {}) as { message?: unknown };
  if (typeof message !== 'string') badRequest('message is required');
  addCommitMessage(message);
  res.json({ ok: true });
});

gitRouter.post('/push', async (req, res) => {
  const g = git(req.body.repo);
  const result = await g.push();
  res.json({ ok: true, result });
});

gitRouter.post('/pull', async (req, res) => {
  const g = git(req.body.repo);
  const result = await g.pull();
  res.json({ ok: true, result });
});

gitRouter.post('/fetch', async (req, res) => {
  const g = git(req.body.repo);
  await g.fetch();
  res.json({ ok: true });
});

gitRouter.get('/branches', async (req, res) => {
  const g = git(req.query.repo);
  const b = await g.branch();
  const branches = Object.values(b.branches);
  const upstreamRaw = await g.raw(['for-each-ref', '--format=%(refname:short)%00%(upstream:short)', 'refs/heads']);
  const upstreamByBranch = new Map<string, string>();
  for (const line of upstreamRaw.split('\n')) {
    const [name, upstream] = line.split('\0');
    if (name && upstream) upstreamByBranch.set(name, upstream);
  }
  const counts = new Map<string, { ahead: number; behind: number }>();
  await Promise.all(
    branches.map(async (branch) => {
      const upstream = upstreamByBranch.get(branch.name);
      if (!upstream) return;
      const out = await g.raw(['rev-list', '--left-right', '--count', `${branch.name}...${upstream}`]).catch(() => '');
      const [aheadRaw, behindRaw] = out.trim().split(/\s+/);
      const ahead = Number(aheadRaw);
      const behind = Number(behindRaw);
      if (Number.isFinite(ahead) && Number.isFinite(behind)) counts.set(branch.name, { ahead, behind });
    }),
  );
  res.json({
    current: b.current,
    branches: branches.map((branch) => ({ ...branch, ...counts.get(branch.name) })),
  });
});

gitRouter.post('/branch', async (req, res) => {
  const g = git(req.body.repo);
  const { action, name } = req.body as { action: 'create' | 'checkout' | 'delete'; name: string };
  if (action === 'create') await g.checkoutLocalBranch(name);
  else if (action === 'checkout') await g.checkout(name);
  else if (action === 'delete') await g.deleteLocalBranch(name, false);
  res.json({ ok: true });
});

gitRouter.post('/merge', async (req, res) => {
  const g = git(req.body.repo);
  const result = await g.merge([req.body.branch as string]);
  res.json({ ok: true, result });
});

// --- 競合解消 (§2) ---

gitRouter.get('/merge-state', async (req, res) => {
  const g = git(req.query.repo);
  res.json(await getMergeState(g));
});

gitRouter.get('/conflicts', async (req, res) => {
  const repo = req.query.repo as string;
  const g = git(repo);
  const dir = typeof req.query.dir === 'string' && req.query.dir.length > 0 ? relPath(req.query.dir) : '';
  const out = await g.raw(['ls-files', '-u']).catch(() => '');
  // 行形式: "<mode> <sha> <stage>\t<path>"
  const stageMap = new Map<string, Set<number>>();
  for (const line of out.split('\n')) {
    const m = line.match(/^\d+ [0-9a-f]+ ([123])\t(.+)$/);
    if (!m) continue;
    const p = norm(m[2]);
    if (dir && p !== dir && !p.startsWith(`${dir}/`)) continue;
    if (!stageMap.has(p)) stageMap.set(p, new Set());
    stageMap.get(p)!.add(Number(m[1]));
  }
  const files = await Promise.all(
    [...stageMap.entries()].map(async ([p, stages]) => ({
      path: p,
      kind: conflictKind(stages),
      binary: await isWorkingBinary(repo, p),
    })),
  );
  res.json({ files });
});

gitRouter.get('/conflict/versions', async (req, res) => {
  const repo = req.query.repo as string;
  const g = git(repo);
  const rel = relPath(req.query.path);
  const show = (stage: number) => g.show([`:${stage}:${rel}`]).catch(() => null);
  const [base, ours, theirs] = await Promise.all([show(1), show(2), show(3)]);
  const working = await fs.readFile(path.join(repo, rel), 'utf8').catch(() => null);
  const hasNul = (s: string | null) => s !== null && s.includes(String.fromCharCode(0));
  const stages = new Set<number>();
  if (base !== null) stages.add(1);
  if (ours !== null) stages.add(2);
  if (theirs !== null) stages.add(3);
  res.json({
    path: rel,
    base,
    ours,
    theirs,
    working,
    kind: conflictKind(stages),
    binary: hasNul(base) || hasNul(ours) || hasNul(theirs) || hasNul(working),
  });
});

/** 統合結果を保存して git add (解決としてマーク, §2.6) */
gitRouter.post('/conflict/resolve', async (req, res) => {
  const repo = req.body.repo as string;
  const g = git(repo);
  const rel = relPath(req.body.path);
  const content = req.body.content;
  if (typeof content !== 'string') badRequest('content is required');
  await fs.writeFile(path.join(repo, rel), content, 'utf8');
  await g.add([rel]);
  res.json({ ok: true });
});

/** 片側採用 (ours/theirs)。採用側が削除している場合は git rm (§2.7 delete/modify) */
gitRouter.post('/conflict/take', async (req, res) => {
  const g = git(req.body.repo);
  const side = req.body.side as 'ours' | 'theirs';
  if (side !== 'ours' && side !== 'theirs') badRequest('side must be ours|theirs');
  const paths = (req.body.paths as string[]).map(relPath);
  for (const p of paths) {
    try {
      await g.raw(['checkout', side === 'ours' ? '--ours' : '--theirs', '--', p]);
      await g.add([p]);
    } catch {
      await g.raw(['rm', '-f', '--', p]);
    }
  }
  res.json({ ok: true });
});

const execFileAsync = promisify(execFile);

/** ssh の引数として安全に使える鍵パスか (クォート/改行等を含まないこと) */
function safeKeyPath(p: string): boolean {
  return p.length > 0 && !/["'\r\n]/.test(p);
}

/**
 * git を非対話で実行するための環境変数。
 * 認証が必要になった場合、プロンプトで待ち続けずその場で失敗させる (ロックアウト防止)。
 * - GIT_TERMINAL_PROMPT=0 : ターミナルでのユーザー名/パスワード入力を無効化
 * - GIT_ASKPASS/SSH_ASKPASS : GUI のパスワード入力ダイアログを起動させない
 * - GIT_SSH_COMMAND : SSH の対話 (パスフレーズ/ホスト鍵確認) を禁止し、接続もタイムアウトさせる
 *
 * repo を渡すと、そのリポジトリに設定された SSH 鍵を使う (A 案: 鍵のパスのみ保存)。
 */
export function gitEnv(repo?: string): NodeJS.ProcessEnv {
  const base = 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15';
  let sshCommand = process.env.GIT_SSH_COMMAND ?? base;
  if (repo) {
    const { sshKey } = getGitAuth(repo);
    // 指定鍵のみを使う (IdentitiesOnly=yes)。パスフレーズ付き鍵は ssh-agent 経由で解錠される
    if (safeKeyPath(sshKey)) sshCommand = `${base} -o IdentitiesOnly=yes -i "${sshKey}"`;
  }
  return {
    ...process.env,
    GIT_EDITOR: 'true',
    GIT_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    SSH_ASKPASS_REQUIRE: 'never',
    GCM_INTERACTIVE: 'never', // Git Credential Manager の GUI を抑止 (保存済み資格情報は使える)
    GIT_SSH_COMMAND: sshCommand,
  };
}

/**
 * 認証プロンプトを出さない git 設定 (サブコマンドの前に置く)。
 * repo に資格情報ヘルパーが設定されていれば HTTPS 認証にそれを使う。
 */
function noninteractiveArgs(repo?: string): string[] {
  const args = ['-c', 'credential.interactive=false', '-c', 'core.askPass='];
  if (repo) {
    const { credentialHelper } = getGitAuth(repo);
    // ヘルパー名に改行等が混じらないよう検証 (-c の値として渡す)
    if (credentialHelper && !/[\r\n]/.test(credentialHelper)) {
      args.push('-c', `credential.helper=${credentialHelper}`);
    }
  }
  return args;
}

/** 出力から認証エラーを検出し、ユーザー向けの補足メッセージを返す */
function authHint(output: string): string | null {
  const re =
    /could not read (Username|Password)|terminal prompts disabled|Authentication failed|Permission denied \(publickey|Host key verification failed|Repository not found|no such identity|sign_and_send_pubkey/i;
  if (!re.test(output)) return null;
  return (
    '(リモートの認証に失敗したため中断しました。' +
    'HTTPS は資格情報マネージャー、SSH は鍵/ssh-agent の設定を確認してください)'
  );
}

/** /exec で許可する git サブコマンド (読み書き系の操作コマンドのみ) */
const EXEC_ALLOWED = new Set([
  'push', 'pull', 'fetch', 'merge', 'commit', 'checkout', 'switch', 'branch',
  'tag', 'stash', 'cherry-pick', 'reset', 'rebase', 'revert', 'restore', 'clean', 'add',
]);

/**
 * Git コマンド実行 (実行コマンドと出力をそのまま返す)。
 * 成否はダイアログでユーザーに確認させるため、非 0 終了でも HTTP 200 で
 * { ok:false, output } を返す。
 */
gitRouter.post('/exec', (req, res) => {
  const { repo, args } = req.body as { repo?: unknown; args?: unknown };
  if (typeof repo !== 'string' || repo.length === 0) badRequest('repo is required');
  if (
    !Array.isArray(args) ||
    args.length === 0 ||
    !args.every((a): a is string => typeof a === 'string' && !a.includes(String.fromCharCode(0)))
  ) {
    badRequest('args (string[]) is required');
  }
  if (!EXEC_ALLOWED.has(args[0])) badRequest(`git ${String(args[0])} は許可されていません`);

  const command = `git ${args.join(' ')}`;
  // 引数配列で spawn (シェル補間なし)。認証プロンプトで固まらないよう対話は無効化
  const child = spawn('git', [...noninteractiveArgs(repo), ...args], {
    cwd: repo,
    windowsHide: true,
    env: gitEnv(repo),
  });
  let output = '';
  const cap = (c: Buffer) => {
    output += c.toString('utf8');
    if (output.length > 200_000) output = output.slice(-200_000);
  };
  child.stdout.on('data', cap);
  child.stderr.on('data', cap);

  let sent = false;
  const reply = (ok: boolean, code: number, extra?: string) => {
    if (sent) return;
    sent = true;
    clearTimeout(timer);
    const hint = ok ? null : authHint(output);
    const tail = [extra, hint].filter(Boolean).join('\n');
    res.json({ ok, code, command, output: tail ? `${output}${output ? '\n' : ''}${tail}` : output });
  };
  const timer = setTimeout(() => {
    child.kill();
    reply(false, -1, '(タイムアウトのため中断しました)');
  }, 120_000);
  child.on('error', (err) => reply(false, -1, err.message));
  child.on('close', (code) => reply(code === 0, code ?? -1));
});

// --- リポジトリ単位の認証設定 (A 案: 鍵ファイルのパス等の「参照」のみ保存し、秘密情報は持たない) ---

/** ~/.ssh 配下の秘密鍵候補を列挙する (.pub / known_hosts / config 等は除外) */
async function listSshKeys(): Promise<string[]> {
  const dir = path.join(os.homedir(), '.ssh');
  const skip = new Set(['known_hosts', 'known_hosts.old', 'config', 'authorized_keys', 'agent.env']);
  try {
    const names = await fs.readdir(dir);
    const keys: string[] = [];
    for (const n of names) {
      if (n.endsWith('.pub') || skip.has(n)) continue;
      const p = path.join(dir, n);
      try {
        const st = await fs.stat(p);
        if (!st.isFile()) continue;
        // 秘密鍵ヘッダを持つファイルのみを候補にする
        const head = (await fs.readFile(p, 'utf-8').catch(() => '')).slice(0, 200);
        if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(head)) keys.push(norm(p));
      } catch {
        /* 読めないファイルは無視 */
      }
    }
    return keys;
  } catch {
    return [];
  }
}

/** 認証設定 + 選択肢 (SSH 鍵候補・リモート URL) を返す */
gitRouter.get('/auth', async (req, res) => {
  const repo = req.query.repo;
  if (typeof repo !== 'string' || repo.length === 0) badRequest('repo is required');
  const g = git(repo);
  const remotes = await g.getRemotes(true).catch(() => []);
  res.json({
    auth: getGitAuth(repo),
    sshKeys: await listSshKeys(),
    remotes: remotes.map((r) => ({ name: r.name, url: r.refs.fetch || r.refs.push })),
  });
});

/** 認証設定の保存。鍵は実在する読み取り可能なファイルのみ受け付ける */
gitRouter.post('/auth', async (req, res) => {
  const { repo, sshKey, credentialHelper } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof repo !== 'string' || repo.length === 0) badRequest('repo is required');
  const key = typeof sshKey === 'string' ? sshKey.trim() : '';
  const helper = typeof credentialHelper === 'string' ? credentialHelper.trim() : '';
  if (key) {
    if (!safeKeyPath(key)) badRequest('鍵のパスに使用できない文字が含まれています');
    const st = await fs.stat(key).catch(() => null);
    if (!st?.isFile()) badRequest('鍵ファイルが見つかりません');
  }
  if (/[\r\n]/.test(helper)) badRequest('資格情報ヘルパー名が不正です');
  setGitAuth(repo, { sshKey: key, credentialHelper: helper });
  res.json({ ok: true, auth: getGitAuth(repo) });
});

/** 接続テスト: 設定した認証で ls-remote を実行し、成否と出力を返す */
gitRouter.post('/auth/test', (req, res) => {
  const { repo, remote } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof repo !== 'string' || repo.length === 0) badRequest('repo is required');
  const name = typeof remote === 'string' && remote.length > 0 ? remote : 'origin';
  if (/[\r\n]/.test(name)) badRequest('remote が不正です');
  const args = [...noninteractiveArgs(repo), 'ls-remote', '--heads', name];
  const child = spawn('git', args, { cwd: repo, windowsHide: true, env: gitEnv(repo) });
  let output = '';
  const cap = (c: Buffer) => {
    output += c.toString('utf8');
    if (output.length > 20_000) output = output.slice(-20_000);
  };
  child.stdout.on('data', cap);
  child.stderr.on('data', cap);
  let sent = false;
  const reply = (ok: boolean, extra?: string) => {
    if (sent) return;
    sent = true;
    clearTimeout(timer);
    const hint = ok ? null : authHint(output);
    const tail = [extra, hint].filter(Boolean).join('\n');
    res.json({
      ok,
      command: `git ls-remote --heads ${name}`,
      output: tail ? `${output}${output ? '\n' : ''}${tail}` : output,
    });
  };
  const timer = setTimeout(() => {
    child.kill();
    reply(false, '(タイムアウトのため中断しました)');
  }, 30_000);
  child.on('error', (err) => reply(false, err.message));
  child.on('close', (code) => reply(code === 0));
});

gitRouter.post('/merge/continue', async (req, res) => {
  const repo = req.body.repo as string;
  const g = git(repo);
  const { inProgress, conflicted } = await getMergeState(g);
  if (!inProgress) badRequest('merge/rebase/cherry-pick は進行中ではありません');
  if (conflicted.length > 0) badRequest(`未解決の競合が ${conflicted.length} 件あります`);
  // simple-git は GIT_EDITOR の指定を許さないため、続行系はネイティブ git を直接実行する
  const args =
    inProgress === 'merge'
      ? ['commit', '--no-edit']
      : inProgress === 'rebase'
        ? ['rebase', '--continue']
        : ['cherry-pick', '--continue'];
  await execFileAsync('git', args, {
    cwd: repo,
    env: { ...process.env, GIT_EDITOR: 'true' },
    windowsHide: true,
  });
  res.json({ ok: true });
});

gitRouter.post('/merge/abort', async (req, res) => {
  const g = git(req.body.repo);
  const { inProgress } = await getMergeState(g);
  if (!inProgress) badRequest('merge/rebase/cherry-pick は進行中ではありません');
  if (inProgress === 'merge') await g.raw(['merge', '--abort']);
  else if (inProgress === 'rebase') await g.raw(['rebase', '--abort']);
  else await g.raw(['cherry-pick', '--abort']);
  res.json({ ok: true });
});

// --- グラフ上のコミット操作 (§5.5) ---

gitRouter.post('/checkout-commit', async (req, res) => {
  const g = git(req.body.repo);
  await g.checkout([req.body.hash as string]);
  res.json({ ok: true });
});

gitRouter.post('/reset', async (req, res) => {
  const g = git(req.body.repo);
  const mode = req.body.mode as string;
  if (!['soft', 'mixed', 'hard'].includes(mode)) badRequest('mode must be soft|mixed|hard');
  await g.raw(['reset', `--${mode}`, req.body.hash as string]);
  res.json({ ok: true });
});

gitRouter.post('/cherry-pick', async (req, res) => {
  const g = git(req.body.repo);
  await g.raw(['cherry-pick', req.body.hash as string]);
  res.json({ ok: true });
});

gitRouter.post('/tag', async (req, res) => {
  const g = git(req.body.repo);
  const name = req.body.name as string;
  if (!name) badRequest('name is required');
  await g.raw(['tag', name, req.body.hash as string]);
  res.json({ ok: true });
});

gitRouter.post('/stash', async (req, res) => {
  const g = git(req.body.repo);
  const action = req.body.action as 'save' | 'pop' | 'list';
  if (action === 'save') {
    await g.stash();
    res.json({ ok: true });
  } else if (action === 'pop') {
    await g.stash(['pop']);
    res.json({ ok: true });
  } else {
    const list = await g.stashList().catch(() => ({ all: [] as unknown[] }));
    res.json({ ok: true, list: list.all });
  }
});

gitRouter.get('/blame', async (req, res) => {
  const g = git(req.query.repo);
  const p = String(req.query.path ?? '');
  const blame = await g.raw(['blame', '--date=short', '--', p]);
  res.json({ blame });
});

gitRouter.post('/init', async (req, res) => {
  const g = git(req.body.path);
  await g.init();
  res.json({ ok: true });
});

/**
 * クローン (§3.4): 長時間になり得るため即座に id を返し、
 * 進捗 (git clone --progress の stderr) を WS `git:clone-progress` で中継する。
 * 認証はシステム git (credential helper / SSH agent) に委譲。
 */
gitRouter.post('/clone', (req, res) => {
  const { url, dir, branch, depth, recursive } = req.body as {
    url: string;
    dir: string;
    branch?: string;
    depth?: number;
    recursive?: boolean;
  };
  if (typeof url !== 'string' || url.length === 0) badRequest('url is required');
  if (typeof dir !== 'string' || dir.length === 0) badRequest('dir is required');

  const id = randomUUID();
  // 外部プロセスは引数配列で spawn (シェル補間なし)
  const args = ['clone', '--progress'];
  if (branch) args.push('--branch', String(branch));
  if (depth && Number(depth) > 0) args.push('--depth', String(Number(depth)));
  if (recursive) args.push('--recurse-submodules');
  args.push(url, dir);

  // 認証が必要な場合はプロンプトで待たずに失敗させる (ロックアウト防止)
  const child = spawn('git', [...noninteractiveArgs(), ...args], {
    windowsHide: true,
    env: gitEnv(),
  });
  let all = '';
  const emit = (line: string) => {
    if (line.trim()) broadcastEvent('git:clone-progress', { id, line: line.trim() });
  };
  let buf = '';
  const onData = (chunk: Buffer) => {
    const s = chunk.toString('utf8');
    all += s;
    if (all.length > 200_000) all = all.slice(-200_000);
    buf += s;
    // \r (進捗の上書き行) と \n の両方を行区切りとして扱う
    const parts = buf.split(/[\r\n]/);
    buf = parts.pop() ?? '';
    parts.forEach(emit);
  };
  child.stderr.on('data', onData);
  child.stdout.on('data', onData);

  let done = false;
  const finish = (ok: boolean, error?: string) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    broadcastEvent('git:clone-progress', { id, done: true, ok, error });
  };
  const timer = setTimeout(() => {
    child.kill();
    finish(false, 'タイムアウトのため中断しました');
  }, 600_000);

  child.on('error', (err) => finish(false, err.message));
  child.on('close', (code) => {
    emit(buf);
    if (code === 0) finish(true);
    else finish(false, authHint(all) ?? `git clone exited with code ${code}`);
  });

  res.json({ ok: true, id });
});
