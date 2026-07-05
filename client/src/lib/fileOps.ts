import { api } from '../api/client';
import { useExplorer } from '../stores/explorer';
import { useEditor } from '../stores/editor';
import { useGit } from '../stores/git';
import { useToast, toastError } from '../stores/toast';
import { confirmDialog, promptDialog } from '../stores/dialog';
import { joinPath, baseName, formatSize, formatDate, parentPath } from './paths';
import { saveEnteredChild } from './focusMemory';
import type { FsEntry } from '../types';

/** サブフォルダへ入る直前に親パスの focus を「今入る子」に更新 (002.md §6.3) */
function rememberEnteredChild(entry: FsEntry): void {
  const ex = useExplorer.getState();
  if (parentPath(entry.path) !== ex.path) return; // 検索結果など別階層は対象外
  const idx = ex.entries.findIndex((e) => e.path === entry.path);
  saveEnteredChild(ex.path, entry.name, idx);
}

/** エントリを開く: フォルダなら移動、ファイルならエディタ */
export function openEntry(entry: FsEntry): void {
  if (entry.type === 'dir' || (entry.type === 'symlink' && entry.linkTarget)) {
    rememberEnteredChild(entry);
    if (entry.type === 'symlink') {
      // リンクは実体を stat して判断
      void api
        .stat(entry.path)
        .then((st) =>
          st.type === 'dir' || st.type === 'symlink'
            ? useExplorer.getState().navigate(entry.path)
            : useEditor.getState().open(entry.path),
        )
        .catch(toastError);
      return;
    }
    void useExplorer.getState().navigate(entry.path);
  } else {
    void useEditor.getState().open(entry.path);
  }
}

export function copySelection(): void {
  const { selection, setClipboard } = useExplorer.getState();
  if (selection.length === 0) return;
  setClipboard({ op: 'copy', paths: [...selection] });
  useToast.getState().show('info', `${selection.length} 項目をコピーしました`);
}

export function cutSelection(): void {
  const { selection, setClipboard } = useExplorer.getState();
  if (selection.length === 0) return;
  setClipboard({ op: 'cut', paths: [...selection] });
  useToast.getState().show('info', `${selection.length} 項目を切り取りました`);
}

export async function paste(destDir?: string): Promise<void> {
  const ex = useExplorer.getState();
  const clipboard = ex.clipboard;
  if (!clipboard || clipboard.paths.length === 0) return;
  const dest = destDir ?? ex.path;
  try {
    if (clipboard.op === 'copy') {
      await api.copy(clipboard.paths, dest);
    } else {
      await api.move(clipboard.paths, dest);
      ex.setClipboard(null); // 切り取りは 1 回で消費
    }
    await ex.refresh();
    void useGit.getState().refreshStatus();
  } catch (e) {
    toastError(e);
  }
}

export async function deleteSelection(permanent: boolean): Promise<void> {
  const ex = useExplorer.getState();
  if (ex.selection.length === 0) return;
  const names = ex.selection.map(baseName).slice(0, 5).join(', ');
  const suffix = ex.selection.length > 5 ? ` ほか ${ex.selection.length - 5} 項目` : '';
  if (permanent) {
    const ok = await confirmDialog(
      '完全に削除',
      `${names}${suffix} を完全に削除します。この操作は取り消せません。よろしいですか?`,
      true,
    );
    if (!ok) return;
  }
  try {
    await api.delete(ex.selection, permanent);
    useToast
      .getState()
      .show('success', permanent ? '完全に削除しました' : 'ゴミ箱に移動しました');
    await ex.refresh();
    void useGit.getState().refreshStatus();
  } catch (e) {
    toastError(e);
  }
}

export async function createFolder(): Promise<void> {
  const ex = useExplorer.getState();
  const name = await promptDialog('新規フォルダ', '新しいフォルダ');
  if (!name) return;
  try {
    await api.mkdir(joinPath(ex.path, name));
    await ex.refresh();
  } catch (e) {
    toastError(e);
  }
}

export async function createFile(): Promise<void> {
  const ex = useExplorer.getState();
  const name = await promptDialog('新規ファイル', '新規テキスト.txt', { selectStem: true });
  if (!name) return;
  try {
    await api.create(joinPath(ex.path, name));
    await ex.refresh();
  } catch (e) {
    toastError(e);
  }
}

export async function renameEntry(path: string, newName: string): Promise<void> {
  const ex = useExplorer.getState();
  try {
    await api.rename(path, newName);
    await ex.refresh();
    void useGit.getState().refreshStatus();
  } catch (e) {
    toastError(e);
  }
}

export async function showProperties(entry: FsEntry): Promise<void> {
  try {
    const st = await api.stat(entry.path);
    const lines = [
      `パス: ${st.path}`,
      `種類: ${st.type === 'dir' ? 'フォルダ' : st.type === 'symlink' ? `リンク → ${st.linkTarget ?? '?'}` : 'ファイル'}`,
      `サイズ: ${formatSize(st.size, st.type === 'dir')}`,
      `更新日時: ${formatDate(st.mtime)}`,
      `作成日時: ${formatDate(st.ctime)}`,
      `属性: ${st.hidden ? '隠しファイル' : '通常'} / mode ${(st.mode & 0o777).toString(8)}`,
    ];
    await confirmDialog(`${st.name} のプロパティ`, lines.join('\n'));
  } catch (e) {
    toastError(e);
  }
}
