import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { useGit } from '../../stores/git';
import { runGitCommands } from './GitCommandDialog';
import styles from './DiscardAllDialog.module.scss';
import { createCssModuleClassNames } from '../../lib/cssModule';

const cx = createCssModuleClassNames(styles);

interface DiscardAllStore {
  open: boolean;
  show: () => void;
  close: () => void;
}

const useDiscardAllDialog = create<DiscardAllStore>((set) => ({
  open: false,
  show: () => set({ open: true }),
  close: () => set({ open: false }),
}));

/** ヘッダの「ツール」メニューから呼ぶ: 作業ツリーの変更をすべて破棄する */
export function openDiscardAllDialog(): void {
  useDiscardAllDialog.getState().show();
}

export function DiscardAllDialog() {
  const { open, close } = useDiscardAllDialog();
  const repoRoot = useGit((s) => s.repoRoot);
  const [alsoUntracked, setAlsoUntracked] = useState(false);

  useEffect(() => {
    if (open) setAlsoUntracked(false);
  }, [open]);

  if (!open || !repoRoot) return null;

  const doDiscard = () => {
    close();
    // 追跡ファイルをステージ・作業ツリーとも HEAD へ戻す (git restore . のイメージ)。
    // 未追跡は任意で clean -fd (.gitignore 対象は残す)
    const commands: string[][] = [['restore', '--staged', '--worktree', '--', '.']];
    if (alsoUntracked) commands.push(['clean', '-fd']);
    void runGitCommands(repoRoot, commands, '変更をすべて破棄');
  };

  return (
    <div className={cx('dialog-backdrop')}>
      <div className={cx('dialog')}>
        <div className={cx('dialog-title')}>変更をすべて破棄</div>
        <div className={cx('discard-body')}>
          <p className={cx('discard-desc')}>
            作業ツリーとステージの変更をすべて破棄し、現在の HEAD の状態に戻します。この操作は元に戻せません。
          </p>
          <label className={cx('discard-check')}>
            <input
              type="checkbox"
              checked={alsoUntracked}
              onChange={(e) => setAlsoUntracked(e.target.checked)}
            />
            <span>未追跡のファイルも破棄する (git clean -fd)</span>
          </label>
          {alsoUntracked && (
            <p className={cx('discard-warn')}>
              追跡されていない新規ファイル・フォルダも削除されます (.gitignore の対象は残ります)。
            </p>
          )}
        </div>
        <div className={cx('dialog-buttons')}>
          <button className={cx('btn')} onClick={close}>
            キャンセル
          </button>
          <button className={cx('btn primary danger')} onClick={doDiscard}>
            すべて破棄
          </button>
        </div>
      </div>
    </div>
  );
}
