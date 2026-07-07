import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { useGit } from '../../stores/git';
import { runGitCommands } from './GitCommandDialog';

/** Fetch 確認ダイアログ: Prune オプションを選んで実行する (Push と同様のフロー) */

interface FetchDialogStore {
  open: boolean;
  show: () => void;
  close: () => void;
}

export const useFetchDialog = create<FetchDialogStore>((set) => ({
  open: false,
  show: () => set({ open: true }),
  close: () => set({ open: false }),
}));

export function openFetchDialog(): void {
  useFetchDialog.getState().show();
}

export function FetchDialog() {
  const { open, close } = useFetchDialog();
  const repoRoot = useGit((s) => s.repoRoot);
  const [prune, setPrune] = useState(false);

  useEffect(() => {
    if (open) setPrune(false);
  }, [open]);

  if (!open || !repoRoot) return null;

  const doFetch = () => {
    close();
    void runGitCommands(repoRoot, [['fetch', ...(prune ? ['--prune'] : [])]], 'Fetch');
  };

  return (
    <div className="dialog-backdrop">
      <div className="dialog push-dialog">
        <div className="dialog-title">Fetch</div>
        <div className="clone-form">
          <div className="clone-row">リモートの最新状態を取得します (git fetch)。</div>
          <label className="clone-row">
            <input type="checkbox" checked={prune} onChange={(e) => setPrune(e.target.checked)} />
            <span>Prune: リモートで削除されたブランチの追跡情報も削除 (--prune)</span>
          </label>
        </div>
        <div className="dialog-buttons">
          <button className="btn" onClick={close}>
            キャンセル
          </button>
          <button className="btn primary" onClick={doFetch}>
            Fetch
          </button>
        </div>
      </div>
    </div>
  );
}
