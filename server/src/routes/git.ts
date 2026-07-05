import { Router } from 'express';
import { simpleGit, SimpleGit } from 'simple-git';
import { norm } from '../services/fsService.js';

export const gitRouter = Router();

function git(repo: unknown): SimpleGit {
  if (typeof repo !== 'string' || repo.length === 0) {
    const err = new Error('repo is required') as Error & { status?: number };
    err.status = 400;
    throw err;
  }
  return simpleGit(repo);
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
  const log = await g.log({
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
  });
  res.json({ commits: log.all });
});

gitRouter.get('/show', async (req, res) => {
  const g = git(req.query.repo);
  const hash = String(req.query.hash ?? '');
  const body = await g.show([hash, '--stat', '--patch', '--format=%H%n%an%n%ad%n%B%x00', '--date=iso']);
  const [meta, patch] = body.split('\0');
  const [h, author, date, ...msg] = meta.split('\n');
  res.json({ hash: h, author, date, message: msg.join('\n').trim(), patch: patch ?? '' });
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

gitRouter.post('/clone', async (req, res) => {
  const { url, dir } = req.body as { url: string; dir: string };
  await simpleGit().clone(url, dir);
  res.json({ ok: true });
});
