import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import trash from 'trash';
import {
  listVolumes,
  listDir,
  statEntry,
  searchByName,
  uniqueDest,
  norm,
  homeDir,
} from '../services/fsService.js';
import { decodeBuffer, encodeContent, isProbablyBinary, Eol } from '../services/encoding.js';

const MAX_READ_SIZE = 20 * 1024 * 1024; // 20MB

export const fsRouter = Router();

function reqPath(v: unknown): string {
  if (typeof v !== 'string' || v.length === 0) {
    const err = new Error('path is required') as Error & { status?: number };
    err.status = 400;
    throw err;
  }
  // ドライブ付き絶対パスへ解決して '/' 区切りに統一する。
  // Windows で '/' のようなドライブレター無しパスをそのまま扱うと、
  // git の repoRoot (C:/...) とのパス比較が全て外れてしまう。
  return norm(path.resolve(v));
}

/**
 * リネーム後の「名前」の検証。
 * 名前はパスではないので reqPath (path.resolve) は通さない
 * — 通すと "3.txt" が "C:/.../3.txt" へ絶対パス化され、常に区切り文字を含む扱いになってしまう。
 * パス区切りと . / .. 、Windows でファイル名に使えない文字だけを拒否する。
 */
function reqName(v: unknown): string {
  const name = typeof v === 'string' ? v : '';
  const invalid =
    name.length === 0 ||
    name === '.' ||
    name === '..' ||
    /[/\\]/.test(name) ||
    // eslint-disable-next-line no-control-regex
    (process.platform === 'win32' && /[<>:"|?*\x00-\x1f]/.test(name));
  if (invalid) {
    const err = new Error('名前に使用できない文字が含まれています') as Error & {
      status?: number;
      code?: string;
    };
    err.status = 400;
    err.code = 'bad_name';
    throw err;
  }
  return name;
}

/** 存在確認 (リネーム先の重複チェック用) */
async function exists(target: string): Promise<boolean> {
  return fs
    .access(target)
    .then(() => true)
    .catch(() => false);
}

fsRouter.get('/volumes', async (_req, res) => {
  res.json({ volumes: await listVolumes(), home: homeDir() });
});

fsRouter.get('/list', async (req, res) => {
  const p = reqPath(req.query.path);
  // パス入力にファイルが指定されるのは通常操作で起こり得る (クライアント側でファイルを開く救済をする) ので、
  // readdir の ENOTDIR (500 扱い) にせず 4xx で返す
  const st = await fs.stat(p);
  if (!st.isDirectory()) {
    res.status(400).json({ error: 'not_dir', message: 'フォルダではありません' });
    return;
  }
  res.json({ path: norm(p), entries: await listDir(p) });
});

fsRouter.get('/stat', async (req, res) => {
  res.json(await statEntry(reqPath(req.query.path)));
});

fsRouter.get('/read', async (req, res) => {
  const p = reqPath(req.query.path);
  const st = await fs.stat(p);
  if (st.size > MAX_READ_SIZE) {
    res.status(413).json({ error: 'too_large', message: 'ファイルが大きすぎます (20MB 超)' });
    return;
  }
  const buf = await fs.readFile(p);
  if (!req.query.encoding && isProbablyBinary(buf)) {
    res.status(415).json({ error: 'binary', message: 'バイナリファイルのため開けません' });
    return;
  }
  const forced = typeof req.query.encoding === 'string' ? req.query.encoding : undefined;
  const result = decodeBuffer(buf, forced);
  res.json({ path: norm(p), ...result, size: st.size, mtime: st.mtimeMs });
});

/**
 * ファイルの内容をそのまま返す (Markdown プレビュー内の相対パス画像等)。
 * Content-Type は拡張子から判定。上限は /read と同じ。
 */
fsRouter.get('/raw', async (req, res, next) => {
  const p = reqPath(req.query.path);
  const st = await fs.stat(p);
  if (!st.isFile()) {
    res.status(400).json({ error: 'not_file', message: 'ファイルではありません' });
    return;
  }
  if (st.size > MAX_READ_SIZE) {
    res.status(413).json({ error: 'too_large', message: 'ファイルが大きすぎます (20MB 超)' });
    return;
  }
  res.sendFile(path.resolve(p), { dotfiles: 'allow' }, (err) => {
    if (err) next(err);
  });
});

fsRouter.post('/write', async (req, res) => {
  const { path: p, content, encoding, eol, bom } = req.body as {
    path: string;
    content: string;
    encoding?: string;
    eol?: Eol;
    bom?: boolean;
  };
  reqPath(p);
  const buf = encodeContent(content ?? '', encoding ?? 'UTF-8', eol, bom);
  await fs.writeFile(p, buf);
  const st = await fs.stat(p);
  res.json({ ok: true, size: st.size, mtime: st.mtimeMs });
});

fsRouter.post('/mkdir', async (req, res) => {
  const p = reqPath(req.body.path);
  await fs.mkdir(p, { recursive: false });
  res.json({ ok: true, path: norm(p) });
});

fsRouter.post('/create', async (req, res) => {
  const p = reqPath(req.body.path);
  await fs.writeFile(p, '', { flag: 'wx' }); // 既存があれば失敗
  res.json({ ok: true, path: norm(p) });
});

fsRouter.post('/rename', async (req, res) => {
  const p = reqPath(req.body.path);
  const newName = reqName(req.body.newName);
  const dest = path.join(path.dirname(p), newName);
  // 既存の別ファイル/フォルダを黙って上書きしない (大文字小文字だけの変更は同じ対象なので許可)
  if (norm(dest).toLowerCase() !== norm(p).toLowerCase() && (await exists(dest))) {
    res.status(409).json({ error: 'exists', message: '同じ名前のファイル/フォルダが既に存在します' });
    return;
  }
  await fs.rename(p, dest);
  res.json({ ok: true, path: norm(dest) });
});

fsRouter.post('/move', async (req, res) => {
  const { src, destDir } = req.body as { src: string[]; destDir: string };
  reqPath(destDir);
  const moved: string[] = [];
  for (const s of src ?? []) {
    if (norm(path.dirname(s)) === norm(destDir)) continue; // 同一フォルダへの移動は無視
    const dest = await uniqueDest(destDir, path.basename(s));
    await fs.rename(s, dest).catch(async (e: NodeJS.ErrnoException) => {
      if (e.code === 'EXDEV') {
        // 別ドライブ間はコピー + 削除
        await fs.cp(s, dest, { recursive: true });
        await fs.rm(s, { recursive: true });
      } else {
        throw e;
      }
    });
    moved.push(norm(dest));
  }
  res.json({ ok: true, moved });
});

fsRouter.post('/copy', async (req, res) => {
  const { src, destDir } = req.body as { src: string[]; destDir: string };
  reqPath(destDir);
  const copied: string[] = [];
  for (const s of src ?? []) {
    const dest = await uniqueDest(destDir, path.basename(s));
    await fs.cp(s, dest, { recursive: true });
    copied.push(norm(dest));
  }
  res.json({ ok: true, copied });
});

// --- 確認付きのコピー / 移動 (2 画面で整理ダイアログ用) ---

type TransferOp = 'move' | 'copy';
/** 衝突時の扱い: 上書き (既存はゴミ箱へ) / 両方残す (連番) / スキップ */
type OnConflict = 'overwrite' | 'rename' | 'skip';

/** Windows はパスの大文字小文字を区別しない */
function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** p が root 自身またはその配下か (いずれも norm 済みの絶対パス) */
function isSameOrUnder(p: string, root: string): boolean {
  if (samePath(p, root)) return true;
  const prefix = root.endsWith('/') ? root : `${root}/`;
  return process.platform === 'win32'
    ? p.toLowerCase().startsWith(prefix.toLowerCase())
    : p.startsWith(prefix);
}

function entryType(st: { isDirectory(): boolean; isSymbolicLink(): boolean }): 'dir' | 'file' | 'symlink' {
  return st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : 'file';
}

/** ファイル操作のエラーを利用者向けの文言にする */
function transferErrorMessage(e: unknown): string {
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT') return '見つかりません (移動・削除された可能性があります)';
  if (code === 'EACCES' || code === 'EPERM') return 'アクセスが拒否されました';
  if (code === 'EBUSY') return '使用中のため操作できません';
  if (code === 'ENOSPC') return 'ディスクの空き容量が不足しています';
  return e instanceof Error ? e.message : String(e);
}

/**
 * 実行前の確認: 対象ごとの情報と、コピー先での衝突 (同名の既存項目) を返す。
 * - sameDir: コピー先が対象の親フォルダ (移動は不可、コピーは自分自身と衝突する)
 * - intoSelf: コピー先が対象自身またはその配下 (移動・コピーとも不可)
 */
fsRouter.post('/transfer/check', async (req, res) => {
  const { src, destDir: rawDest } = req.body as { src: string[]; destDir: string };
  const destDir = reqPath(rawDest);
  if (!Array.isArray(src) || src.length === 0) {
    res.status(400).json({ error: 'bad_request', message: 'src is required' });
    return;
  }
  const destSt = await fs.stat(destDir);
  if (!destSt.isDirectory()) {
    res.status(400).json({ error: 'not_dir', message: 'コピー先がフォルダではありません' });
    return;
  }
  const items = await Promise.all(
    src.map(async (raw) => {
      const s = reqPath(raw);
      const name = path.basename(s);
      const dest = norm(path.join(destDir, name));
      const st = await fs.lstat(s).catch(() => null);
      if (!st) return { src: s, name, dest, missing: true };
      const sameDir = samePath(norm(path.dirname(s)), destDir);
      const intoSelf = isSameOrUnder(destDir, s);
      const existing = sameDir ? st : await fs.lstat(dest).catch(() => null);
      return {
        src: s,
        name,
        dest,
        type: entryType(st),
        size: st.isDirectory() ? 0 : st.size,
        mtime: st.mtimeMs,
        sameDir,
        intoSelf,
        conflict: existing
          ? {
              type: entryType(existing),
              size: existing.isDirectory() ? 0 : existing.size,
              mtime: existing.mtimeMs,
            }
          : null,
      };
    }),
  );
  res.json({ destDir, items });
});

/**
 * コピー / 移動の実行。項目ごとに衝突時の扱いを指定でき、途中で失敗しても残りを続けて
 * 項目ごとの結果を返す (status は done / skipped / error)。
 * 事前確認の後に状況が変わって新たに衝突した場合は onConflict 未指定扱い = 両方残す (安全側)。
 */
fsRouter.post('/transfer', async (req, res) => {
  const { op, destDir: rawDest, items } = req.body as {
    op: TransferOp;
    destDir: string;
    items: { src: string; onConflict?: OnConflict }[];
  };
  if (op !== 'move' && op !== 'copy') {
    res.status(400).json({ error: 'bad_request', message: 'op must be move or copy' });
    return;
  }
  const destDir = reqPath(rawDest);
  const results: { src: string; status: 'done' | 'skipped' | 'error'; dest?: string; message?: string }[] = [];
  for (const item of items ?? []) {
    const s = reqPath(item.src);
    try {
      const st = await fs.lstat(s);
      const sameDir = samePath(norm(path.dirname(s)), destDir);
      if (isSameOrUnder(destDir, s)) {
        results.push({ src: s, status: 'error', message: '自分自身またはその配下へは移動・コピーできません' });
        continue;
      }
      if (op === 'move' && sameDir) {
        results.push({ src: s, status: 'skipped', message: '同じフォルダへの移動のため何もしません' });
        continue;
      }
      let dest = path.join(destDir, path.basename(s));
      const existing = sameDir ? st : await fs.lstat(dest).catch(() => null);
      if (existing) {
        const onConflict = item.onConflict ?? 'rename';
        if (onConflict === 'skip') {
          results.push({ src: s, status: 'skipped', message: '同名の項目があるためスキップしました' });
          continue;
        }
        if (onConflict === 'overwrite') {
          if (sameDir) {
            results.push({ src: s, status: 'error', message: '自分自身は上書きできません' });
            continue;
          }
          if (existing.isDirectory() !== st.isDirectory()) {
            results.push({ src: s, status: 'error', message: 'ファイルとフォルダの間では上書きできません' });
            continue;
          }
          // 上書き先が移動元を含むフォルダだと、ゴミ箱へ送ると移動元ごと消えてしまう
          if (isSameOrUnder(s, norm(dest))) {
            results.push({ src: s, status: 'error', message: '移動元を含むフォルダは上書きできません' });
            continue;
          }
          // 上書きされる側は完全には消さずゴミ箱へ送る
          await trash([path.normalize(dest)]);
        } else {
          dest = await uniqueDest(destDir, path.basename(s));
        }
      }
      if (op === 'copy') {
        await fs.cp(s, dest, { recursive: true });
      } else {
        await fs.rename(s, dest).catch(async (e: NodeJS.ErrnoException) => {
          if (e.code !== 'EXDEV') throw e;
          // 別ドライブ間はコピー + 削除
          await fs.cp(s, dest, { recursive: true });
          await fs.rm(s, { recursive: true });
        });
      }
      results.push({ src: s, status: 'done', dest: norm(dest) });
    } catch (e) {
      results.push({ src: s, status: 'error', message: transferErrorMessage(e) });
    }
  }
  res.json({ results });
});

fsRouter.delete('/delete', async (req, res) => {
  const { paths, permanent } = req.body as { paths: string[]; permanent?: boolean };
  if (!Array.isArray(paths) || paths.length === 0) {
    res.status(400).json({ error: 'bad_request', message: 'paths is required' });
    return;
  }
  if (permanent === true) {
    for (const p of paths) {
      await fs.rm(p, { recursive: true, force: true });
    }
  } else {
    await trash(paths.map((p) => path.normalize(p)));
  }
  res.json({ ok: true });
});

fsRouter.get('/search', async (req, res) => {
  const dir = reqPath(req.query.dir);
  // query はパスではなく検索文字列 (reqPath を通すと絶対パス化されて一致しなくなる)
  const query = req.query.query;
  if (typeof query !== 'string' || query.trim().length === 0) {
    res.status(400).json({ error: 'bad_request', message: 'query is required' });
    return;
  }
  res.json({ results: await searchByName(dir, query.trim()) });
});
