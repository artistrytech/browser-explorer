import { create } from 'zustand';
import { api } from '../api/client';

/**
 * メイン領域の表示: ファイル一覧 / コミット(変更) / ログ / ブランチ / エディタ / コミット差分。
 * Git 系 (commit/log/branches) はそれぞれ独立した最上位タブ (ブラウザ履歴も独立)。
 */
export type MainView = 'files' | 'commit' | 'log' | 'branches' | 'editor' | 'diff';

/** Git パネルを表示するビューか */
export function isGitView(v: MainView): boolean {
  return v === 'commit' || v === 'log' || v === 'branches';
}

/** コンテキストメニューのカスタム項目 (id が実行時の識別子)。group でサブメニューに入る */
export interface ExternalTool {
  id: string;
  label: string;
  group?: string;
  /** 対象種別 (any = 両方)。メニュー表示条件に使う */
  kind?: 'file' | 'dir' | 'any';
  /** 対象拡張子 (ドット無し・小文字。空=全拡張子)。FsEntry.ext と同形式 */
  extensions?: string[];
  /** 起動前に確認ダイアログを出すか */
  confirm?: boolean;
}

/** 外部差分ツール (id が識別子)。isDefault はダブルクリック時に使うツール (最大 1 つ) */
export interface DiffTool {
  id: string;
  label: string;
  isDefault?: boolean;
}

/** 既定の差分ツールの index (未設定なら -1 → アプリ内の 2 ペイン差分を使う) */
export function defaultDiffToolIndex(tools: DiffTool[]): number {
  return tools.findIndex((t) => t.isDefault);
}

interface UiStore {
  view: MainView;
  settingsOpen: boolean;
  /** サーバー (ホスト) の OS。メニューラベルの出し分けに使う (002.md §4.2) */
  platform: string;
  /** コンテキストメニューの表示設定 (config.jsonc の contextMenu。false で非表示) */
  menuConfig: Record<string, boolean>;
  /** コンテキストメニューから起動する外部ツール (設定の externalTools。id が識別子) */
  externalTools: ExternalTool[];
  /** 差分表示に使う外部ツール (設定の diffTools。id が識別子) */
  diffTools: DiffTool[];
  /** 拡張子 (ドット無し・小文字) → externalTool.id。ダブルクリック時の既定起動ツール */
  extDefaults: Record<string, string>;
  setView: (v: MainView) => void;
  setSettingsOpen: (open: boolean) => void;
  setPlatform: (p: string) => void;
  setMenuConfig: (m: Record<string, boolean>) => void;
  setExternalTools: (t: ExternalTool[]) => void;
  setDiffTools: (t: DiffTool[]) => void;
  setExtDefaults: (m: Record<string, string>) => void;
}

export const useUi = create<UiStore>((set) => ({
  view: 'files',
  settingsOpen: false,
  platform: 'win32',
  menuConfig: {},
  externalTools: [],
  diffTools: [],
  extDefaults: {},
  setView: (view) => set({ view }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setPlatform: (platform) => set({ platform }),
  setMenuConfig: (menuConfig) => set({ menuConfig }),
  setExternalTools: (externalTools) => set({ externalTools }),
  setDiffTools: (diffTools) => set({ diffTools }),
  setExtDefaults: (extDefaults) => set({ extDefaults }),
}));

/**
 * サーバから UI 設定 (コンテキストメニュー / 外部ツール / 差分ツール / 既定ツール) を取得して反映。
 * 起動時と、設定画面での保存後に呼ぶ (再起動なしで即時反映)。
 */
export async function refreshUiConfig(): Promise<void> {
  const r = await api.uiConfig();
  const s = useUi.getState();
  s.setMenuConfig(r.contextMenu ?? {});
  s.setExternalTools(r.externalTools ?? []);
  s.setDiffTools(r.diffTools ?? []);
  s.setExtDefaults(r.extDefaults ?? {});
}

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

/** URL の ?logpath= / ?follow= からログのパス絞り込みを復元 */
export function logFilterFromUrl(): { path: string; follow: boolean } | null {
  const params = new URLSearchParams(location.search);
  const p = params.get('logpath');
  return p ? { path: p, follow: params.get('follow') === '1' } : null;
}

/**
 * ログタブをパス絞り込み付きで開く: URL に対象の相対パスを含めて履歴に積む。
 * (ブラウザバックで絞り込み前のログ/前のビューへ戻れる)
 */
export function pushLogView(filter: { path: string; follow: boolean } | null): void {
  const params = new URLSearchParams(location.search);
  params.set('view', 'log');
  params.delete('logpath');
  params.delete('follow');
  if (filter) {
    params.set('logpath', filter.path);
    if (filter.follow) params.set('follow', '1');
  }
  const search = `?${params}`;
  if (location.search !== search) {
    history.pushState({ path: params.get('path'), view: 'log' }, '', `${location.pathname}${search}`);
  }
  useUi.getState().setView('log');
}

/** ログタブをブラウザの別タブで開く (Ctrl+クリック用) */
export function openLogInNewTab(filter: { path: string; follow: boolean } | null): void {
  const params = new URLSearchParams(location.search);
  params.set('view', 'log');
  params.delete('logpath');
  params.delete('follow');
  if (filter) {
    params.set('logpath', filter.path);
    if (filter.follow) params.set('follow', '1');
  }
  window.open(`${location.pathname}?${params}`, '_blank');
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
