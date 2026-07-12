import { Router } from 'express';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

export const osRouter = Router();

osRouter.get('/platform', (_req, res) => {
  res.json({ platform: process.platform });
});

/** 実在するディレクトリの絶対パスに正規化して返す (§4.4: パス検証) */
async function resolveDir(p: unknown): Promise<string> {
  if (typeof p !== 'string' || p.length === 0) {
    const err = new Error('path is required') as Error & { status?: number };
    err.status = 400;
    throw err;
  }
  const resolved = path.resolve(p);
  const st = await fs.stat(resolved); // ENOENT はエラーハンドラで 404 に
  if (!st.isDirectory()) {
    const err = new Error('path must be a directory') as Error & { status?: number };
    err.status = 400;
    throw err;
  }
  return resolved;
}

/** 外部プロセスは引数配列で spawn しシェル文字列補間を避ける (§4.4) */
export function launch(cmd: string, args: string[], cwd?: string): void {
  const child = spawn(cmd, args, { cwd, detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => {});
  child.unref();
}

osRouter.post('/open-in-file-manager', async (req, res) => {
  const dir = await resolveDir(req.body.path);
  if (process.platform === 'win32') launch('explorer.exe', [dir]);
  else if (process.platform === 'darwin') launch('open', [dir]);
  else launch('xdg-open', [dir]);
  res.json({ ok: true });
});

/**
 * 外部ツール起動 (config.jsonc の externalTools)。
 * クライアントが送るのはツールの index と対象パスのみで、実行するコマンドと引数の雛形は
 * サーバ側の設定からしか参照しない → 設定されたツール以外は実行できない (§安全性)。
 * spawn は引数配列 (シェル無し) で行い、パス中の特殊文字も解釈されない。
 */
osRouter.post('/run-tool', async (req, res) => {
  const { tool, paths } = (req.body ?? {}) as { tool?: unknown; paths?: unknown };
  const tools = config.externalTools ?? [];
  const t = typeof tool === 'number' && Number.isInteger(tool) && tool >= 0 ? tools[tool] : undefined;
  if (!t || typeof t.command !== 'string' || t.command.trim().length === 0) {
    const err = new Error('unknown tool') as Error & { status?: number };
    err.status = 400;
    throw err;
  }
  if (
    !Array.isArray(paths) ||
    paths.length === 0 ||
    paths.some((p) => typeof p !== 'string' || p.length === 0)
  ) {
    const err = new Error('paths must be a non-empty string[]') as Error & { status?: number };
    err.status = 400;
    throw err;
  }
  // 対象パスは実在するものだけ許可 (ENOENT はエラーハンドラで 404 に)
  const targets: string[] = [];
  for (const p of paths as string[]) {
    const resolved = path.resolve(p);
    await fs.stat(resolved);
    targets.push(resolved);
  }
  // 引数組み立て: "${paths}" を対象パス群に展開。プレースホルダが無ければ末尾に追加
  const template = Array.isArray(t.args) ? t.args.filter((a): a is string => typeof a === 'string') : [];
  const args: string[] = [];
  let expanded = false;
  for (const a of template) {
    if (a === '${paths}') {
      args.push(...targets);
      expanded = true;
    } else {
      args.push(a);
    }
  }
  if (!expanded) args.push(...targets);
  launch(t.command.trim(), args, path.dirname(targets[0]));
  res.json({ ok: true });
});

osRouter.post('/open-in-terminal', async (req, res) => {
  const dir = await resolveDir(req.body.path);
  if (process.platform === 'win32') {
    // 対象パスをカレントにしてコマンドプロンプトを起動 (start の第 1 引数はウィンドウタイトル)
    launch('cmd.exe', ['/c', 'start', '', 'cmd.exe'], dir);
  } else if (process.platform === 'darwin') {
    launch('open', ['-a', 'Terminal', dir]);
  } else {
    launch('x-terminal-emulator', [], dir);
  }
  res.json({ ok: true });
});
