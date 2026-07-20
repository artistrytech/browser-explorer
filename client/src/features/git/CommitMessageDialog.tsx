import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { api } from '../../api/client';
import { toastError } from '../../stores/toast';

/**
 * 過去のコミットメッセージから 1 件選ぶダイアログ。
 * openCommitMessagePicker() で開き、選択したメッセージ (キャンセルは null) を Promise で返す。
 * 一覧はサーバ DB (commit_messages) から新しい順・重複なし・最大 20 件で取得する。
 */

interface Store {
  open: boolean;
  resolve: ((v: string | null) => void) | null;
  show: (resolve: (v: string | null) => void) => void;
  close: () => void;
}

const useStore = create<Store>((set) => ({
  open: false,
  resolve: null,
  show: (resolve) => set({ open: true, resolve }),
  close: () => set({ open: false, resolve: null }),
}));

export function openCommitMessagePicker(): Promise<string | null> {
  return new Promise((resolve) => useStore.getState().show(resolve));
}

export function CommitMessageDialog() {
  const { open, resolve, close } = useStore();
  const [messages, setMessages] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    api
      .gitCommitMessages()
      .then((r) => setMessages(r.messages))
      .catch(toastError)
      .finally(() => setLoading(false));
  }, [open]);

  if (!open) return null;

  const finish = (value: string | null) => {
    resolve?.(value);
    close();
  };

  return (
    <div className="dialog-backdrop" onMouseDown={() => finish(null)}>
      <div className="dialog msg-history-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-title">コミットメッセージの履歴</div>
        {loading ? (
          <div className="empty-hint">読み込み中…</div>
        ) : messages.length === 0 ? (
          <div className="empty-hint">保存されたコミットメッセージはありません</div>
        ) : (
          <div className="msg-history-list">
            {messages.map((m, i) => (
              <button
                key={i}
                className="msg-history-row"
                title="クリックで選択"
                onClick={() => finish(m)}
              >
                {m}
              </button>
            ))}
          </div>
        )}
        <div className="dialog-buttons">
          <button className="btn" onClick={() => finish(null)}>
            キャンセル
          </button>
        </div>
      </div>
    </div>
  );
}
