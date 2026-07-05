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
  return v;
}

fsRouter.get('/volumes', async (_req, res) => {
  res.json({ volumes: await listVolumes(), home: homeDir() });
});

fsRouter.get('/list', async (req, res) => {
  const p = reqPath(req.query.path);
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
  const newName = reqPath(req.body.newName);
  if (newName.includes('/') || newName.includes('\\')) {
    res.status(400).json({ error: 'bad_name', message: '名前に使用できない文字が含まれています' });
    return;
  }
  const dest = path.join(path.dirname(p), newName);
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
  const query = reqPath(req.query.query);
  res.json({ results: await searchByName(dir, query) });
});
