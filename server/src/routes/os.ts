import { Router } from 'express';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

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
function launch(cmd: string, args: string[], cwd?: string): void {
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
