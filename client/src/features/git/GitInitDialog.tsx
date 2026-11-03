import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { api } from '../../api/client';
import { useExplorer } from '../../stores/explorer';
import { useGit } from '../../stores/git';
import { useSettings } from '../../stores/settings';
import { useToast, toastError } from '../../stores/toast';
import { baseName } from '../../lib/paths';
import { useDialogKeys } from '../../lib/dialogKeys';
import cloneStyles from './CloneDialog.module.scss';
import styles from './GitInitDialog.module.scss';
import { createCssModuleClassNames } from '../../lib/cssModule';

const cx = createCssModuleClassNames(styles, cloneStyles);

/**
 * git init ダイアログ。「コミット」タブ等の「git init」ボタンと、ファイルタブの右クリック「Git init…」から開く。
 * 最初のブランチ名と、このリポジトリだけのユーザ名 / メールアドレス (親の設定の上書き) を指定できる。
 * 上書きするときは、登録済みの他のリポジトリで使っているユーザ名 / メールアドレスを候補に出す。
 */

interface GitInitDialogStore {
  open: boolean;
  path: string;
  show: (path: string) => void;
  close: () => void;
}

export const useGitInitDialog = create<GitInitDialogStore>((set) => ({
  open: false,
  path: '',
  show: (path) => set({ open: true, path }),
  close: () => set({ open: false }),
}));

/** path で git init するダイアログを開く */
export function openGitInitDialog(path: string): void {
  useGitInitDialog.getState().show(path);
}

/** 親の設定に init.defaultBranch が無いときの既定のブランチ名 */
const FALLBACK_BRANCH = 'main';

interface Identity {
  name: string;
  email: string;
  repo: string;
}

function formatIdentity(name: string, email: string): string {
  if (name && email) return `${name} <${email}>`;
  return name || (email ? `<${email}>` : '');
}

export function GitInitDialog() {
  const { open, path, close } = useGitInitDialog();
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [parent, setParent] = useState({ name: '', email: '', defaultBranch: '' });
  const [candidates, setCandidates] = useState<Identity[]>([]);
  const [override, setOverride] = useState(false);
  const [userName, setUserName] = useState('');
  const [userEmail, setUserEmail] = useState('');
  const [branch, setBranch] = useState(FALLBACK_BRANCH);

  // ダイアログを開くたびに初期化し、親の設定と候補を読み込む
  useEffect(() => {
    if (!open) return;
    setOverride(false);
    setUserName('');
    setUserEmail('');
    setBranch(FALLBACK_BRANCH);
    setParent({ name: '', email: '', defaultBranch: '' });
    setCandidates([]);
    setBusy(false);
    setLoading(true);
    let cancelled = false;
    const repos = useSettings.getState().repositories;
    api
      .gitInitOptions(path, repos)
      .then((r) => {
        if (cancelled) return;
        setParent(r.parent);
        setCandidates(r.candidates);
        setBranch(r.parent.defaultBranch || FALLBACK_BRANCH);
        setUserName(r.parent.name);
        setUserEmail(r.parent.email);
      })
      .catch((e) => {
        if (!cancelled) toastError(e);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, path]);

  const canInit =
    !busy && !loading && branch.trim().length > 0 && (!override || userName.trim() !== '' || userEmail.trim() !== '');

  const doInit = async () => {
    if (!canInit) return;
    setBusy(true);
    try {
      await api.gitInit(path, {
        defaultBranch: branch.trim(),
        ...(override ? { userName: userName.trim(), userEmail: userEmail.trim() } : {}),
      });
      useToast.getState().show('success', 'リポジトリを作成しました');
      close();
      // 表示中のフォルダ (またはその配下) で作ったなら Git の表示も切り替わる
      const explorerPath = useExplorer.getState().path;
      void useGit.getState().checkRepo(explorerPath);
      void useExplorer.getState().refresh();
    } catch (e) {
      toastError(e);
      setBusy(false);
    }
  };

  const dialogRef = useDialogKeys({
    enabled: open,
    onEnter: canInit ? () => void doInit() : null,
    onEscape: busy ? null : close,
  });

  if (!open) return null;

  const parentIdentity = formatIdentity(parent.name, parent.email);
  const selectedCandidate = candidates.findIndex((c) => c.name === userName.trim() && c.email === userEmail.trim());

  return (
    <div ref={dialogRef} className={cx('dialog-backdrop')}>
      <div className={cx('dialog init-dialog')}>
        <div className={cx('dialog-title')}>Git リポジトリを作成 (git init)</div>
        <div className={cx('init-path')} title={path}>
          {path}
        </div>
        <div className={cx('clone-form')}>
          <label className={cx('clone-row')}>
            <span className={cx('init-label')}>ブランチ名:</span>
            <input
              className={cx('clone-input small')}
              value={branch}
              disabled={busy}
              autoFocus
              onChange={(e) => setBranch(e.target.value)}
            />
            <span className={cx('init-note')}>
              {parent.defaultBranch ? `親の設定: ${parent.defaultBranch}` : '最初のブランチの名前'}
            </span>
          </label>

          <div className={cx('clone-options-title')}>ユーザ名 / メールアドレス</div>
          <div className={cx('init-note')}>
            親の設定: {loading ? '読み込み中…' : parentIdentity || '(未設定)'}
          </div>
          <label className={cx('clone-row')}>
            <input
              type="checkbox"
              checked={override}
              disabled={busy}
              onChange={(e) => setOverride(e.target.checked)}
            />
            <span>このリポジトリだけ別のユーザ名 / メールアドレスを使う (親の設定を上書き)</span>
          </label>
          {override && (
            <>
              {candidates.length > 0 && (
                <label className={cx('clone-row')}>
                  <span className={cx('init-label')}>候補:</span>
                  <select
                    className={cx('clone-input')}
                    value={selectedCandidate}
                    disabled={busy}
                    onChange={(e) => {
                      const c = candidates[Number(e.target.value)];
                      if (!c) return;
                      setUserName(c.name);
                      setUserEmail(c.email);
                    }}
                  >
                    <option value={-1}>登録済みのリポジトリから選ぶ…</option>
                    {candidates.map((c, i) => (
                      <option key={i} value={i} title={c.repo}>
                        {formatIdentity(c.name, c.email)} ({baseName(c.repo)})
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className={cx('clone-row')}>
                <span className={cx('init-label')}>ユーザ名:</span>
                <input
                  className={cx('clone-input')}
                  value={userName}
                  disabled={busy}
                  placeholder={parent.name}
                  onChange={(e) => setUserName(e.target.value)}
                />
              </label>
              <label className={cx('clone-row')}>
                <span className={cx('init-label')}>メール:</span>
                <input
                  className={cx('clone-input')}
                  type="email"
                  value={userEmail}
                  disabled={busy}
                  placeholder={parent.email}
                  onChange={(e) => setUserEmail(e.target.value)}
                />
              </label>
            </>
          )}
        </div>

        <div className={cx('dialog-buttons')}>
          <button className={cx('btn')} disabled={busy} onClick={close}>
            キャンセル
          </button>
          <button className={cx('btn primary')} disabled={!canInit} onClick={() => void doInit()}>
            {busy ? '作成中…' : '作成'}
          </button>
        </div>
      </div>
    </div>
  );
}
