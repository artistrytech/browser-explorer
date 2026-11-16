import { Router } from 'express';
import { execFile } from 'node:child_process';
import { norm } from '../services/fsService.js';
import {
  disableIndex,
  enableIndex,
  getIndexStatus,
  listIndexStatuses,
  rescanIndex,
  searchIndexedContent,
  searchIndexedFiles,
  SearchIndexError,
  updateIndexSettings,
} from '../services/searchIndex.js';

/**
 * 検索インデックス (services/searchIndex.ts)。
 * repo は Git リポジトリのルート (クライアントの repoRoot)。有効化のときだけ実際にルートかを確かめる。
 * SearchIndexError は status (400 / 409) 付きなので、共通のエラーハンドラがそのまま返す。
 */
export const searchIndexRouter = Router();

function str(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v) throw new SearchIndexError(400, `${name} is required`);
  return v;
}

/** path が Git リポジトリのルートならその正規化したパスを返す */
function gitTopLevel(p: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', ['rev-parse', '--show-toplevel'], { cwd: p, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : norm(stdout.trim()));
    });
  });
}

const same = (a: string, b: string) =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

searchIndexRouter.get('/status', (req, res) => {
  res.json(getIndexStatus(str(req.query.repo, 'repo')));
});

searchIndexRouter.get('/list', (_req, res) => {
  res.json({ indexes: listIndexStatuses() });
});

searchIndexRouter.post('/enable', async (req, res) => {
  const repo = norm(str(req.body?.repo, 'repo')).replace(/\/+$/, '');
  const top = await gitTopLevel(repo);
  if (!top || !same(top, repo)) {
    throw new SearchIndexError(400, 'Git リポジトリのルートではありません');
  }
  res.json(enableIndex(top, req.body?.settings));
});

searchIndexRouter.post('/disable', async (req, res) => {
  res.json(await disableIndex(str(req.body?.repo, 'repo')));
});

searchIndexRouter.put('/settings', async (req, res) => {
  res.json(await updateIndexSettings(str(req.body?.repo, 'repo'), req.body?.settings));
});

searchIndexRouter.post('/rescan', (req, res) => {
  res.json(rescanIndex(str(req.body?.repo, 'repo'), req.body?.rebuild === true));
});

/** ファイル名のあいまい検索 (クイックオープン) */
searchIndexRouter.get('/files', (req, res) => {
  const repo = str(req.query.repo, 'repo');
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
  res.json({ items: searchIndexedFiles(repo, q, limit) });
});

/** 内容の検索。クライアントが要求を取り消したら (入力を続けた等) 途中でやめる */
searchIndexRouter.post('/search', async (req, res) => {
  const b = req.body ?? {};
  const repo = str(b.repo, 'repo');
  const query = typeof b.query === 'string' ? b.query : '';
  if (!query) {
    res.json({ files: [], matchCount: 0, truncated: false, searchedFiles: 0, elapsedMs: 0, building: false });
    return;
  }
  let aborted = false;
  res.on('close', () => {
    if (!res.writableFinished) aborted = true;
  });
  const result = await searchIndexedContent(
    repo,
    {
      query,
      matchCase: b.matchCase === true,
      wholeWord: b.wholeWord === true,
      regex: b.regex === true,
      include: typeof b.include === 'string' ? b.include : '',
      exclude: typeof b.exclude === 'string' ? b.exclude : '',
      maxResults: Math.min(Math.max(Number(b.maxResults) || 5000, 1), 20000),
    },
    () => aborted,
  );
  if (!aborted) res.json(result);
});

