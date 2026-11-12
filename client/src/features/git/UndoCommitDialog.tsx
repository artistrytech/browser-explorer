import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { api } from '../../api/client';
import { useGit } from '../../stores/git';
import { setCommitDraft } from '../../stores/commitDraft';
import { toastError, useToast } from '../../stores/toast';
import { runGitCommands } from './GitCommandDialog';
import styles from './UndoCommitDialog.module.scss';
import { createCssModuleClassNames } from '../../lib/cssModule';
import { useDialogKeys } from '../../lib/dialogKeys';

const cx = createCssModuleClassNames(styles);

type Mode = 'soft' | 'mixed' | 'hard';
type Info = Awaited<ReturnType<typeof api.gitUndoCommitInfo>>;

interface UndoCommitStore {
  open: boolean;
  show: () => void;
  close: () => void;
}

const useUndoCommitDialog = create<UndoCommitStore>((set) => ({
  open: false,
  show: () => set({ open: true }),
  close: () => set({ open: false }),
}));

/** ヘッダの「ツール」メニュー / コマンドパレットから呼ぶ: 現在のブランチを 1 コミット前へ戻す */
export function openUndoCommitDialog(): void {
  useUndoCommitDialog.getState().show();
}

const MODES: { mode: Mode; label: string; desc: string }[] = [
  {
    mode: 'soft',
    label: '変更をステージに残す (--soft)',
    desc: 'コミットだけを取り消し、その変更はステージ済みのまま残します',
  },
  {
    mode: 'mixed',
    label: '変更を作業ツリーに残す (--mixed)',
    desc: 'コミットとステージを取り消し、変更は未ステージとして残します',
  },
  {
    mode: 'hard',
    label: '変更も破棄する (--hard)',
    desc: 'コミットの変更と、今ある未コミットの変更をすべて破棄します',
  },
];

/**
 * 直前のコミットを取り消す (git reset HEAD~1 相当)。
 * 戻り先は開いた時点の HEAD の第 1 親。実行直前に HEAD が変わっていないか確かめる
 */
export function UndoCommitDialog() {
  const { open, close } = useUndoCommitDialog();
  const repoRoot = useGit((s) => s.repoRoot);
  const dirtyCount = useGit((s) => s.status?.files.length ?? 0);
  const inProgress = useGit((s) => s.mergeState.inProgress);
  const show = useToast((s) => s.show);
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('soft');
  const [restoreMessage, setRestoreMessage] = useState(true);

  useEffect(() => {
    if (!open || !repoRoot) return;
    setInfo(null);
    setError(null);
    setMode('soft');
    setRestoreMessage(true);
    let alive = true;
    api
      .gitUndoCommitInfo(repoRoot)
      .then((r) => alive && setInfo(r))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [open, repoRoot]);

  /** 実行できない理由 (あればボタンを止める) */
  const blocked = !info
    ? null
    : inProgress
      ? 'マージ / リベース / cherry-pick の途中なので実行できません'
      : !info.branch
        ? 'ブランチをチェックアウトしていません (detached HEAD)'
        : !info.head
          ? 'このブランチにはまだコミットがありません'
          : !info.parent
            ? '最初のコミットなので、これより前には戻せません'
            : null;
  const canRun = !!info && !blocked;

  const doUndo = () => {
    if (!repoRoot || !info?.head || !info.parent || blocked) return;
    const { head, parent } = info;
    close();
    void (async () => {
      // ダイアログを開いている間に HEAD が動いていたら、表示と違うコミットを戻さないよう中止する
      const now = await api.gitUndoCommitInfo(repoRoot).catch(() => null);
      if (!now?.head || now.head.hash !== head.hash) {
        show('error', 'HEAD が変わったため中止しました。もう一度やり直してください');
        return;
      }
      const ok = await runGitCommands(repoRoot, [['reset', `--${mode}`, parent.hash]], '直前のコミットを取り消す');
      // 変更を残した場合は、取り消したコミットのメッセージを入力欄へ戻して再コミットしやすくする
      if (ok && mode !== 'hard' && restoreMessage && head.message) setCommitDraft(head.message);
    })().catch(toastError);
  };

  const dialogRef = useDialogKeys({ enabled: open, onEnter: () => canRun && doUndo(), onEscape: close });

  if (!open || !repoRoot) return null;

  const pushed = info?.remotes ?? [];

  return (
    <div ref={dialogRef} className={cx('dialog-backdrop')}>
      <div className={cx('dialog')}>
        <div className={cx('dialog-title')}>直前のコミットを取り消す</div>
        <div className={cx('undo-body')}>
          {error && <p className={cx('undo-warn')}>{error}</p>}
          {!info && !error && <p className={cx('undo-desc')}>読み込み中…</p>}
          {info && (
            <>
              <p className={cx('undo-desc')}>
                現在のブランチ <b>{info.branch ?? '(detached HEAD)'}</b> を 1 コミット前へ戻します。
              </p>
              {info.head && (
                <div className={cx('undo-commit')}>
                  <div className={cx('undo-commit-label')}>取り消すコミット</div>
                  <div>
                    <code>{info.head.shortHash}</code> {info.head.subject}
                  </div>
                  <div className={cx('undo-meta')}>
                    {info.head.author} · {info.head.date}
                  </div>
                </div>
              )}
              {info.parent && (
                <div className={cx('undo-commit')}>
                  <div className={cx('undo-commit-label')}>戻り先</div>
                  <div>
                    <code>{info.parent.shortHash}</code> {info.parent.subject}
                  </div>
                </div>
              )}
              {blocked ? (
                <p className={cx('undo-warn')}>{blocked}</p>
              ) : (
                <>
                  <div className={cx('undo-modes')}>
                    {MODES.map((m) => (
                      <label key={m.mode} className={cx('undo-mode')}>
                        <input
                          type="radio"
                          name="undo-mode"
                          checked={mode === m.mode}
                          onChange={() => setMode(m.mode)}
                        />
                        <span>
                          {m.label}
                          <span className={cx('undo-mode-desc')}>{m.desc}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                  {mode !== 'hard' && (
                    <label className={cx('undo-check')}>
                      <input
                        type="checkbox"
                        checked={restoreMessage}
                        onChange={(e) => setRestoreMessage(e.target.checked)}
                      />
                      <span>コミットメッセージを入力欄に戻す</span>
                    </label>
                  )}
                  {mode === 'hard' && (
                    <p className={cx('undo-warn')}>
                      コミットの変更は作業ツリーからも消えます。
                      {dirtyCount > 0 && `未コミットの変更 (${dirtyCount} 件) も失われます。`}
                      この操作は元に戻せません。
                    </p>
                  )}
                  {info.head && info.head.parentCount > 1 && (
                    <p className={cx('undo-note')}>
                      マージコミットです。第 1 親 (マージ前のこのブランチ側) へ戻ります。
                    </p>
                  )}
                  {pushed.length > 0 && (
                    <p className={cx('undo-warn')}>
                      このコミットは push 済みです ({pushed.join(', ')})。
                      取り消した後に push するには強制 push が必要になり、共有している人の履歴と食い違います。
                    </p>
                  )}
                </>
              )}
            </>
          )}
        </div>
        <div className={cx('dialog-buttons')}>
          <button className={cx('btn')} onClick={close}>
            キャンセル
          </button>
          <button
            className={cx(mode === 'hard' ? 'btn primary danger' : 'btn primary')}
            disabled={!canRun}
            onClick={doUndo}
          >
            取り消す
          </button>
        </div>
      </div>
    </div>
  );
}
