import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { api } from '../../api/client';
import { toastError } from '../../stores/toast';
import styles from './CommitMessageDialog.module.scss';
import { createCssModuleClassNames } from '../../lib/cssModule';

const cx = createCssModuleClassNames(styles);

/**
 * 過去のコミットメッセージから 1 件選ぶダイアログ。
 * openCommitMessagePicker(repo) で開き、選択したメッセージ (キャンセルは null) を Promise で返す。
 * 一覧はサーバ DB (commit_messages) から新しい順・重複なし・最大 20 件で取得する。
 * 取得範囲は「現在のリポジトリ / 全リポジトリ」から選べ、選択はセッション中は引き継ぐ。
 */

/** 履歴の取得範囲 */
type Scope = 'repo' | 'all';

interface Store {
  open: boolean;
  repo: string;
  scope: Scope;
  resolve: ((v: string | null) => void) | null;
  show: (repo: string, resolve: (v: string | null) => void) => void;
  setScope: (scope: Scope) => void;
  close: () => void;
}

const useStore = create<Store>((set) => ({
  open: false,
  repo: '',
  scope: 'repo', // 既定は現在のリポジトリ。以降は前回の選択を引き継ぐ
  resolve: null,
  show: (repo, resolve) => set({ open: true, repo, resolve }),
  setScope: (scope) => set({ scope }),
  close: () => set({ open: false, resolve: null }),
}));

export function openCommitMessagePicker(repo: string): Promise<string | null> {
  return new Promise((resolve) => useStore.getState().show(repo, resolve));
}

export function CommitMessageDialog() {
  const { open, repo, scope, setScope, resolve, close } = useStore();
  const [messages, setMessages] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let stale = false;
    setLoading(true);
    api
      .gitCommitMessages(scope === 'repo' ? repo : undefined)
      .then((r) => {
        if (!stale) setMessages(r.messages);
      })
      .catch((e) => {
        if (!stale) toastError(e);
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true; // 範囲を素早く切り替えた場合、古い応答で上書きしない
    };
  }, [open, repo, scope]);

  if (!open) return null;

  const finish = (value: string | null) => {
    resolve?.(value);
    close();
  };

  return (
    <div className={cx("dialog-backdrop")} onMouseDown={() => finish(null)}>
      <div className={cx("dialog msg-history-dialog")} onMouseDown={(e) => e.stopPropagation()}>
        <div className={cx("dialog-title")}>コミットメッセージの履歴</div>
        <div className={cx("msg-history-scope")}>
          <label className={cx("msg-history-scope-item")}>
            <input
              type="radio"
              name="commit-message-scope"
              checked={scope === 'repo'}
              onChange={() => setScope('repo')}
            />
            <span>現在のリポジトリ</span>
          </label>
          <label className={cx("msg-history-scope-item")}>
            <input
              type="radio"
              name="commit-message-scope"
              checked={scope === 'all'}
              onChange={() => setScope('all')}
            />
            <span>全リポジトリ</span>
          </label>
        </div>
        {loading ? (
          <div className={cx("empty-hint")}>読み込み中…</div>
        ) : messages.length === 0 ? (
          <div className={cx("empty-hint")}>保存されたコミットメッセージはありません</div>
        ) : (
          <div className={cx("msg-history-list")}>
            {messages.map((m, i) => (
              <button
                key={i}
                className={cx("msg-history-row")}
                title={m}
                onClick={() => finish(m)}
              >
                {m}
              </button>
            ))}
          </div>
        )}
        <div className={cx("dialog-buttons")}>
          <button className={cx("btn")} onClick={() => finish(null)}>
            キャンセル
          </button>
        </div>
      </div>
    </div>
  );
}
