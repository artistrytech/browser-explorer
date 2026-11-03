import { useEffect, useRef } from 'react';
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelHandle,
} from 'react-resizable-panels';
import { Toolbar } from './app/Toolbar';
import { Sidebar } from './app/Sidebar';
import { StatusBar } from './app/StatusBar';
import { SettingsDialog } from './app/SettingsDialog';
import { RepoGroupsDialog } from './app/RepoGroupsDialog';
import { FileList } from './features/explorer/FileList';
import { EditorPane } from './features/editor/EditorPane';
import { GitPanel } from './features/git/GitPanel';
import { GitToolbar, GitMergeBanner } from './features/git/GitToolbar';
import { CloneDialog } from './features/git/CloneDialog';
import { ConflictResolver } from './features/git/ConflictResolver';
import { GitCommandDialog } from './features/git/GitCommandDialog';
import { SyncDialog } from './features/git/SyncDialog';
import { StashDialog } from './features/git/StashDialog';
import { CommitDetailDialog } from './features/git/CommitDetailDialog';
import { AuthDialog } from './features/git/AuthDialog';
import { CommitMessageDialog } from './features/git/CommitMessageDialog';
import { BranchDialog } from './features/git/BranchDialog';
import { RebaseDialog, RebaseOverlay } from './features/git/Rebase';
import { DiscardAllDialog } from './features/git/DiscardAllDialog';
import { CherryPickDialog } from './features/git/CherryPickDialog';
import { RevertDialog } from './features/git/RevertDialog';
import { DiffTab, useDiffTab, closeDiffTab, diffTargetFromUrl } from './features/git/DiffTab';
import { ReviewTab } from './features/review/ReviewTab';
import { previewPathFromUrl } from './features/preview/MarkdownPreview';
import { AppLogTab } from './features/applog/AppLogTab';
import { CodeMapTab } from './features/codemap/CodeMapTab';
import { useCodeMap } from './features/codemap/codeMapStore';
import { ReviewCreateDialog } from './features/review/ReviewCreateDialog';
import { ReviewExportDialog } from './features/review/ReviewExportDialog';
import { DualPaneDialog } from './features/transfer/DualPaneDialog';
import { TransferConfirmDialog } from './features/transfer/TransferConfirmDialog';
import { CommandPalette } from './features/palette/CommandPalette';
import { AiChatDialog, AiChatPanel } from './features/aichat/AiChatDialog';
import { loadDockSize, restoreAiChat, saveDockSize, useAiChat } from './features/aichat/aiChatStore';
import { TerminalPanel, TerminalWindow } from './features/terminal/TerminalPanel';
import { loadPanelSize, restoreTerminal, savePanelSize, useTerminal } from './features/terminal/terminalStore';
import { ContextMenuHost } from './components/ContextMenu';
import { DialogHost } from './components/DialogHost';
import { ToastHost } from './components/ToastHost';
import { useExplorer, pathFromUrl, searchFromUrl } from './stores/explorer';
import { useEditor } from './stores/editor';
import { useGit } from './stores/git';
import { useReview } from './stores/review';
import { useSettings } from './stores/settings';
import {
  useUi,
  reviewFileFromUrl,
  reviewIdFromUrl,
  reviewUrlParam,
  viewFromUrl,
  switchView,
  replaceView,
  isGitView,
  logFilterFromUrl,
  refreshUiConfig,
} from './stores/ui';
import { onFsChange, onWsEvent } from './api/ws';
import { useRebase } from './stores/rebase';
import { useAppLog, closeAppLog } from './stores/applog';
import { api } from './api/client';
import { saveCachedTheme } from './lib/themeCache';
import { parentPath, isRootPath, baseName } from './lib/paths';
import styles from './App.module.scss';
import { createCssModuleClassNames } from './lib/cssModule';
import { loadNewFileExts } from './lib/newFileExts';

const cx = createCssModuleClassNames(styles);

/** AI チャットの右パネルの幅 (メイン領域全体に対する %) */
const AI_DOCK_MIN = 18;
const AI_DOCK_MAX = 70;
/** ターミナルの下パネルの高さ (メイン領域に対する %) と右パネルの幅 (メイン領域全体に対する %) */
const TERM_BOTTOM_MIN = 10;
const TERM_BOTTOM_MAX = 85;
const TERM_RIGHT_MIN = 18;
const TERM_RIGHT_MAX = 70;

