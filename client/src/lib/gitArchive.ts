import { api } from '../api/client';
import { toastError, useToast } from '../stores/toast';
import { openLocation } from './openLocation';

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

/** HEAD 時点のリポジトリ全体を一時フォルダへ展開し、展開先をアプリ内で開く */
export async function extractArchiveToTemp(repoRoot: string): Promise<void> {
  const { show } = useToast.getState();
  show('info', '一時フォルダに展開しています…');
  try {
    const { path } = await api.gitExtractArchive(repoRoot);
    openLocation(path);
    show('success', `${path} に展開しました`);
  } catch (e) {
    toastError(e);
  }
}
