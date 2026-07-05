import { create } from 'zustand';

/** メイン領域の表示: ファイル一覧 / Git パネル / エディタ */
export type MainView = 'files' | 'git' | 'editor';

interface UiStore {
  view: MainView;
  settingsOpen: boolean;
  setView: (v: MainView) => void;
  setSettingsOpen: (open: boolean) => void;
}

export const useUi = create<UiStore>((set) => ({
  view: 'files',
  settingsOpen: false,
  setView: (view) => set({ view }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
}));
