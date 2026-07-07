import { Router } from 'express';
import { simpleGit, SimpleGit } from 'simple-git';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { norm } from '../services/fsService.js';
import { broadcastEvent } from '../ws/watcher.js';
import { config } from '../config.js';

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
  // 表示上限 (config.json の commitFilesLimit)。絞り込みはクライアント側で全件に対して行う
  const limit = Math.max(1, Number(config.commitFilesLimit) || 100);
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

gitRouter.get('/diff', async (req, res) => {
  const g = git(req.query.repo);
  const p = typeof req.query.path === 'string' ? req.query.path : undefined;
  const staged = req.query.staged === 'true';
  const args: string[] = [];
  if (staged) args.push('--cached');
  if (p) args.push('--', p);
  const diff = await g.diff(args);
  res.json({ diff });
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
  res.json({ current: b.current, branches: Object.values(b.branches) });
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
  const child = spawn('git', args, {
    cwd: repo,
    windowsHide: true,
    env: { ...process.env, GIT_EDITOR: 'true', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' },
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
    res.json({ ok, code, command, output: extra ? `${output}${output ? '\n' : ''}${extra}` : output });
  };
  const timer = setTimeout(() => {
    child.kill();
    reply(false, -1, '(タイムアウトのため中断しました)');
  }, 120_000);
  child.on('error', (err) => reply(false, -1, err.message));
  child.on('close', (code) => reply(code === 0, code ?? -1));
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

  const child = spawn('git', args, { windowsHide: true });
  const emit = (line: string) => {
    if (line.trim()) broadcastEvent('git:clone-progress', { id, line: line.trim() });
  };
  let buf = '';
  const onData = (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    // \r (進捗の上書き行) と \n の両方を行区切りとして扱う
    const parts = buf.split(/[\r\n]/);
    buf = parts.pop() ?? '';
    parts.forEach(emit);
  };
  child.stderr.on('data', onData);
  child.stdout.on('data', onData);
  child.on('error', (err) => {
    broadcastEvent('git:clone-progress', { id, done: true, ok: false, error: err.message });
  });
  child.on('close', (code) => {
    emit(buf);
    broadcastEvent('git:clone-progress', {
      id,
      done: true,
      ok: code === 0,
      error: code === 0 ? undefined : `git clone exited with code ${code}`,
    });
  });

  res.json({ ok: true, id });
});
