import { create } from 'zustand';

/**
 * コミットメッセージ入力欄への外部からの指示。
 * - draft: 入力欄へ流し込む下書き。cherry-pick --no-commit の直後に、git が用意した MERGE_MSG を
 *   入力欄へ載せるために使う。GitPanel が拾ったら clear() で消す (一度きり)
 * - focusRequested: 入力欄へのフォーカスの要求 (コマンドパレットの「コミット」)。
 *   コミットタブの入力欄ができた時点で GitPanel がフォーカスして取り下げる
 */
interface CommitDraftStore {
  draft: string | null;
  focusRequested: boolean;
  set: (text: string) => void;
  clear: () => void;
  requestFocus: () => void;
  clearFocusRequest: () => void;
}

export const useCommitDraft = create<CommitDraftStore>((set) => ({
  draft: null,
  focusRequested: false,
  set: (text) => set({ draft: text }),
  clear: () => set({ draft: null }),
  requestFocus: () => set({ focusRequested: true }),
  clearFocusRequest: () => set({ focusRequested: false }),
}));

export function setCommitDraft(text: string): void {
  useCommitDraft.getState().set(text);
}
