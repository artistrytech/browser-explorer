import { useEffect, useRef } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { Toolbar } from './app/Toolbar';
import { Sidebar } from './app/Sidebar';
import { StatusBar } from './app/StatusBar';
import { SettingsDialog } from './app/SettingsDialog';
import { FileList } from './features/explorer/FileList';
import { EditorPane } from './features/editor/EditorPane';
import { GitPanel } from './features/git/GitPanel';
import { ContextMenuHost } from './components/ContextMenu';
import { DialogHost } from './components/DialogHost';
import { ToastHost } from './components/ToastHost';
import { useExplorer, pathFromUrl } from './stores/explorer';
import { useEditor } from './stores/editor';
import { useGit } from './stores/git';
import { useSettings } from './stores/settings';
import { useUi } from './stores/ui';
import { onFsChange } from './api/ws';
import { parentPath, isRootPath } from './lib/paths';

export default function App() {
  const path = useExplorer((s) => s.path);
  const navigate = useExplorer((s) => s.navigate);
  const tabs = useEditor((s) => s.tabs);
  const { view, setView } = useUi();
  const theme = useSettings((s) => s.settings.theme);
  const loaded = useSettings((s) => s.loaded);
  const refreshTimer = useRef<ReturnType<typeof setTimeout>>();

  // 初期化: 設定ロード → URL のパスを表示 (plan §6.5)
  useEffect(() => {
    void useSettings.getState().load();
    const initial = pathFromUrl();
    history.replaceState({ path: initial }, '', `${location.pathname}?path=${encodeURIComponent(initial)}`);
    void navigate(initial, false);

    const onPop = () => void useExplorer.getState().navigate(pathFromUrl(), false);
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

  // エディタタブが無くなったら files へ
  useEffect(() => {
    if (view === 'editor' && tabs.length === 0) setView('files');
  }, [view, tabs.length, setView]);

  return (
    <div className="app">
      <Toolbar />
      <div className="view-tabs">
        <button className={`view-tab${view === 'files' ? ' active' : ''}`} onClick={() => setView('files')}>
          📁 ファイル
        </button>
        {tabs.length > 0 && (
          <button className={`view-tab${view === 'editor' ? ' active' : ''}`} onClick={() => setView('editor')}>
            📝 エディタ ({tabs.length})
          </button>
        )}
        <button className={`view-tab${view === 'git' ? ' active' : ''}`} onClick={() => setView('git')}>
          🌿 Git
        </button>
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
            <div className={`main-view${view === 'git' ? '' : ' hidden'}`}>
              {view === 'git' && <GitPanel />}
            </div>
          </div>
        </Panel>
      </PanelGroup>
      <StatusBar />
      <ContextMenuHost />
      <DialogHost />
      <ToastHost />
      <SettingsDialog />
    </div>
  );
}