export default function App() {
  const path = useExplorer((s) => s.path);
  const navigate = useExplorer((s) => s.navigate);
  const tabs = useEditor((s) => s.tabs);
  const activePath = useEditor((s) => s.activePath);
  const editorRestoring = useEditor((s) => s.restoring);
  const diffTarget = useDiffTab((s) => s.current);
  const appLogOpened = useAppLog((s) => s.opened);
  /** コードマップの起点 (開いていなければ null)。タブ名は起点のシンボル名 (調べ終わるまではファイル名) */
  const codeMapOrigin = useCodeMap((s) => s.origin);
  const codeMapTitle = useCodeMap((s) => (s.rootId ? s.nodes[s.rootId]?.item.name : null));
  const repoRoot = useGit((s) => s.repoRoot);
  /** コミットタブに出す変更ファイル数 (ステージ済み + 変更 + 未追跡。リポジトリ外では出さない) */
  const changedCount = useGit((s) => s.status?.files.length ?? null);
  const { view, setView } = useUi();
  /** レビュー詳細を開いているか (開いている間はサイドバーを畳んで差分を広く取る) */
  const reviewDetailOpen = useReview((s) => s.currentId !== null);
  /** AI チャットを右パネルに固定して開いているか */
  const aiDocked = useAiChat((s) => s.open && s.docked);
  /** ターミナルを固定して開いている位置 (フローティング・非表示は null) */
  const termDock = useTerminal((s) => (s.open && s.position !== 'float' ? s.position : null));
  const theme = useSettings((s) => s.settings.theme);
  const loaded = useSettings((s) => s.loaded);
  const refreshTimer = useRef<ReturnType<typeof setTimeout>>();
  const sidebarPanel = useRef<ImperativePanelHandle>(null);

  // 初期化: 設定ロード → URL のパスを表示 (plan §6.5)
  useEffect(() => {
    void useSettings.getState().load();
    // ホスト OS 判定 (002.md §4.2): メニューラベルの出し分けに使う
    api.osPlatform().then((r) => useUi.getState().setPlatform(r.platform)).catch(() => {});
    // コンテキストメニューの表示設定・外部ツール (設定は DB。初回は config.jsonc から seed)
    void refreshUiConfig();
    // 「新規ファイル」の拡張子の候補 (作成した拡張子の履歴は DB)
    void loadNewFileExts();
    // 読み込み直す前に開いていたターミナル・エディタのファイル・AI チャットを開き直す
    void restoreTerminal();
    restoreAiChat();
    void useEditor.getState().restore();
    const initial = pathFromUrl();
    const initialView = viewFromUrl();
    const initialLogFilter = logFilterFromUrl();
    const initialSearch = searchFromUrl();
    const initialDiff = diffTargetFromUrl();
    const initialReview = reviewIdFromUrl();
    const initialReviewFile = reviewFileFromUrl();
    const initialPreview = previewPathFromUrl();
    const params = new URLSearchParams();
    params.set('path', initial);
    if (initialView !== 'files') params.set('view', initialView);
    if (initialLogFilter) {
      params.set('logpath', initialLogFilter.path);
      if (initialLogFilter.follow) params.set('follow', '1');
    }
    if (initialSearch) params.set('q', initialSearch);
    if (initialDiff) {
      params.set('drepo', initialDiff.repo);
      params.set('dhash', initialDiff.hash);
      params.set('dpath', initialDiff.path);
    }
    if (initialReview !== null) {
      params.set('review', reviewUrlParam(initialReview));
      if (initialReviewFile) params.set('rfile', initialReviewFile);
    }
    history.replaceState({ path: initial, view: initialView }, '', `${location.pathname}?${params}`);
    useUi.getState().setView(initialView);
    useGit.getState().setLogFilter(initialLogFilter);
    if (initialDiff) useDiffTab.getState().open(initialDiff);
    // ?ppath= (Markdown のリンクを別タブで開いたとき等) はエディタタブのプレビューで開く (URL には残さない)
    if (initialPreview) void useEditor.getState().open(initialPreview, 'preview');
    if (initialView === 'applog') useAppLog.setState({ opened: true });
    void navigate(initial, false).then(() => {
      if (initialSearch) void useExplorer.getState().runSearch(initialSearch, false);
    });

    // 戻る/進む: パス・ビュー・ログ絞り込み・検索を URL から復元する
    const onPop = () => {
      void useExplorer.getState().navigate(pathFromUrl(), false).then(() => {
        const q = searchFromUrl();
        if (q) void useExplorer.getState().runSearch(q, false);
      });
      const nextView = viewFromUrl();
      useUi.getState().setView(nextView);
      // アプリログタブは閉じた後でも履歴で戻れるので、その場合はタブを復活させる
      if (nextView === 'applog') useAppLog.setState({ opened: true });
      const cur = useGit.getState().logFilter;
      const next = logFilterFromUrl();
      // 内容が同じなら参照を維持 (不要な再読込を避ける)
      if (!(cur && next && cur.path === next.path && cur.follow === next.follow)) {
        useGit.getState().setLogFilter(next);
      }
      // 差分タブの対象も URL から復元 (同一対象なら参照を維持)
      const curDiff = useDiffTab.getState().current;
      const nextDiff = diffTargetFromUrl();
      if (nextDiff && (curDiff?.hash !== nextDiff.hash || curDiff?.path !== nextDiff.path)) {
        useDiffTab.getState().open(nextDiff);
      }
      // レビュータブ: 一覧 ⇄ 詳細・選択中ファイルも URL から復元する
      useReview.getState().syncFromUrl();
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // パス変更時: Git リポジトリ判定 + 最近使った項目
  useEffect(() => {
    void useGit.getState().checkRepo(path);
    if (loaded) useSettings.getState().addRecent(path, 'dir');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // WS: ファイル変更 → 一覧/エディタ/Git を更新
  useEffect(() => {
    return onFsChange((e) => {
      clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => {
        void useExplorer.getState().refresh();
        void useGit.getState().refreshStatus();
      }, 300);
      useEditor.getState().handleExternalChange(e.path);
    });
  }, []);

  // ブラウザのタブにフォーカスが戻ったら変更一覧 (Git status)・一覧・リベース状態を最新化する
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'hidden') return;
      void useGit.getState().refreshStatus();
      void useExplorer.getState().refresh();
      const repo = useGit.getState().repoRoot;
      if (repo) void useRebase.getState().refresh(repo);
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);

  // リベースセッションの取得/同期: リポジトリ切替時と、他タブからの変更 (WS) で更新する
  useEffect(() => {
    if (repoRoot) void useRebase.getState().refresh(repoRoot);
    else useRebase.setState({ session: null });
  }, [repoRoot]);

  useEffect(() => {
    return onWsEvent('git:rebase', () => {
      const repo = useGit.getState().repoRoot;
      if (repo) void useRebase.getState().refresh(repo);
    });
  }, []);

  // グローバルキー: Alt+↑ 上へ / Alt+← 戻る / Alt+→ 進む (plan §1.2)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        const p = useExplorer.getState().path;
        if (!isRootPath(p)) void useExplorer.getState().navigate(parentPath(p));
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        history.back();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        history.forward();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // テーマ反映。次回の起動直後 (設定の読み込み前) に使えるよう控えておく
  useEffect(() => {
    document.body.dataset.theme = theme;
    if (loaded) saveCachedTheme(theme);
  }, [theme, loaded]);

  // レビュー詳細は差分をできるだけ広く見せたいので、その間だけサイドバーを畳む
  useEffect(() => {
    const panel = sidebarPanel.current;
    if (!panel) return;
    if (view === 'review' && reviewDetailOpen) panel.collapse();
    else if (panel.isCollapsed()) panel.expand();
  }, [view, reviewDetailOpen]);

  // エディタタブが無くなったら files へ (履歴は積まず URL のみ整合させる)。
  // 読み込み直した直後はファイルを開き直し終わるまで待つ
  useEffect(() => {
    if (view === 'editor' && tabs.length === 0 && !editorRestoring) replaceView('files');
  }, [view, tabs.length, editorRestoring, setView]);

  // 差分タブ: 対象が無いのに view=diff (リロード直後等) なら files へ
  useEffect(() => {
    if (view === 'diff' && !diffTarget) replaceView('files');
  }, [view, diffTarget]);

  // コードマップ: 起点が無いのに view=codemap (リロード直後等) なら files へ
  useEffect(() => {
    if (view === 'codemap' && !codeMapOrigin) replaceView('files');
  }, [view, codeMapOrigin]);

  useEffect(() => {
    const activeTab = tabs.find((t) => t.path === activePath);
    const title =
      view === 'files'
        ? baseName(path) || path
        : view === 'editor'
          ? activeTab?.name || 'Explorer'
          : view === 'applog'
              ? 'アプリログ'
              : view === 'codemap' && codeMapOrigin
              ? `参照マップ: ${codeMapTitle ?? baseName(codeMapOrigin.path)}`
              : (isGitView(view) || view === 'review') && repoRoot
              ? baseName(repoRoot) || repoRoot
              : 'Explorer';
    document.title = title;
  }, [activePath, path, repoRoot, tabs, view, codeMapOrigin, codeMapTitle]);

  return (
    <div className={cx("app")}>
      <Toolbar />
      <div className={cx("view-tabs")}>
        <button className={cx(`view-tab${view === 'files' ? ' active' : ''}`)} onClick={() => switchView('files')}>
          📁 ファイル
        </button>
        {tabs.length > 0 && (
          <button className={cx(`view-tab${view === 'editor' ? ' active' : ''}`)} onClick={() => switchView('editor')}>
            📝 エディタ ({tabs.length})
          </button>
        )}
        {/* Git 系は独立した最上位タブ (コミットは旧「変更」と同機能)。履歴もそれぞれ独立 */}
        <button className={cx(`view-tab${view === 'commit' ? ' active' : ''}`)} onClick={() => switchView('commit')}>
          🌿 コミット{changedCount === null ? '' : ` (${changedCount})`}
        </button>
        <button className={cx(`view-tab${view === 'log' ? ' active' : ''}`)} onClick={() => switchView('log')}>
          📜 ログ
        </button>
        <button className={cx(`view-tab${view === 'branches' ? ' active' : ''}`)} onClick={() => switchView('branches')}>
          🔀 ブランチ
        </button>
        <button className={cx(`view-tab${view === 'review' ? ' active' : ''}`)} onClick={() => switchView('review')}>
          🔍 レビュー
        </button>
        {appLogOpened && (
          <button
            className={cx(`view-tab${view === 'applog' ? ' active' : ''}`)}
            onClick={() => switchView('applog')}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                closeAppLog();
              }
            }}
          >
            🩺 アプリログ
            <span
              className={cx("view-tab-close")}
              title="アプリログタブを閉じる"
              onClick={(e) => {
                e.stopPropagation();
                closeAppLog();
              }}
            >
              ✕
            </span>
          </button>
        )}
        {codeMapOrigin && (
          <button
            className={cx(`view-tab${view === 'codemap' ? ' active' : ''}`)}
            onClick={() => switchView('codemap')}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                useCodeMap.getState().close();
              }
            }}
          >
            🕸 {codeMapTitle ?? baseName(codeMapOrigin.path)}
            <span
              className={cx("view-tab-close")}
              title="参照マップを閉じる"
              onClick={(e) => {
                e.stopPropagation();
                useCodeMap.getState().close();
              }}
            >
              ✕
            </span>
          </button>
        )}
        {diffTarget && (
          <button
            className={cx(`view-tab${view === 'diff' ? ' active' : ''}`)}
            onClick={() => switchView('diff')}
            onMouseDown={(e) => {
              // 中クリックでも閉じられるように (エディタタブと同様)
              if (e.button === 1) {
                e.preventDefault();
                closeDiffTab();
              }
            }}
          >
            ± {baseName(diffTarget.path)}
            <span
              className={cx("view-tab-close")}
              title="差分タブを閉じる"
              onClick={(e) => {
                e.stopPropagation();
                closeDiffTab();
              }}
            >
              ✕
            </span>
          </button>
        )}
      </div>
      <PanelGroup direction="horizontal" className={cx("main-split")}>
        {/* AI チャット・ターミナルの右パネルを出し入れするので、各パネルに id / order を付ける */}
        <Panel id="sidebar" order={1} ref={sidebarPanel} collapsible defaultSize={18} minSize={12} maxSize={40}>
          <Sidebar />
        </Panel>
        <PanelResizeHandle className={cx("resize-handle")} />
        <Panel id="main" order={2}>
          {/* ターミナルの下パネルを出し入れしてもメインの表示を作り直さないよう、縦の分割は常に置く */}
          <PanelGroup direction="vertical">
            <Panel id="main-view" order={1}>
              <div className={cx("main-area")}>
                <div className={cx(`main-view${view === 'files' ? '' : ' hidden'}`)}>
                  {/* リポジトリ内ならファイルタブにも Git のツールバー (ブランチ・同期・Stash 等) を出す */}
                  <GitToolbar />
                  <GitMergeBanner />
                  <FileList />
                </div>
                <div className={cx(`main-view${view === 'editor' ? '' : ' hidden'}`)}>
                  {/* ファイルタブと同じく、リポジトリ内なら Git のツールバーを出す (表示中だけ。エディタ本体は保ったまま) */}
                  {view === 'editor' && (
                    <>
                      <GitToolbar />
                      <GitMergeBanner />
                    </>
                  )}
                  {tabs.length > 0 && <EditorPane />}
                </div>
                <div className={cx(`main-view${isGitView(view) ? '' : ' hidden'}`)}>
                  {/* コミット/ログ/ブランチ間の切替では GitPanel をアンマウントせず状態を保つ */}
                  {isGitView(view) && (
                    <GitPanel tab={view === 'commit' ? 'changes' : view === 'log' ? 'log' : 'branches'} />
                  )}
                </div>
                <div className={cx(`main-view${view === 'review' ? '' : ' hidden'}`)}>
                  {view === 'review' && <ReviewTab />}
                </div>
                <div className={cx(`main-view${view === 'diff' ? '' : ' hidden'}`)}>
                  {view === 'diff' && <DiffTab />}
                </div>
                <div className={cx(`main-view${view === 'applog' ? '' : ' hidden'}`)}>
                  {view === 'applog' && <AppLogTab />}
                </div>
                <div className={cx(`main-view${view === 'codemap' ? '' : ' hidden'}`)}>
                  {/* 他のタブへ切り替えても表示位置・展開を保つよう、開いている間はアンマウントしない */}
                  {codeMapOrigin && <CodeMapTab />}
                </div>
              </div>
            </Panel>
            {termDock === 'bottom' && (
              <>
                <PanelResizeHandle className={cx("resize-handle-row")} />
                <Panel
                  id="terminal-bottom"
                  order={2}
                  defaultSize={loadPanelSize('bottom', TERM_BOTTOM_MIN, TERM_BOTTOM_MAX)}
                  minSize={TERM_BOTTOM_MIN}
                  maxSize={TERM_BOTTOM_MAX}
                  onResize={(size) => savePanelSize('bottom', size)}
                >
                  <TerminalPanel />
                </Panel>
              </>
            )}
          </PanelGroup>
        </Panel>
        {termDock === 'right' && (
          <>
            <PanelResizeHandle className={cx("resize-handle")} />
            <Panel
              id="terminal-right"
              order={3}
              defaultSize={loadPanelSize('right', TERM_RIGHT_MIN, TERM_RIGHT_MAX)}
              minSize={TERM_RIGHT_MIN}
              maxSize={TERM_RIGHT_MAX}
              onResize={(size) => savePanelSize('right', size)}
            >
              <TerminalPanel />
            </Panel>
          </>
        )}
        {aiDocked && (
          <>
            <PanelResizeHandle className={cx("resize-handle")} />
            <Panel
              id="aichat"
              order={4}
              defaultSize={loadDockSize(AI_DOCK_MIN, AI_DOCK_MAX)}
              minSize={AI_DOCK_MIN}
              maxSize={AI_DOCK_MAX}
              onResize={saveDockSize}
            >
              <AiChatPanel />
            </Panel>
          </>
        )}
      </PanelGroup>
      <StatusBar />
      {/* AI チャット (フローティング時)。モードレスで、モーダルのダイアログ・コンテキストメニューより下に出す */}
      <AiChatDialog />
      {/* ターミナル (フローティング時)。AI チャットと同じくモードレス */}
      <TerminalWindow />
      <ContextMenuHost />
      <DialogHost />
      <ToastHost />
      <SettingsDialog />
      <RepoGroupsDialog />
      <CloneDialog />
      {/* リベース中の全画面ロック。ConflictResolver より前に置き、解消ツールを手前に重ねる */}
      <RebaseOverlay />
      <ConflictResolver />
      <SyncDialog />
      <StashDialog />
      {/* コミット/Stash の詳細。Stash ダイアログの手前に重ねる */}
      <CommitDetailDialog />
      <AuthDialog />
      <CommitMessageDialog />
      <BranchDialog />
      <RebaseDialog />
      <DiscardAllDialog />
      <CherryPickDialog />
      <RevertDialog />
      <ReviewCreateDialog />
      <ReviewExportDialog />
      <DualPaneDialog />
      {/* コピー / 移動の確認は「2 画面で整理」ダイアログの上に重ねる */}
      <TransferConfirmDialog />
      {/* 実行結果ダイアログは他ダイアログより手前に出すため最後にマウント */}
      <GitCommandDialog />
      {/* Ctrl+Shift+P のコマンドパレット */}
      <CommandPalette />
    </div>
  );
}
