import { api } from '../api/client';

/**
 * 「新規ファイル」のサブメニューに出す拡張子 (サーバの DB に記録した履歴、新しい順)。
 * メニューは同期的に組み立てるので、起動時と作成後に取得して手元に持っておく
 */
let exts: string[] = [];

/** 拡張子の候補 (先頭の '.' 無し)。履歴が無ければ txt のみ */
export function newFileExts(): string[] {
  return exts.length > 0 ? exts : ['txt'];
}

export async function loadNewFileExts(): Promise<void> {
  try {
    exts = (await api.newFileExts()).exts;
  } catch {
    // 取得できなければ前回の候補のまま
  }
}
