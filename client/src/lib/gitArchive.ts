import { api } from '../api/client';
import { toastError, useToast } from '../stores/toast';

/**
 * アーカイブ: 対象 (repo 相対パス。空文字ならリポジトリ全体) の HEAD 時点の内容を
 * zip でダウンロードする。作業ツリーの未コミット変更は含まれない。
 * (ファイル一覧の右クリックメニューと Git ツールバーの「ツール」メニューで共通)
 */
export async function downloadArchive(repoRoot: string, rel: string): Promise<void> {
  try {
    const { blob, filename } = await api.gitArchive(repoRoot, rel ? [rel] : []);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    useToast.getState().show('success', `${filename} をダウンロードしました`);
  } catch (e) {
    toastError(e);
  }
}
