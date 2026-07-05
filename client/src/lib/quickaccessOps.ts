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
