import { create } from 'zustand';

/**
 * コミットメッセージ入力欄へ外部から流し込む下書き。
 * cherry-pick --no-commit の直後に、git が用意した MERGE_MSG を入力欄へ載せるために使う。
 * GitPanel が拾ったら clear() で消す (一度きり)。
 */
interface CommitDraftStore {
  draft: string | null;
  set: (text: string) => void;
  clear: () => void;
}

export const useCommitDraft = create<CommitDraftStore>((set) => ({
  draft: null,
  set: (text) => set({ draft: text }),
  clear: () => set({ draft: null }),
}));

export function setCommitDraft(text: string): void {
  useCommitDraft.getState().set(text);
}
