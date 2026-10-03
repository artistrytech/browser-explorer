import { useSettings } from '../stores/settings';
import { useToast } from '../stores/toast';
import { confirmDialog } from '../stores/dialog';

/** フォルダをクイックアクセスにピン止め (002.md §7.2) */
export async function pinFolder(path: string, label: string): Promise<void> {
  await useSettings.getState().addFavorite({ path, label });
}

/**
 * ピン止めを解除 (002.md §7.3)。解除の前に確認ダイアログを必須とし、
 * 実フォルダには影響しない旨を明記する。
 */
export async function unpinFolder(path: string, label: string): Promise<void> {
  const ok = await confirmDialog(
    'ピン止めの解除',
    `「${label}」をクイックアクセスから外しますか?\n\n※ ブックマークを外すだけで、フォルダ本体は削除されません。`,
  );
  if (!ok) return;
  await useSettings.getState().removeFavorite(path);
  useToast.getState().show('success', 'ピン止めを解除しました');
}

/**
 * サイドバーの「リポジトリ」一覧から登録を解除する。ピン止め解除と同様に確認ダイアログを挟み、
 * リポジトリ本体には影響しない旨を明記する。
 */
export async function unregisterRepository(path: string, label: string): Promise<void> {
  const ok = await confirmDialog(
    'リポジトリの登録解除',
    `「${label}」をリポジトリ一覧から外しますか?\n\n※ 一覧から外すだけで、リポジトリ本体は削除されません。`,
  );
  if (!ok) return;
  const { repositories, setRepositories } = useSettings.getState();
  setRepositories(repositories.filter((p) => p !== path));
  useToast.getState().show('success', 'リポジトリの登録を解除しました');
}
