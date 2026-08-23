import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { api } from '../../api/client';
import { setCommitDraft } from '../../stores/commitDraft';
import { runGitCommands } from './GitCommandDialog';
import styles from './RevertDialog.module.scss';
import { createCssModuleClassNames } from '../../lib/cssModule';
import { useDialogKeys } from '../../lib/dialogKeys';

const cx = createCssModuleClassNames(styles);

/**
 * コミットの打ち消し確認ダイアログ (SourceTree の「コミットを打ち消し」= git revert):
 * 対象コミットの変更を反転した内容を現在のブランチへ適用する。履歴は書き換えず、
 * 打ち消しのコミットを新たに積む。
 * - 即コミットするか (OFF なら --no-commit でインデックス/作業ツリーに留める)
 * - マージコミットは反転の基準となる親 (-m) を選ぶ (指定しないと git が失敗する)
 */

interface RevertDialogStore {
  open: boolean;
  repo: string;
  hash: string;
  subject: string;
  /** 対象コミットの親 (2 つ以上ならマージコミット) */
  parents: string[];
  show: (repo: string, hash: string, subject: string, parents: string[]) => void;
  close: () => void;
}

export const useRevertDialog = create<RevertDialogStore>((set) => ({
  open: false,
  repo: '',
  hash: '',
  subject: '',
  parents: [],
  show: (repo, hash, subject, parents) => set({ open: true, repo, hash, subject, parents }),
  close: () => set({ open: false }),
}));

export function openRevertDialog(repo: string, hash: string, subject = '', parents: string[] = []): void {
  useRevertDialog.getState().show(repo, hash, subject, parents);
}

/**
 * git のコメント行 (# 始まり) を落とす。
 * --no-commit や競合で中断した場合の MERGE_MSG には "# Conflicts:" の一覧が付くが、
 * アプリのコミットは git commit -m (コメントを除去しない) なのでここで落としておく。
 */
function stripComments(message: string): string {
  return message
    .split('\n')
    .filter((line) => !line.startsWith('#'))
    .join('\n')
    .replace(/\s+$/, '');
}

export function RevertDialog() {
  const { open, repo, hash, subject, parents, close } = useRevertDialog();
  // 既定は SourceTree と同じく「即コミットする」
  const [commit, setCommit] = useState(true);
  // マージコミットの -m (1 始まり)。既定は第 1 親 (取り込み先ブランチ側)
  const [mainline, setMainline] = useState(1);

  useEffect(() => {
    if (open) {
      setCommit(true);
      setMainline(1);
    }
  }, [open]);

  const isMerge = parents.length > 1;
  const args = [
    'revert',
    ...(isMerge ? ['-m', String(mainline)] : []),
    ...(commit ? ['--no-edit'] : ['--no-commit']),
    hash,
  ];

  const doRevert = () => {
    close();
    void runGitCommands(repo, [args], '打ち消し (revert)').then(() => {
      // --no-commit の場合、git が用意した打ち消しのメッセージ (MERGE_MSG) は
      // アプリのコミット入力欄には載らないので、下書きとして流し込む。
      // 競合で失敗したときも MERGE_MSG は用意されるため、成否では分岐しない
      // (競合を解消したあと、そのままコミットできる)
      if (!commit) {
        void api
          .gitMergeMsg(repo)
          .then((r) => {
            const message = stripComments(r.message);
            if (message) setCommitDraft(message);
          })
          .catch(() => undefined);
      }
    });
  };

  const dialogRef = useDialogKeys({ enabled: open, onEnter: doRevert, onEscape: close });

  if (!open) return null;

  return (
    <div ref={dialogRef} className={cx('dialog-backdrop')}>
      <div className={cx('dialog push-dialog')}>
        <div className={cx('dialog-title')}>コミットを打ち消し</div>
        <div className={cx('clone-form')}>
          <div className={cx('clone-row')}>
            このコミットの変更を反転して現在のブランチに適用します (履歴は書き換えません)。
          </div>
          <div className={cx('target')}>
            <span className={cx('target-hash')}>{hash.slice(0, 7)}</span>
            <span className={cx('target-subject')} title={subject}>
              {subject}
            </span>
          </div>
          <label className={cx('clone-row')}>
            <input type="checkbox" checked={commit} onChange={(e) => setCommit(e.target.checked)} />
            <span>即座にコミットする (OFF: --no-commit で変更を未コミットのまま残す)</span>
          </label>
          {isMerge && (
            <>
              <label className={cx('clone-row mainline')}>
                <span>マージコミットのため、残す側の親を選びます (-m)</span>
                <select value={mainline} onChange={(e) => setMainline(Number(e.target.value))}>
                  {parents.map((p, i) => (
                    <option key={p} value={i + 1}>
                      {i + 1}: {p.slice(0, 7)}
                    </option>
                  ))}
                </select>
              </label>
              <div className={cx('hint')}>
                選んだ親の側の履歴を残し、それ以外の親から取り込まれた変更を打ち消します
                (通常は 1 = マージ先のブランチ)。
              </div>
            </>
          )}
          <div className={cx('preview')}>
            git {args.slice(0, -1).join(' ')} {hash.slice(0, 7)}
          </div>
        </div>
        <div className={cx('dialog-buttons')}>
          <button className={cx('btn')} onClick={close}>
            キャンセル
          </button>
          <button className={cx('btn primary')} onClick={doRevert}>
            打ち消し
          </button>
        </div>
      </div>
    </div>
  );
}
