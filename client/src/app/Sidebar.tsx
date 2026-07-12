import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useExplorer } from '../stores/explorer';
import { useSettings } from '../stores/settings';
import { useGit } from '../stores/git';
import { switchView } from '../stores/ui';
import { useContextMenu } from '../components/ContextMenu';
import { baseName } from '../lib/paths';
import { unpinFolder } from '../lib/quickaccessOps';
import type { VolumeInfo } from '../types';

export function Sidebar() {
  const { path, navigate } = useExplorer();
  const { favorites, repositories, setRepositories } = useSettings();
  const repoRoot = useGit((s) => s.repoRoot);
  const status = useGit((s) => s.status);
  const openMenu = useContextMenu((s) => s.open);
  const [volumes, setVolumes] = useState<VolumeInfo[]>([]);
  const [home, setHome] = useState<string>('');

  useEffect(() => {
    api
      .volumes()
      .then((r) => {
        setVolumes(r.volumes);
        setHome(r.home);
      })
      .catch(() => {});
  }, []);

  /**
   * サイドバーのリンク遷移。Ctrl (mac は ⌘) + クリックはブラウザの別タブで開く。
   * view を指定するとその最上位タブ (リポジトリなら commit) で開く。
   */
  const go = (e: React.MouseEvent, target: string, view?: 'commit') => {
    if (e.ctrlKey || e.metaKey) {
      const params = new URLSearchParams();
      params.set('path', target);
      if (view) params.set('view', view);
      window.open(`${location.pathname}?${params}`, '_blank');
      return;
    }
    const p = navigate(target);
    if (view) void p.then(() => switchView(view));
    else void p;
  };

  const item = (
    key: string,
    label: string,
    icon: string,
    target: string,
    onContext?: (e: React.MouseEvent) => void,
  ) => (
    <button
      key={key}
      className={`side-item${path === target ? ' active' : ''}`}
      onClick={(e) => go(e, target)}
      onContextMenu={(e) => {
        if (onContext) {
          e.preventDefault();
          onContext(e);
        }
      }}
      title={`${target}\n(Ctrl+クリックで別タブ)`}
    >
      <span className="side-icon">{icon}</span>
      <span className="side-label">{label}</span>
    </button>
  );

  return (
    <div className="sidebar">
      <div className="side-section">
        <div className="side-heading">クイックアクセス</div>
        {home && item('home', 'Home', '🏠', home)}
        {favorites.map((f) => (
          // ピン項目: ホバーで ✕ を表示。解除は確認ダイアログ必須 (002.md §7.3)
          <div key={f.path} className="side-item-wrap">
            <button
              className={`side-item${path === f.path ? ' active' : ''}`}
              onClick={(e) => go(e, f.path)}
              onContextMenu={(e) => {
                e.preventDefault();
                openMenu(e.clientX, e.clientY, [
                  { label: 'ピン止めを解除', action: () => void unpinFolder(f.path, f.label) },
                ]);
              }}
              title={`${f.path}\n(Ctrl+クリックで別タブ)`}
            >
              <span className="side-icon">★</span>
              <span className="side-label">{f.label}</span>
            </button>
            <button
              className="side-unpin"
              title="ピン止めを解除"
              onClick={(e) => {
                e.stopPropagation();
                void unpinFolder(f.path, f.label);
              }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      <div className="side-section">
        <div className="side-heading">場所</div>
        {volumes.map((v) => item(v.path, v.name, '💽', v.path))}
      </div>

      <div className="side-section">
        <div className="side-heading">リポジトリ</div>
        {repositories.map((r) => (
          <button
            key={r}
            className={`side-item${repoRoot === r ? ' active' : ''}`}
            title={`${r}\n(Ctrl+クリックで別タブ)`}
            onClick={(e) => go(e, r, 'commit')}
            onContextMenu={(e) => {
              e.preventDefault();
              openMenu(e.clientX, e.clientY, [
                {
                  label: '一覧から削除',
                  action: () => setRepositories(repositories.filter((p) => p !== r)),
                },
              ]);
            }}
          >
            <span className="side-icon">●</span>
            <span className="side-label">
              {baseName(r)}
              {repoRoot === r && status?.branch ? ` (${status.branch})` : ''}
            </span>
          </button>
        ))}
        {repositories.length === 0 && <div className="side-empty">(未登録)</div>}
      </div>
    </div>
  );
}
