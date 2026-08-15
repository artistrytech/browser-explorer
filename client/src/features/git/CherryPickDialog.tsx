import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { api } from '../../api/client';
import { setCommitDraft } from '../../stores/commitDraft';
import { runGitCommands } from './GitCommandDialog';
import styles from './CherryPickDialog.module.scss';
import { createCssModuleClassNames } from '../../lib/cssModule';

const cx = createCssModuleClassNames(styles);

/**
 * cherry-pick 確認ダイアログ (SourceTree と同様のオプション):
 * - 即コミットするか (OFF なら --no-commit で作業ツリー/インデックスに留める)
 * - 元のコミット ID をメッセージに含めるか (-x)
 */

interface CherryPickDialogStore {
  open: boolean;
  repo: string;
  hash: string;
  subject: string;
  show: (repo: string, hash: string, subject: string) => void;
  close: () => void;
}

export const useCherryPickDialog = create<CherryPickDialogStore>((set) => ({
  open: false,
  repo: '',
  hash: '',
  subject: '',
  show: (repo, hash, subject) => set({ open: true, repo, hash, subject }),
  close: () => set({ open: false }),
}));

export function openCherryPickDialog(repo: string, hash: string, subject = ''): void {
  useCherryPickDialog.getState().show(repo, hash, subject);
}

export function CherryPickDialog() {
  const { open, repo, hash, subject, close } = useCherryPickDialog();
  // 既定は SourceTree と同じく「即コミットする / コミット ID は含めない」
  const [commit, setCommit] = useState(true);
  const [recordOrigin, setRecordOrigin] = useState(false);

  useEffect(() => {
    if (open) {
      setCommit(true);
      setRecordOrigin(false);
    }
  }, [open]);

  if (!open) return null;

  // -x はコミットメッセージへの追記なので、即コミットしない場合は指定できない
  const canRecordOrigin = commit;
  const args = [
    'cherry-pick',
    ...(canRecordOrigin && recordOrigin ? ['-x'] : []),
    ...(commit ? [] : ['--no-commit']),
    hash,
  ];

  const doCherryPick = () => {
    close();
    void runGitCommands(repo, [args], 'Cherry-pick').then((ok) => {
      // --no-commit の場合、git が用意した元コミットのメッセージ (MERGE_MSG) は
      // アプリのコミット入力欄には載らないので、下書きとして流し込む
      if (ok && !commit) {
        void api
          .gitMergeMsg(repo)
          .then((r) => {
            if (r.message) setCommitDraft(r.message);
          })
          .catch(() => undefined);
      }
    });
  };

  return (
    <div className={cx('dialog-backdrop')}>
      <div className={cx('dialog push-dialog')}>
        <div className={cx('dialog-title')}>Cherry-pick</div>
        <div className={cx('clone-form')}>
          <div className={cx('clone-row')}>このコミットを現在のブランチに取り込みます。</div>
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
          <label className={cx(`clone-row${canRecordOrigin ? '' : ' disabled'}`)}>
            <input
              type="checkbox"
              checked={canRecordOrigin && recordOrigin}
              disabled={!canRecordOrigin}
              onChange={(e) => setRecordOrigin(e.target.checked)}
            />
            <span>元のコミット ID をコミットメッセージに含める (-x)</span>
          </label>
          <div className={cx('preview')}>git {args.slice(0, -1).join(' ')} {hash.slice(0, 7)}</div>
        </div>
        <div className={cx('dialog-buttons')}>
          <button className={cx('btn')} onClick={close}>
            キャンセル
          </button>
          <button className={cx('btn primary')} onClick={doCherryPick}>
            Cherry-pick
          </button>
        </div>
      </div>
    </div>
  );
}
