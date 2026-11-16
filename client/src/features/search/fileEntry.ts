import type { FsEntry } from '../../types';

/**
 * 検索結果のパス (インデックスのファイル) から一覧の項目と同じ形を作る。
 * アイコンの選択や openWithDefault に渡すため (サイズ・更新日時は使わないので 0)
 */
export function fileEntryOf(path: string): FsEntry {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return {
    name,
    path,
    type: 'file',
    size: 0,
    mtime: 0,
    hidden: name.startsWith('.'),
    ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : '',
  };
}
