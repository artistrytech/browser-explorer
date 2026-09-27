import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useExplorer } from '../stores/explorer';
import { useSettings } from '../stores/settings';
import { useGit } from '../stores/git';
import { useReview } from '../stores/review';
import { pushReviewView, switchView, useUi, type MainView } from '../stores/ui';
import { useContextMenu } from '../components/ContextMenu';
import { baseName } from '../lib/paths';
import { unpinFolder } from '../lib/quickaccessOps';
import { loadCollapsedSections, saveCollapsedSections } from '../lib/sidebarMemory';
import { Chevron, FolderTree } from './FolderTree';
import type { VolumeInfo } from '../types';
import styles from './Sidebar.module.scss';
import { createCssModuleClassNames } from '../lib/cssModule';

const cx = createCssModuleClassNames(styles);

/** リポジトリ選択時にそのまま保持する最上位タブ。それ以外 (エディタ等) は「ファイル」へ移る */
const REPO_KEEP_VIEWS: readonly MainView[] = ['files', 'commit', 'log', 'branches', 'review'];

export function Sidebar() {
  const { path, navigate } = useExplorer();
  const { favorites, repositories, setRepositories } = useSettings();
  const repoRoot = useGit((s) => s.repoRoot);
  const status = useGit((s) => s.status);
  const openMenu = useContextMenu((s) => s.open);
  const [volumes, setVolumes] = useState<VolumeInfo[]>([]);
  const [home, setHome] = useState<string>('');
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsedSections);

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
   * 通常は「ファイル」タブで開く。keepView を指定すると、現在のタブが REPO_KEEP_VIEWS なら保持する
   * (navigate はビューを files に戻すので、完了後に元のタブへ切り替え直す)。
   */
  const go = (e: React.MouseEvent, target: string, keepView = false) => {
    const current = useUi.getState().view;
    const view: MainView = keepView && REPO_KEEP_VIEWS.includes(current) ? current : 'files';
    if (e.ctrlKey || e.metaKey) {
      const params = new URLSearchParams();
      params.set('path', target);
      if (view !== 'files') params.set('view', view);
      window.open(`${location.pathname}?${params}`, '_blank');
      return;
    }
    const sameRepo = repoRoot === target;
    void navigate(target).then(() => {
      if (view === 'review') {
        // 同じリポジトリなら開いていたレビュー詳細を URL ごと保持、別リポジトリなら一覧へ
        const { currentId, currentFile } = useReview.getState();
        pushReviewView(sameRepo ? currentId : null, sameRepo ? currentFile : null);
      } else {
        switchView(view);
      }
    });
  };

  const toggleSection = (id: string) => {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setCollapsed(next);
    saveCollapsedSections(next);
  };

  /** 折り畳み可能なルート項目の見出し */
  const heading = (id: string, label: string) => (
    <button
      className={cx('side-heading')}
      aria-expanded={!collapsed.has(id)}
      onClick={() => toggleSection(id)}
    >
      <span className={cx('side-chevron')}>
        <Chevron open={!collapsed.has(id)} />
      </span>
      {label}
    </button>
  );

  const item = (
    key: string,
    label: string,
    icon: string,
    target: string,
    onContext?: (e: React.MouseEvent) => void,
  ) => (
    <button
      key={key}
      className={cx(`side-item${path === target ? ' active' : ''}`)}
      onClick={(e) => go(e, target)}
      onContextMenu={(e) => {
        if (onContext) {
          e.preventDefault();
          onContext(e);
        }
      }}
      title={`${target}\n(Ctrl+クリックで別タブ)`}
    >
      <span className={cx("side-icon")}>{icon}</span>
      <span className={cx("side-label")}>{label}</span>
    </button>
  );

  return (
    <div className={cx("sidebar")}>
      <div className={cx(`side-section limited${collapsed.has('quick') ? ' collapsed' : ''}`)}>
        {heading('quick', 'クイックアクセス')}
        {!collapsed.has('quick') && (
          <div className={cx("side-body")}>
            {home && item('home', 'Home', '🏠', home)}
            {favorites.map((f) => (
              // ピン項目: ホバーで ✕ を表示。解除は確認ダイアログ必須 (002.md §7.3)
              <div key={f.path} className={cx("side-item-wrap")}>
                <button
                  className={cx(`side-item${path === f.path ? ' active' : ''}`)}
                  onClick={(e) => go(e, f.path)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    openMenu(e.clientX, e.clientY, [
                      { label: 'ピン止めを解除', action: () => void unpinFolder(f.path, f.label) },
                    ]);
                  }}
                  title={`${f.path}\n(Ctrl+クリックで別タブ)`}
                >
                  <span className={cx("side-icon")}>★</span>
                  <span className={cx("side-label")}>{f.label}</span>
                </button>
                <button
                  className={cx("side-unpin")}
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
        )}
      </div>

      <div className={cx(`side-section limited${collapsed.has('repos') ? ' collapsed' : ''}`)}>
        {heading('repos', 'リポジトリ')}
        {!collapsed.has('repos') && (
          <div className={cx("side-body")}>
            {repositories.map((r) => (
              <button
                key={r}
                className={cx(`side-item${repoRoot === r ? ' active' : ''}`)}
                title={`${r}\n(Ctrl+クリックで別タブ)`}
                onClick={(e) => go(e, r, true)}
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
                <span className={cx("side-icon")}>●</span>
                <span className={cx("side-label")}>
                  {baseName(r)}
                  {repoRoot === r && status?.branch ? ` (${status.branch})` : ''}
                </span>
              </button>
            ))}
            {repositories.length === 0 && <div className={cx("side-empty")}>(未登録)</div>}
          </div>
        )}
      </div>

      <div className={cx(`side-section fill${collapsed.has('places') ? ' collapsed' : ''}`)}>
        {heading('places', '場所')}
        {!collapsed.has('places') && (
          <div className={cx("side-body")}>
            <FolderTree volumes={volumes} onOpen={(e, p) => go(e, p)} />
          </div>
        )}
      </div>
    </div>
  );
}
