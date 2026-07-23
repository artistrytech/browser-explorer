import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { useGit } from '../../stores/git';
import { useRebase } from '../../stores/rebase';
import { confirmDialog } from '../../stores/dialog';
import { openConflictResolver } from './ConflictResolver';
import styles from './Rebase.module.scss';
import { createCssModuleClassNames } from '../../lib/cssModule';

const cx = createCssModuleClassNames(styles);

/* ---------- 開始ダイアログ (オプション選択) ---------- */

interface RebaseDialogStore {
  open: boolean;
  /** リベース先 (この上に現在のブランチを移動する) */
  onto: string;
  /** 書き換えられる側 (開始時の現在ブランチ) */
  baseBranch: string;
  show: (onto: string, baseBranch: string) => void;
  close: () => void;
}

const useRebaseDialog = create<RebaseDialogStore>((set) => ({
  open: false,
  onto: '',
  baseBranch: '',
  show: (onto, baseBranch) => set({ open: true, onto, baseBranch }),
  close: () => set({ open: false }),
}));

/** ブランチ一覧のコンテキストメニューから呼ぶ: 現在のブランチを onto の上にリベース */
export function openRebaseDialog(onto: string, baseBranch: string): void {
  useRebaseDialog.getState().show(onto, baseBranch);
}

export function RebaseDialog() {
  const { open, onto, baseBranch, close } = useRebaseDialog();
  const repoRoot = useGit((s) => s.repoRoot);
  const start = useRebase((s) => s.start);
  const busy = useRebase((s) => s.busy);
  const [deleteBackup, setDeleteBackup] = useState(false);

  useEffect(() => {
    if (open) setDeleteBackup(false);
  }, [open]);

  if (!open || !repoRoot) return null;

  const doStart = () => {
    close();
    void start(repoRoot, onto, deleteBackup);
  };

  return (
    <div className={cx('dialog-backdrop')}>
      <div className={cx('dialog rebase-dialog')}>
        <div className={cx('dialog-title')}>リベース</div>
        <div className={cx('rebase-body')}>
          <p className={cx('rebase-desc')}>
            現在のブランチ <b>{baseBranch}</b> を <b>{onto}</b> の上に移動します。
          </p>
          <p className={cx('rebase-note')}>
            実行前に現在のブランチのバックアップ (<code>backup/rebase/…</code>) を作成します。
            競合が発生した場合は解消後に続行してください。リベース中は他の操作がブロックされます。
          </p>
          <label className={cx('rebase-check')}>
            <input
              type="checkbox"
              checked={deleteBackup}
              onChange={(e) => setDeleteBackup(e.target.checked)}
            />
            <span>リベース成功後にバックアップブランチを削除する</span>
          </label>
        </div>
        <div className={cx('dialog-buttons')}>
          <button className={cx('btn')} onClick={close} disabled={busy}>
            キャンセル
          </button>
          <button className={cx('btn primary')} onClick={doStart} disabled={busy}>
            リベース実行
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- 全画面ブロックモーダル (リベース中ロック) ---------- */

export function RebaseOverlay() {
  const repoRoot = useGit((s) => s.repoRoot);
  const session = useRebase((s) => s.session);
  const busy = useRebase((s) => s.busy);
  const lastOutput = useRebase((s) => s.lastOutput);
  const mergeState = useGit((s) => s.mergeState);

  if (!repoRoot || !session || session.repo !== repoRoot) return null;

  const inRebase = mergeState.inProgress === 'rebase';
  const conflicts = mergeState.conflicted.length;

  const doContinue = () => void useRebase.getState().continueRebase(repoRoot);
  const doAbort = () =>
    void confirmDialog(
      'リベースを中止',
      '進行中のリベースを中止します。途中経過は新しいバックアップブランチに退避し、開始前のバックアップから復元します。よろしいですか?',
      true,
    ).then((ok) => {
      if (ok) void useRebase.getState().abort(repoRoot);
    });
  const doClearSession = () =>
    void confirmDialog(
      'リベースセッションを終了',
      'git 側ではリベースが進行していません。セッションを終了してロックを解除します (バックアップは残ります)。よろしいですか?',
    ).then((ok) => {
      if (ok) void useRebase.getState().clearSession(repoRoot);
    });

  return (
    <div className={cx('rebase-overlay')}>
      <div className={cx('rebase-window')}>
        <div className={cx('rebase-window-head')}>
          <span className={cx('rebase-badge')}>⟳ リベース中</span>
          <span className={cx('rebase-route')}>
            {session.baseBranch} → {session.onto}
          </span>
        </div>
        <div className={cx('rebase-window-body')}>
          {!inRebase ? (
            <>
              <p className={cx('rebase-state warn')}>
                git 側ではリベースが進行していません。アプリ外で完了または中止された可能性があります。
              </p>
              <p className={cx('rebase-hint')}>
                セッションを終了してロックを解除してください。
              </p>
            </>
          ) : conflicts > 0 ? (
            <>
              <p className={cx('rebase-state warn')}>競合が {conflicts} 件発生しています。</p>
              <p className={cx('rebase-hint')}>
                競合を解消してから「続行」してください。中止すると開始前の状態に戻ります。
              </p>
            </>
          ) : (
            <>
              <p className={cx('rebase-state ok')}>競合はありません。</p>
              <p className={cx('rebase-hint')}>「続行」でリベースを進めます。</p>
            </>
          )}

          <div className={cx('rebase-meta')}>
            バックアップ: <code>{session.backupBranch}</code>
            {session.deleteBackupOnSuccess ? ' (成功後に削除)' : ''}
          </div>

          {lastOutput && <pre className={cx('rebase-output')}>{lastOutput}</pre>}
        </div>

        <div className={cx('rebase-actions')}>
          {!inRebase ? (
            <button className={cx('btn primary')} disabled={busy} onClick={doClearSession}>
              セッションを終了 (ロック解除)
            </button>
          ) : (
            <>
              {conflicts > 0 ? (
                <button className={cx('btn primary')} disabled={busy} onClick={() => openConflictResolver('')}>
                  競合を解消…
                </button>
              ) : (
                <button className={cx('btn primary')} disabled={busy} onClick={doContinue}>
                  続行
                </button>
              )}
              <span className={cx('rebase-spacer')} />
              <button className={cx('btn danger')} disabled={busy} onClick={doAbort}>
                リベースを中止
              </button>
            </>
          )}
        </div>
        {busy && (
          <div className={cx('rebase-busy')}>
            <span className={cx('spinner-ring')} /> 実行中…
          </div>
        )}
      </div>
    </div>
  );
}
