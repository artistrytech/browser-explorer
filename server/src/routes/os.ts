import { Router } from 'express';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getToolById } from '../services/appConfigStore.js';
import { focusExplorerWindow } from '../services/windowFocus.js';

export const osRouter = Router();

osRouter.get('/platform', (_req, res) => {
  res.json({ platform: process.platform });
});

/**
 * 実在するパスを絶対パスに正規化して返す (§4.4: パス検証)。
 * ファイルも受け付け、dir には「開く対象のフォルダ」(ファイルなら親) を入れる。
 */
async function resolveTarget(p: unknown): Promise<{ target: string; dir: string; isDir: boolean }> {
  if (typeof p !== 'string' || p.length === 0) {
    const err = new Error('path is required') as Error & { status?: number };
    err.status = 400;
    throw err;
  }
  const target = path.resolve(p);
  const st = await fs.stat(target); // ENOENT はエラーハンドラで 404 に
  const isDir = st.isDirectory();
  return { target, dir: isDir ? target : path.dirname(target), isDir };
}

/** 外部プロセスは引数配列で spawn しシェル文字列補間を避ける (§4.4) */
export function launch(cmd: string, args: string[], cwd?: string): void {
  const child = spawn(cmd, args, { cwd, detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => {});
  child.unref();
}

/**
 * launch の起動成否を待つ版。Node は spawn 成功時に 'spawn'、失敗時 (実行ファイルが無い等) に
 * 'error' を発火するので、それを待って解決/reject する → 設定ミスを HTTP エラーとして通知できる。
 * verbatim=true は Windows で引数を無加工のまま渡す (explorer の /select,"path" 形式用)。
 */
export function launchChecked(
  cmd: string,
  args: string[],
  cwd?: string,
  opts: { verbatim?: boolean } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      windowsVerbatimArguments: opts.verbatim,
    });
    let settled = false;
    child.on('error', (e: Error) => {
      if (settled) return;
      settled = true;
      const err = e as Error & { status?: number };
      err.status = 400;
      err.message = `起動に失敗しました: ${cmd} (${e.message})`;
      reject(err);
    });
    child.on('spawn', () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve();
    });
  });
}

/**
 * ファイルマネージャで開く。ファイルを指定した場合は親フォルダを開き、
 * そのファイルを選択 (フォーカス) した状態にする。
 */
osRouter.post('/open-in-file-manager', async (req, res) => {
  const { target, dir, isDir } = await resolveTarget(req.body.path);
  if (process.platform === 'win32') {
    // explorer は /select,"<パス>" という 1 つの引数を要求するので、
    // Node による引用符付けを止めて (verbatim) その形のまま渡す
    if (isDir) await launchChecked('explorer.exe', [target]);
    else await launchChecked('explorer.exe', [`/select,"${target}"`], undefined, { verbatim: true });
    // 開いたウィンドウにフォーカスを移す (バックグラウンド起動だと前面に来ないため)
    focusExplorerWindow(dir);
  } else if (process.platform === 'darwin') {
    await launchChecked('open', isDir ? [target] : ['-R', target]); // -R = Finder で選択して表示
  } else {
    // Linux は選択指定の方法がファイルマネージャ依存なので親フォルダを開くだけにする
    await launchChecked('xdg-open', [dir]);
  }
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
  const t = getToolById(tool);
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
  await launchChecked(t.command.trim(), args, path.dirname(targets[0]));
  res.json({ ok: true });
});

/** ターミナルで開く。ファイルを指定した場合はその親フォルダをカレントにする */
osRouter.post('/open-in-terminal', async (req, res) => {
  const { dir } = await resolveTarget(req.body.path);
  if (process.platform === 'win32') {
    // 対象パスをカレントにしてコマンドプロンプトを起動 (start の第 1 引数はウィンドウタイトル)
    await launchChecked('cmd.exe', ['/c', 'start', '', 'cmd.exe'], dir);
  } else if (process.platform === 'darwin') {
    await launchChecked('open', ['-a', 'Terminal', dir]);
  } else {
    await launchChecked('x-terminal-emulator', [], dir);
  }
  res.json({ ok: true });
});
