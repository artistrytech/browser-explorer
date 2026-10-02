import { kindLabel } from './paths';
import type { FsEntry, SortKey } from '../types';

/**
 * 一覧の表示順: 隠しファイルの表示設定で絞り込み、フォルダを常に先にして指定キーで並べる。
 * (ファイル一覧と「2 画面で整理」ダイアログで共通)
 */
export function sortEntries(entries: FsEntry[], key: SortKey, asc: boolean, showHidden: boolean): FsEntry[] {
  const filtered = showHidden ? entries : entries.filter((e) => !e.hidden);
  const dir = asc ? 1 : -1;
  return [...filtered].sort((a, b) => {
    const aDir = a.type === 'dir' ? 0 : 1;
    const bDir = b.type === 'dir' ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    let cmp = 0;
    if (key === 'name') cmp = a.name.localeCompare(b.name, 'ja');
    else if (key === 'type') cmp = kindLabel(a).localeCompare(kindLabel(b), 'ja');
    else if (key === 'size') cmp = a.size - b.size;
    else cmp = a.mtime - b.mtime;
    return cmp * dir || a.name.localeCompare(b.name, 'ja');
  });
}
