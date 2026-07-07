import { useEffect, useRef } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { Toolbar } from './app/Toolbar';
import { Sidebar } from './app/Sidebar';
import { StatusBar } from './app/StatusBar';
import { SettingsDialog } from './app/SettingsDialog';
import { FileList } from './features/explorer/FileList';
import { EditorPane } from './features/editor/EditorPane';
import { GitPanel } from './features/git/GitPanel';
import { CloneDialog } from './features/git/CloneDialog';
import { ConflictResolver } from './features/git/ConflictResolver';
import { GitCommandDialog } from './features/git/GitCommandDialog';
import { PushDialog } from './features/git/PushDialog';
import { DiffTab, useDiffTab, closeDiffTab } from './features/git/DiffTab';
import { ContextMenuHost } from './components/ContextMenu';
import { DialogHost } from './components/DialogHost';
import { ToastHost } from './components/ToastHost';
import { useExplorer, pathFromUrl } from './stores/explorer';
import { useEditor } from './stores/editor';
import { useGit } from './stores/git';
import { useSettings } from './stores/settings';
import { useUi, viewFromUrl, switchView, replaceView, isGitView } from './stores/ui';
import { onFsChange } from './api/ws';
import { api } from './api/client';
import { parentPath, isRootPath, baseName } from './lib/paths';

export default function App() {
  const path = useExplorer((s) => s.path);
  const navigate = useExplorer((s) => s.navigate);
  const tabs = useEditor((s) => s.tabs);
  const diffTarget = useDiffTab((s) => s.current);
  const { view, setView } = useUi();
  const theme = useSettings((s) => s.settings.theme);
  const loaded = useSettings((s) => s.loaded);
  const refreshTimer = useRef<ReturnType<typeof setTimeout>>();

  // 初期化: 設定ロード → URL のパスを表示 (plan §6.5)
  useEffect(() => {
    void useSettings.getState().load();
    // ホスト OS 判定 (002.md §4.2): メニューラベルの出し分けに使う
    api.osPlatform().then((r) => useUi.getState().setPlatform(r.platform)).catch(() => {});
    const initial = pathFromUrl();
    const initialView = viewFromUrl();
    const params = new URLSearchParams();
    params.set('path', initial);
    if (initialView !== 'files') params.set('view', initialView);
    history.replaceState({ path: initial, view: initialView }, '', `${location.pathname}?${params}`);
    useUi.getState().setView(initialView);
    void navigate(initial, false);

    // 戻る/進む: パスとビューの両方を URL から復元する
    const onPop = () => {
      void useExplorer.getState().navigate(pathFromUrl(), false);
      useUi.getState().setView(viewFromUrl());
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

  // テーマ反映
  useEffect(() => {
    document.body.dataset.theme = theme;
  }, [theme]);

  // エディタタブが無くなったら files へ (履歴は積まず URL のみ整合させる)
  useEffect(() => {
    if (view === 'editor' && tabs.length === 0) replaceView('files');
  }, [view, tabs.length, setView]);

  // 差分タブ: 対象が無いのに view=diff (リロード直後等) なら files へ
  useEffect(() => {
    if (view === 'diff' && !diffTarget) replaceView('files');
  }, [view, diffTarget]);

  return (
    <div className="app">
      <Toolbar />
      <div className="view-tabs">
        <button className={`view-tab${view === 'files' ? ' active' : ''}`} onClick={() => switchView('files')}>
          📁 ファイル
        </button>
        {tabs.length > 0 && (
          <button className={`view-tab${view === 'editor' ? ' active' : ''}`} onClick={() => switchView('editor')}>
            📝 エディタ ({tabs.length})
          </button>
        )}
        {/* Git 系は独立した最上位タブ (コミットは旧「変更」と同機能)。履歴もそれぞれ独立 */}
        <button className={`view-tab${view === 'commit' ? ' active' : ''}`} onClick={() => switchView('commit')}>
          🌿 コミット
        </button>
        <button className={`view-tab${view === 'log' ? ' active' : ''}`} onClick={() => switchView('log')}>
          📜 ログ
        </button>
        <button className={`view-tab${view === 'branches' ? ' active' : ''}`} onClick={() => switchView('branches')}>
          🔀 ブランチ
        </button>
        {diffTarget && (
          <button
            className={`view-tab${view === 'diff' ? ' active' : ''}`}
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
              className="view-tab-close"
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
      <PanelGroup direction="horizontal" className="main-split">
        <Panel defaultSize={18} minSize={12} maxSize={40}>
          <Sidebar />
        </Panel>
        <PanelResizeHandle className="resize-handle" />
        <Panel>
          <div className="main-area">
            <div className={`main-view${view === 'files' ? '' : ' hidden'}`}>
              <FileList />
            </div>
            <div className={`main-view${view === 'editor' ? '' : ' hidden'}`}>
              {tabs.length > 0 && <EditorPane />}
            </div>
            <div className={`main-view${isGitView(view) ? '' : ' hidden'}`}>
              {/* コミット/ログ/ブランチ間の切替では GitPanel をアンマウントせず状態を保つ */}
              {isGitView(view) && (
                <GitPanel tab={view === 'commit' ? 'changes' : view === 'log' ? 'log' : 'branches'} />
              )}
            </div>
            <div className={`main-view${view === 'diff' ? '' : ' hidden'}`}>
              {view === 'diff' && <DiffTab />}
            </div>
          </div>
        </Panel>
      </PanelGroup>
      <StatusBar />
      <ContextMenuHost />
      <DialogHost />
      <ToastHost />
      <SettingsDialog />
      <CloneDialog />
      <ConflictResolver />
      <PushDialog />
      <GitCommandDialog />
    </div>
  );
}
