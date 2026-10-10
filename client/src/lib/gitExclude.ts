import { api } from '../api/client';
import { promptDialog } from '../stores/dialog';
import { useExplorer } from '../stores/explorer';
import { useGit } from '../stores/git';
import { toastError, useToast } from '../stores/toast';

/**
 * 除外パターンの既定値: リポジトリルートからのパス完全一致。
 * 先頭 '/' でルート起点に固定し、gitignore のメタ文字と末尾スペースはエスケープする。
 * フォルダは末尾に '/' を付けてフォルダのみに一致させる。
 */
export function defaultExcludePattern(relPath: string, isDir = false): string {
  const escaped = relPath.replace(/[\\*?[\]]/g, (c) => `\\${c}`).replace(/ +$/, (s) => '\\ '.repeat(s.length));
  return `/${escaped}${isDir ? '/' : ''}`;
}

/**
 * 未追跡ファイル (フォルダ) を .git/info/exclude に追加する (.gitignore と違いコミットされない)。
 * 追加するパターンはダイアログで編集でき、既定はパス完全一致。
 * 追加後は Git の状態とファイル一覧を更新する。
 */
export async function excludeUntracked(repoRoot: string, relPath: string, isDir = false): Promise<void> {
  const input = await promptDialog('未追跡ファイルを除外する', defaultExcludePattern(relPath, isDir), {
    message:
      `${relPath} を .git/info/exclude に追加します\n` +
      '(このリポジトリのローカル設定で、コミットも共有もされません)。\n' +
      'パターンは編集できます (既定はパス完全一致)。',
  });
  if (input === null) return;
  const pattern = input.trim();
  if (!pattern) return;
  try {
    const { added } = await api.gitExclude(repoRoot, pattern);
    useToast
      .getState()
      .show('success', added ? `除外に追加しました: ${pattern}` : `既に除外されています: ${pattern}`);
    await useGit.getState().refreshStatus();
    void useExplorer.getState().refresh();
  } catch (e) {
    toastError(e);
  }
}
