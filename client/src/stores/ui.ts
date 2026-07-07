import { create } from 'zustand';

/**
 * メイン領域の表示: ファイル一覧 / コミット(変更) / ログ / ブランチ / エディタ / コミット差分。
 * Git 系 (commit/log/branches) はそれぞれ独立した最上位タブ (ブラウザ履歴も独立)。
 */
export type MainView = 'files' | 'commit' | 'log' | 'branches' | 'editor' | 'diff';

/** Git パネルを表示するビューか */
export function isGitView(v: MainView): boolean {
  return v === 'commit' || v === 'log' || v === 'branches';
}

interface UiStore {
  view: MainView;
  settingsOpen: boolean;
  /** サーバー (ホスト) の OS。メニューラベルの出し分けに使う (002.md §4.2) */
  platform: string;
  setView: (v: MainView) => void;
  setSettingsOpen: (open: boolean) => void;
  setPlatform: (p: string) => void;
}

export const useUi = create<UiStore>((set) => ({
  view: 'files',
  settingsOpen: false,
  platform: 'win32',
  setView: (view) => set({ view }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setPlatform: (platform) => set({ platform }),
}));

/** URL の ?view= から表示ビューを復元 (無指定は files)。旧 'git' は 'commit' に読み替え */
export function viewFromUrl(): MainView {
  const v = new URLSearchParams(location.search).get('view');
  if (v === 'git') return 'commit';
  return v === 'commit' || v === 'log' || v === 'branches' || v === 'editor' || v === 'diff'
    ? v
    : 'files';
}

/**
 * ユーザー操作によるビュー切替: ブラウザ履歴に積む。
 * 「Git タブ選択」「ファイル編集」等の後にブラウザバックで「ファイル」タブへ戻れる。
 */
export function switchView(view: MainView): void {
  if (useUi.getState().view !== view) {
    const params = new URLSearchParams(location.search);
    if (view === 'files') params.delete('view');
    else params.set('view', view);
    history.pushState({ path: params.get('path'), view }, '', `${location.pathname}?${params}`);
  }
  useUi.getState().setView(view);
}

/** 履歴を積まずにビューを切替え、URL の ?view= を現状に合わせる (自動フォールバック用) */
export function replaceView(view: MainView): void {
  const params = new URLSearchParams(location.search);
  if (view === 'files') params.delete('view');
  else params.set('view', view);
  history.replaceState(history.state, '', `${location.pathname}?${params}`);
  useUi.getState().setView(view);
}

/** OS 別のメニューラベル (002.md §4.1) */
export function osMenuLabels(platform: string): { fileManager: string; terminal: string } {
  if (platform === 'darwin') return { fileManager: 'Finder で開く', terminal: 'ターミナルで開く' };
  if (platform === 'win32') return { fileManager: 'Explorer で開く', terminal: 'コマンドプロンプトで開く' };
  return { fileManager: 'ファイルマネージャで開く', terminal: 'ターミナルで開く' };
}
