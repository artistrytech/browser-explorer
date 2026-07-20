import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { useGit } from '../../stores/git';
import { runGitCommands } from './GitCommandDialog';
import styles from './BranchDialog.module.scss';
import { createCssModuleClassNames } from '../../lib/cssModule';

const cx = createCssModuleClassNames(styles);

type BranchDialogMode = 'create' | 'remoteCheckout' | 'rename';

interface BranchDialogStore {
  open: boolean;
  mode: BranchDialogMode;
  remoteBranch: string;
  branchName: string;
  showCreate: () => void;
  showRemoteCheckout: (remoteBranch: string) => void;
  showRename: (branchName: string) => void;
  close: () => void;
}

export const useBranchDialog = create<BranchDialogStore>((set) => ({
  open: false,
  mode: 'create',
  remoteBranch: '',
  branchName: '',
  showCreate: () => set({ open: true, mode: 'create', remoteBranch: '', branchName: '' }),
  showRemoteCheckout: (remoteBranch) => set({ open: true, mode: 'remoteCheckout', remoteBranch, branchName: '' }),
  showRename: (branchName) => set({ open: true, mode: 'rename', remoteBranch: '', branchName }),
  close: () => set({ open: false }),
}));

export function openCreateBranchDialog(): void {
  useBranchDialog.getState().showCreate();
}

export function openRemoteCheckoutDialog(remoteBranch: string): void {
  useBranchDialog.getState().showRemoteCheckout(remoteBranch);
}

export function openRenameBranchDialog(branchName: string): void {
  useBranchDialog.getState().showRename(branchName);
}

function remoteRef(name: string): string {
  return name.startsWith('remotes/') ? name.slice('remotes/'.length) : name;
}

function defaultLocalName(remoteBranch: string): string {
  const ref = remoteRef(remoteBranch);
  const slash = ref.indexOf('/');
  return slash >= 0 ? ref.slice(slash + 1) : ref;
}

export function BranchDialog() {
  const { open, mode, remoteBranch, branchName, close } = useBranchDialog();
  const repoRoot = useGit((s) => s.repoRoot);
  const baseBranch = useGit((s) => s.status?.branch ?? null);
  const [name, setName] = useState('');
  const [switchAfterCreate, setSwitchAfterCreate] = useState(true);
  const [trackRemote, setTrackRemote] = useState(true);

  useEffect(() => {
    if (!open) return;
    if (mode === 'remoteCheckout') {
      setName(defaultLocalName(remoteBranch));
      setTrackRemote(true);
    } else if (mode === 'rename') {
      setName(branchName);
    } else {
      setName('');
      setSwitchAfterCreate(true);
    }
  }, [open, mode, remoteBranch, branchName]);

  if (!open || !repoRoot) return null;

  const trimmedName = name.trim();
  const doCreate = () => {
    if (!trimmedName) return;
    close();
    const args = switchAfterCreate ? ['checkout', '-b', trimmedName] : ['branch', trimmedName];
    void runGitCommands(repoRoot, [args], 'ブランチ作成');
  };

  const doRemoteCheckout = () => {
    if (!trimmedName) return;
    close();
    const ref = remoteRef(remoteBranch);
    const args = trackRemote
      ? ['checkout', '--track', '-b', trimmedName, ref]
      : ['checkout', '--no-track', '-b', trimmedName, ref];
    void runGitCommands(repoRoot, [args], 'リモートブランチをチェックアウト');
  };

  const doRename = () => {
    if (!trimmedName || trimmedName === branchName) return;
    close();
    void runGitCommands(repoRoot, [['branch', '-m', branchName, trimmedName]], 'ブランチ名変更');
  };

  const isCreate = mode === 'create';
  const isRename = mode === 'rename';
  const submit = isCreate ? doCreate : isRename ? doRename : doRemoteCheckout;

  return (
    <div className={cx("dialog-backdrop")}>
      <div className={cx("dialog branch-dialog")}>
        <div className={cx("dialog-title")}>
          {isCreate ? '新しいブランチ' : isRename ? 'ブランチ名変更' : 'リモートブランチをチェックアウト'}
        </div>
        <div className={cx("branch-form")}>
          {isCreate ? (
            <div className={cx("branch-row")}>
              <span className={cx("branch-label")}>ベースブランチ:</span>
              <b className={cx("branch-value")} title={baseBranch ?? 'HEAD'}>
                {baseBranch ?? 'HEAD'}
              </b>
            </div>
          ) : isRename ? (
            <div className={cx("branch-row")}>
              <span className={cx("branch-label")}>現在のブランチ名:</span>
              <b className={cx("branch-value")} title={branchName}>
                {branchName}
              </b>
            </div>
          ) : (
            <div className={cx("branch-row")}>
              <span className={cx("branch-label")}>リモートブランチ:</span>
              <b className={cx("branch-value")} title={remoteRef(remoteBranch)}>
                {remoteRef(remoteBranch)}
              </b>
            </div>
          )}
          <label className={cx("branch-row")}>
            <span className={cx("branch-label")}>{isRename ? '新しいブランチ名:' : 'ローカルブランチ名:'}</span>
            <input
              className={cx("branch-input")}
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
                if (e.key === 'Escape') close();
              }}
            />
          </label>
          {isRename ? null : isCreate ? (
            <label className={cx("branch-row")}>
              <span className={cx("branch-label")} />
              <input
                type="checkbox"
                checked={switchAfterCreate}
                onChange={(e) => setSwitchAfterCreate(e.target.checked)}
              />
              <span>切替</span>
            </label>
          ) : (
            <label className={cx("branch-row")}>
              <span className={cx("branch-label")} />
              <input
                type="checkbox"
                checked={trackRemote}
                onChange={(e) => setTrackRemote(e.target.checked)}
              />
              <span>リモートブランチを追跡</span>
            </label>
          )}
        </div>
        <div className={cx("dialog-buttons")}>
          <button className={cx("btn")} onClick={close}>
            キャンセル
          </button>
          <button className={cx("btn primary")} disabled={!trimmedName || (isRename && trimmedName === branchName)} onClick={submit}>
            {isCreate ? '作成' : isRename ? '変更' : 'チェックアウト'}
          </button>
        </div>
      </div>
    </div>
  );
}
