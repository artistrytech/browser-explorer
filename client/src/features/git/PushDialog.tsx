import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { useGit } from '../../stores/git';
import { runGitCommands } from './GitCommandDialog';
import styles from './PushDialog.module.scss';
import { createCssModuleClassNames } from '../../lib/cssModule';

const cx = createCssModuleClassNames(styles);

/**
 * Push オプションダイアログ:
 * - リモートブランチの指定 (トラッキング済みならそれを初期表示。
 *   空欄の場合はローカルと同じブランチ名で push)
 * - force with lease オプション
 */

interface PushDialogStore {
  open: boolean;
  show: () => void;
  close: () => void;
}

export const usePushDialog = create<PushDialogStore>((set) => ({
  open: false,
  show: () => set({ open: true }),
  close: () => set({ open: false }),
}));

export function openPushDialog(): void {
  usePushDialog.getState().show();
}

/** upstream 未設定時の既定 push 引数 (Commit & Push 等の簡易 push 用) */
export function defaultPushArgs(status: { branch: string | null; tracking: string | null }): string[] {
  if (status.tracking) return ['push'];
  return ['push', '-u', 'origin', status.branch ?? 'HEAD'];
}

export function PushDialog() {
  const { open, close } = usePushDialog();
  const repoRoot = useGit((s) => s.repoRoot);
  const status = useGit((s) => s.status);
  const [remote, setRemote] = useState('origin');
  const [remoteBranch, setRemoteBranch] = useState('');
  const [forceWithLease, setForceWithLease] = useState(false);

  const branch = status?.branch ?? '';
  const tracking = status?.tracking ?? null;

  // 開くたびに既存のトラッキング先を初期値として反映
  useEffect(() => {
    if (!open) return;
    if (tracking && tracking.includes('/')) {
      const slash = tracking.indexOf('/');
      setRemote(tracking.slice(0, slash));
      setRemoteBranch(tracking.slice(slash + 1));
    } else {
      setRemote('origin');
      setRemoteBranch('');
    }
    setForceWithLease(false);
  }, [open, tracking]);

  if (!open || !repoRoot) return null;

  const doPush = () => {
    const args = ['push'];
    if (forceWithLease) args.push('--force-with-lease');
    if (!tracking) args.push('-u'); // 初回 push はトラッキングを設定
    args.push(remote.trim() || 'origin');
    const target = remoteBranch.trim();
    // 空欄ならローカルと同じブランチ名で push
    args.push(target && target !== branch ? `${branch}:${target}` : branch);
    close();
    void runGitCommands(repoRoot, [args], 'Push');
  };

  return (
    <div className={cx("dialog-backdrop")}>
      <div className={cx("dialog push-dialog")}>
        <div className={cx("dialog-title")}>Push</div>
        <div className={cx("clone-form")}>
          <div className={cx("clone-row")}>
            <span className={cx("clone-label wide")}>ローカル:</span>
            <b>{branch || '(不明)'}</b>
          </div>
          <label className={cx("clone-row")}>
            <span className={cx("clone-label wide")}>リモート:</span>
            <input
              className={cx("clone-input small")}
              value={remote}
              onChange={(e) => setRemote(e.target.value)}
            />
          </label>
          <label className={cx("clone-row")}>
            <span className={cx("clone-label wide")}>リモートブランチ:</span>
            <input
              className={cx("clone-input")}
              value={remoteBranch}
              placeholder={branch ? `(空欄で ${branch} と同名)` : ''}
              onChange={(e) => setRemoteBranch(e.target.value)}
            />
          </label>
          {tracking && (
            <div className={cx("clone-row push-tracking-note")}>現在のトラッキング先: {tracking}</div>
          )}
          <label className={cx("clone-row")}>
            <input
              type="checkbox"
              checked={forceWithLease}
              onChange={(e) => setForceWithLease(e.target.checked)}
            />
            <span>force with lease (--force-with-lease)</span>
          </label>
        </div>
        <div className={cx("dialog-buttons")}>
          <button className={cx("btn")} onClick={close}>
            キャンセル
          </button>
          <button className={cx("btn primary")} disabled={!branch} onClick={doPush}>
            Push
          </button>
        </div>
      </div>
    </div>
  );
}
