import { Router } from 'express';
import { getAppConfig } from '../services/appConfigStore.js';
import {
  createTerminal,
  getTerminal,
  killTerminal,
  listShells,
  listTerminals,
  renameTerminal,
  setTerminalListListener,
} from '../services/terminal.js';
import { broadcastEvent } from '../ws/watcher.js';

/**
 * アプリ内のターミナル。セッションの一覧・作成・名前の変更・終了。
 * 入出力は WS (/ws/terminal) で、一覧の変化は WS の terminal:list で全タブへ知らせる。
 */
export const terminalRouter = Router();

setTerminalListListener(() => broadcastEvent('terminal:list', null));

function mustGetId(v: unknown): number {
  const id = Number(v);
  if (!Number.isInteger(id) || !getTerminal(id)) {
    const err = new Error('ターミナルが見つかりません') as Error & { status?: number };
    err.status = 404;
    throw err;
  }
  return id;
}

terminalRouter.get('/', (_req, res) => {
  res.json({
    shells: listShells().map(({ id, label }) => ({ id, label })),
    defaultShell: getAppConfig().terminalShell,
    terminals: listTerminals(),
  });
});

terminalRouter.post('/', (req, res) => {
  const { cwd, shellId, cols, rows } = (req.body ?? {}) as Record<string, unknown>;
  res.json(createTerminal({ cwd, shellId, cols, rows, defaultShellId: getAppConfig().terminalShell }));
});

terminalRouter.patch('/:id', (req, res) => {
  const id = mustGetId(req.params.id);
  const name = (req.body ?? {}).name;
  res.json(renameTerminal(id, typeof name === 'string' ? name : ''));
});

terminalRouter.delete('/:id', (req, res) => {
  res.json({ ok: killTerminal(mustGetId(req.params.id)) });
});
