import { Chevron } from '../../app/FolderTree';
import { baseName } from '../../lib/paths';
import { filesUnder, type FileTreeDir } from '../../lib/fileTree';
import type { CommitFile } from '../../types';
import styles from './CommitFileTree.module.scss';
import { createCssModuleClassNames } from '../../lib/cssModule';

const cx = createCssModuleClassNames(styles);

/**
 * コミットの差分ファイル一覧 (ログタブ / コミット詳細ダイアログ = Stash の詳細) のツリー表示の部品。
 * 表の「ファイル」列の中身を出す (行・ほかの列は呼び出し元の表のスタイルで描く)
 */

/** 一覧 / ツリーの表示形式 (localStorage)。ログタブとコミット詳細ダイアログで共通 */
export const COMMIT_FILE_LIST_MODE_KEY = 'git:commitFileListMode';

/** ツリー表示の 1 階層ぶんの字下げ (px) */
export const COMMIT_TREE_INDENT = 16;

/** ファイル列の左の余白 (表の td の padding-left と同じ 8px に字下げを足す) */
export function treeCellStyle(depth: number): React.CSSProperties {
  return { paddingLeft: 8 + depth * COMMIT_TREE_INDENT };
}

/** フォルダ行のファイル列: 開閉アイコンとフォルダ名 (まとめたフォルダは `a/b/c`) */
export function CommitTreeDirName({ dir, open }: { dir: FileTreeDir<CommitFile>; open: boolean }) {
  return (
    <span className={cx('ct-dir')}>
      <Chevron open={open} />
      {dir.name}
    </span>
  );
}

/** ファイル行のファイル列: ファイル名だけを出す。名前変更は変更前のパスを薄く添える */
export function CommitTreeFileName({ file }: { file: CommitFile }) {
  return (
    <>
      {baseName(file.path)}
      {file.oldPath && <span className={cx('ct-old')}>← {file.oldPath}</span>}
    </>
  );
}

/** フォルダ配下の追加 / 削除行数の合計 (バイナリは数えない) */
export function dirChangeTotals(dir: FileTreeDir<CommitFile>): { added: number; deleted: number } {
  let added = 0;
  let deleted = 0;
  for (const f of filesUnder(dir)) {
    if (f.binary) continue;
    added += f.added ?? 0;
    deleted += f.deleted ?? 0;
  }
  return { added, deleted };
}
