import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * 外部コマンドの場所の解決と起動方法 (AI チャットの CLI・言語サーバで共通)。
 */

/** Windows で直接起動できる拡張子 (where は拡張子なしの sh スクリプトも返すので除く) */
const WIN_EXEC_EXT = ['.exe', '.cmd', '.bat', '.com'];

/** PATH からコマンドを探す。見つからなければ null */
export async function which(cmd: string): Promise<string | null> {
  try {
    const finder = process.platform === 'win32' ? 'where.exe' : 'which';
    const { stdout } = await execFileAsync(finder, [cmd], { windowsHide: true, timeout: 10_000 });
    const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (process.platform !== 'win32') return lines[0] ?? null;
    return lines.find((l) => WIN_EXEC_EXT.includes(path.extname(l).toLowerCase())) ?? null;
  } catch {
    return null;
  }
}

/** .cmd / .bat は cmd.exe 経由でないと起動できない (Node は shell: true を要求する) */
export function needsShell(file: string): boolean {
  return process.platform === 'win32' && ['.cmd', '.bat'].includes(path.extname(file).toLowerCase());
}
