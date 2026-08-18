import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { api } from '../../api/client';
import { useGit } from '../../stores/git';
import { toastError } from '../../stores/toast';
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
  /** 作成時のベースブランチ (空なら現在の HEAD) */
  baseBranch: string;
  showCreate: (baseBranch?: string) => void;
  showRemoteCheckout: (remoteBranch: string) => void;
  showRename: (branchName: string) => void;
  close: () => void;
}

export const useBranchDialog = create<BranchDialogStore>((set) => ({
  open: false,
  mode: 'create',
  remoteBranch: '',
  branchName: '',
  baseBranch: '',
  showCreate: (baseBranch = '') => set({ open: true, mode: 'create', remoteBranch: '', branchName: '', baseBranch }),
  showRemoteCheckout: (remoteBranch) => set({ open: true, mode: 'remoteCheckout', remoteBranch, branchName: '', baseBranch: '' }),
  showRename: (branchName) => set({ open: true, mode: 'rename', remoteBranch: '', branchName, baseBranch: '' }),
  close: () => set({ open: false }),
}));

/** ベースブランチを渡すと、現在のブランチを切り替えずにそこから作成できる */
export function openCreateBranchDialog(baseBranch?: string): void {
  useBranchDialog.getState().showCreate(baseBranch);
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
  const { open, mode, remoteBranch, branchName, baseBranch, close } = useBranchDialog();
  const repoRoot = useGit((s) => s.repoRoot);
  const currentBranch = useGit((s) => s.status?.branch ?? null);
  const [name, setName] = useState('');
  const [branchNames, setBranchNames] = useState<string[]>([]);
  const [branchNamesLoaded, setBranchNamesLoaded] = useState(false);
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
      // 別ブランチを指定して開いたときは「切り替えずに作る」のが狙いなので既定を OFF にする
      setSwitchAfterCreate(!baseBranch);
    }
  }, [open, mode, remoteBranch, branchName, baseBranch]);

  useEffect(() => {
    if (!open || !repoRoot) return;
    setBranchNamesLoaded(false);
    setBranchNames([]);
    let cancelled = false;
    api
      .gitBranches(repoRoot)
      .then((r) => {
        if (cancelled) return;
        setBranchNames(r.branches.map((b) => b.name));
        setBranchNamesLoaded(true);
      })
      .catch((e) => {
        if (cancelled) return;
        setBranchNamesLoaded(true);
        toastError(e);
      });
    return () => {
      cancelled = true;
    };
  }, [open, repoRoot]);

  if (!open || !repoRoot) return null;

  const trimmedName = name.trim();
  const isCreate = mode === 'create';
  const isRename = mode === 'rename';
  const conflictingBranchName =
    isCreate || isRename
      ? branchNames.find((existingName) => existingName === trimmedName && (!isRename || existingName !== branchName))
      : undefined;
  const validationError = conflictingBranchName
    ? `ブランチ "${conflictingBranchName}" は既に存在します。別の名前を入力してください。`
    : '';
  const branchNamesReady = branchNamesLoaded || (!isCreate && !isRename);
  /** 作成の起点。ブランチ一覧から指定されていればそれ、無ければ現在の HEAD */
  const createBaseRef = baseBranch ? remoteRef(baseBranch) : '';
  const createBaseLabel = createBaseRef || currentBranch || 'HEAD';
  const canSubmit = branchNamesReady && !!trimmedName && !validationError && (!isRename || trimmedName !== branchName);

  const doCreate = () => {
    if (!canSubmit) return;
    close();
    const args = switchAfterCreate ? ['checkout', '-b', trimmedName] : ['branch', trimmedName];
    // ベースの指定があれば起点として渡す (無指定なら現在の HEAD から作られる)
    if (createBaseRef) args.push(createBaseRef);
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
    if (!canSubmit) return;
    close();
    void runGitCommands(repoRoot, [['branch', '-m', branchName, trimmedName]], 'ブランチ名変更');
  };

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
              <b className={cx("branch-value")} title={createBaseLabel}>
                {createBaseLabel}
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
                if (e.key === 'Enter' && canSubmit) submit();
                if (e.key === 'Escape') close();
              }}
            />
          </label>
          {validationError && (
            <div className={cx("branch-error")} role="alert">
              {validationError}
            </div>
          )}
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
          <button className={cx("btn primary")} disabled={!canSubmit} onClick={submit}>
            {isCreate ? '作成' : isRename ? '変更' : 'チェックアウト'}
          </button>
        </div>
      </div>
    </div>
  );
}
