import { Router } from 'express';
import fs from 'node:fs/promises';
import {
  listFavorites,
  addFavoriteRow,
  removeFavoriteRow,
  reorderFavorites,
} from '../services/stateStore.js';
import { norm } from '../services/fsService.js';

export const quickaccessRouter = Router();

quickaccessRouter.get('/', (_req, res) => {
  res.json({ favorites: listFavorites() });
});

/** ピン止め追加 (§7.2)。存在しないパス・フォルダ以外は拒否、重複は added:false */
quickaccessRouter.post('/', async (req, res) => {
  const { path: p, label } = req.body as { path?: string; label?: string };
  if (typeof p !== 'string' || p.length === 0) {
    res.status(400).json({ error: 'bad_request', message: 'path is required' });
    return;
  }
  const st = await fs.stat(p); // ENOENT → 404
  if (!st.isDirectory()) {
    res.status(400).json({ error: 'bad_request', message: 'フォルダのみピン止めできます' });
    return;
  }
  const normalized = norm(p);
  const defaultLabel = normalized.replace(/\/+$/, '').split('/').pop() || normalized;
  const added = addFavoriteRow(normalized, label || defaultLabel);
  res.json({ ok: true, added, favorites: listFavorites() });
});

/** ピン止め解除 (§7.3)。ブックマークの除去のみで実フォルダには影響しない */
quickaccessRouter.delete('/', (req, res) => {
  const { path: p } = req.body as { path?: string };
  if (typeof p !== 'string' || p.length === 0) {
    res.status(400).json({ error: 'bad_request', message: 'path is required' });
    return;
  }
  const removed = removeFavoriteRow(norm(p));
  res.json({ ok: true, removed, favorites: listFavorites() });
});

quickaccessRouter.post('/reorder', (req, res) => {
  const { paths } = req.body as { paths?: string[] };
  if (!Array.isArray(paths)) {
    res.status(400).json({ error: 'bad_request', message: 'paths is required' });
    return;
  }
  reorderFavorites(paths.map(norm));
  res.json({ ok: true, favorites: listFavorites() });
});
