import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useExplorer } from '../stores/explorer';
import { useSettings } from '../stores/settings';
import { useGit } from '../stores/git';
import { useUi } from '../stores/ui';
import { useContextMenu } from '../components/ContextMenu';
import { baseName } from '../lib/paths';
import type { VolumeInfo } from '../types';

export function Sidebar() {
  const { path, navigate } = useExplorer();
  const { favorites, repositories, removeFavorite, setRepositories } = useSettings();
  const repoRoot = useGit((s) => s.repoRoot);
  const status = useGit((s) => s.status);
  const setView = useUi((s) => s.setView);
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
      onClick={() => void navigate(target)}
      onContextMenu={(e) => {
        if (onContext) {
          e.preventDefault();
          onContext(e);
        }
      }}
      title={target}
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
        {favorites.map((f) =>
          item(f.path, f.label, '★', f.path, (e) => {
            openMenu(e.clientX, e.clientY, [
              { label: 'ピン留めを外す', action: () => removeFavorite(f.path) },
            ]);
          }),
        )}
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
            title={r}
            onClick={() => {
              void navigate(r).then(() => setView('git'));
            }}
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
