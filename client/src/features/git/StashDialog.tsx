import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { api } from '../../api/client';
import { useGit } from '../../stores/git';
import { toastError } from '../../stores/toast';
import { runGitCommands } from './GitCommandDialog';
import styles from './StashDialog.module.scss';
import { createCssModuleClassNames } from '../../lib/cssModule';

const cx = createCssModuleClassNames(styles);

/**
 * Stash ダイアログ:
 * - 現在の変更の退避 (git stash push、メッセージ任意)
 * - 退避一覧から選択して復元 (復元成功後に削除するかを選択: pop / apply)
 */

interface StashEntry {
  ref: string; // stash@{n}
  date: string;
  message: string;
}

interface StashDialogStore {
  open: boolean;
  show: () => void;
  close: () => void;
}

export const useStashDialog = create<StashDialogStore>((set) => ({
  open: false,
  show: () => set({ open: true }),
  close: () => set({ open: false }),
}));

export function openStashDialog(): void {
  useStashDialog.getState().show();
}

export function StashDialog() {
  const { open, close } = useStashDialog();
  const repoRoot = useGit((s) => s.repoRoot);
  const status = useGit((s) => s.status);
  const [list, setList] = useState<StashEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [dropAfter, setDropAfter] = useState(true);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const hasChanges = (status?.files.length ?? 0) > 0;

  // 開くたびに一覧を取得 (実行結果ダイアログとは別に、静かに取得する)
  useEffect(() => {
    if (!open || !repoRoot) return;
    setMessage('');
    setDropAfter(true);
    setLoading(true);
    api
      .gitExec(repoRoot, ['stash', 'list', '--format=%gd%x1f%ci%x1f%gs'])
      .then((r) => {
        const rows = r.output
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => {
            const [ref, date, msg] = l.split('\x1f');
            return { ref: ref ?? '', date: (date ?? '').slice(0, 16), message: msg ?? '' };
          })
          .filter((e) => e.ref.startsWith('stash@'));
        setList(rows);
        setSelected(rows[0]?.ref ?? null);
      })
      .catch(toastError)
      .finally(() => setLoading(false));
  }, [open, repoRoot]);

  if (!open || !repoRoot) return null;

  const doStash = () => {
    const msg = message.trim();
    close();
    void runGitCommands(repoRoot, [msg ? ['stash', 'push', '-m', msg] : ['stash', 'push']], 'Stash');
  };

  const doRestore = () => {
    if (!selected) return;
    close();
    void runGitCommands(
      repoRoot,
      [['stash', dropAfter ? 'pop' : 'apply', selected]],
      dropAfter ? 'Stash 復元 (復元後に削除)' : 'Stash 復元',
    );
  };

  return (
    <div className={cx("dialog-backdrop")}>
      <div className={cx("dialog push-dialog")}>
        <div className={cx("dialog-title")}>Stash</div>
        <div className={cx("clone-form")}>
          <div className={cx("stash-section-title")}>現在の変更を退避</div>
          <label className={cx("clone-row")}>
            <span className={cx("clone-label wide")}>メッセージ:</span>
            <input
              className={cx("clone-input")}
              value={message}
              placeholder="(任意)"
              onChange={(e) => setMessage(e.target.value)}
            />
          </label>
          <div className={cx("clone-row")}>
            <span className={cx("status-spacer")} />
            <button className={cx("btn")} disabled={!hasChanges} title={hasChanges ? '' : '退避する変更がありません'} onClick={doStash}>
              退避 (stash push)
            </button>
          </div>

          <div className={cx("stash-section-title")}>退避一覧から復元</div>
          {loading ? (
            <div className={cx("empty-hint")}>読み込み中…</div>
          ) : list.length === 0 ? (
            <div className={cx("empty-hint")}>退避された変更はありません</div>
          ) : (
            <>
              <div className={cx("stash-list")}>
                {list.map((s) => (
                  <button
                    key={s.ref}
                    className={cx(`stash-row${selected === s.ref ? ' active' : ''}`)}
                    onClick={() => setSelected(s.ref)}
                  >
                    <span className={cx("stash-ref")}>{s.ref}</span>
                    <span className={cx("stash-msg")} title={s.message}>
                      {s.message}
                    </span>
                    <span className={cx("stash-date")}>{s.date}</span>
                  </button>
                ))}
              </div>
              <label className={cx("clone-row")}>
                <input
                  type="checkbox"
                  checked={dropAfter}
                  onChange={(e) => setDropAfter(e.target.checked)}
                />
                <span>復元に成功したら一覧から削除する (pop)</span>
              </label>
            </>
          )}
        </div>
        <div className={cx("dialog-buttons")}>
          <button className={cx("btn")} onClick={close}>
            キャンセル
          </button>
          <button className={cx("btn primary")} disabled={!selected || loading} onClick={doRestore}>
            復元
          </button>
        </div>
      </div>
    </div>
  );
}
