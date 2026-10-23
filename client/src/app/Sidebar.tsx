import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api/client';
import { useExplorer } from '../stores/explorer';
import { useSettings } from '../stores/settings';
import { useGit } from '../stores/git';
import { useContextMenu, type MenuItem } from '../components/ContextMenu';
import { baseName } from '../lib/paths';
import { renameRepository, unpinFolder, unregisterRepository } from '../lib/quickaccessOps';
import {
  loadCollapsedSections,
  loadSidebarMode,
  saveCollapsedSections,
  saveSidebarMode,
  type SidebarMode,
} from '../lib/sidebarMemory';
import { Chevron, FolderTree } from './FolderTree';
import { ProjectTree } from './ProjectTree';
import type { VolumeInfo } from '../types';
import { middleClickProps, wantsNewTab } from '../lib/appTabs';
import { openLocation } from '../lib/openLocation';
import { repoBadgeOf } from '../lib/repoGroups';
import { moveItem } from '../lib/moveItem';
import { openRepoGroupsDialog } from './RepoGroupsDialog';
import styles from './Sidebar.module.scss';
import { createCssModuleClassNames } from '../lib/cssModule';

const cx = createCssModuleClassNames(styles);

/** 編集ペン (右上から左下へ、ペン先が左下)。文字の ✎ はフォントで向きや形が変わるので SVG で描く */
function PencilIcon() {
  return (
    <svg className={cx('pencil-icon')} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M11.3 2a1.9 1.9 0 1 1 2.7 2.7L5 13.7 1.3 14.7l1-3.7z" />
      <line x1="9.8" y1="3.5" x2="12.5" y2="6.2" />
    </svg>
  );
}

/** グループ分けのボタンの図案 (荷札) */
function TagIcon() {
  return (
    <svg className={cx('heading-action-icon')} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8.6 1.8H14.2v5.6L7.4 14.2a1.2 1.2 0 0 1-1.7 0L1.8 10.3a1.2 1.2 0 0 1 0-1.7z" />
      <circle cx="11.3" cy="4.7" r="1.1" />
    </svg>
  );
}

/** プロジェクトツリーへの切り替えボタンの図案 (親フォルダから子が枝分かれする形) */
function ProjectTreeIcon() {
  return (
    <svg className={cx('mode-toggle-icon')} viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.5" y="1.5" width="5" height="3.5" rx="0.8" />
      <rect x="8.5" y="6.5" width="6" height="3.5" rx="0.8" />
      <rect x="8.5" y="11.5" width="6" height="3.5" rx="0.8" />
      <path d="M4 5v8.25h4.5M4 8.25h4.5" />
    </svg>
  );
}

/** 並び替えできるセクション */
type ReorderSection = 'quick' | 'repos';

/** サイドバー内の並び替えドラッグ。ファイルの D&D (application/x-entries) と区別する */
const REORDER_MIME = 'application/x-sidebar-reorder';

/** 並び替えを確定する。クイックアクセスは専用 API、リポジトリは状態保存で永続化する */
function applyReorder(section: ReorderSection, from: number, to: number): void {
  const s = useSettings.getState();
  if (section === 'quick') s.setFavorites(moveItem(s.favorites, from, to));
  else s.setRepositories(moveItem(s.repositories, from, to));
}

export function Sidebar() {
  const path = useExplorer((s) => s.path);
  const { favorites, repositories, repoGroups, settings: { repoLabels } } = useSettings();
  const repoRoot = useGit((s) => s.repoRoot);
  const status = useGit((s) => s.status);
  const openMenu = useContextMenu((s) => s.open);
  const [volumes, setVolumes] = useState<VolumeInfo[]>([]);
  const [home, setHome] = useState<string>('');
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsedSections);
  const [mode, setMode] = useState<SidebarMode>(loadSidebarMode);
  /** ドラッグ中の項目と、ドロップ先の挿入位置 (元の並びでの隙間 0..length) */
  const [drag, setDrag] = useState<{ section: ReorderSection; from: number } | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);

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
   * サイドバーのリンク遷移。Ctrl (mac は ⌘) + クリック / 中クリックは別タブで開く。
   * keepView はリポジトリ用 (現在のタブを保持する。lib/openLocation.ts)
   */
  const go = (e: React.MouseEvent, target: string, keepView = false) =>
    openLocation(target, { keepView, newTab: wantsNewTab(e) });

  /** プロジェクトツリーはリポジトリ内でだけ出す。リポジトリ外では選択を保ったまま通常の表示にする */
  const showProject = repoRoot !== null && mode === 'project';

  const toggleMode = () => {
    const next: SidebarMode = mode === 'project' ? 'places' : 'project';
    setMode(next);
    saveSidebarMode(next);
  };

  const toggleSection = (id: string) => {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setCollapsed(next);
    saveCollapsedSections(next);
  };

  /** 折り畳み可能なルート項目の見出し。action は見出しの行の右端に並べるボタン */
  const heading = (id: string, label: string, action?: ReactNode) => {
    const button = (
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
    if (!action) return button;
    return (
      <div className={cx('side-heading-row')}>
        {button}
        {action}
      </div>
    );
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
      className={cx(`side-item${path === target ? ' active' : ''}`)}
      onClick={(e) => go(e, target)}
      {...middleClickProps((e) => go(e, target))}
      onContextMenu={(e) => {
        if (onContext) {
          e.preventDefault();
          onContext(e);
        }
      }}
      title={`${target}\n(Ctrl+クリック / 中クリックで別タブ)`}
    >
      <span className={cx("side-icon")}>{icon}</span>
      <span className={cx("side-label")}>{label}</span>
    </button>
  );

  const endDrag = () => {
    setDrag(null);
    setDropAt(null);
  };

  /** 並び替え対象の行 (side-item-wrap) に付けるドラッグ属性。同じセクション内でだけ受け付ける */
  const reorderProps = (section: ReorderSection, index: number) => {
    /** マウス位置が行の上半分なら前、下半分なら後ろの隙間 */
    const gapAt = (e: React.DragEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      return e.clientY < rect.top + rect.height / 2 ? index : index + 1;
    };
    return {
      draggable: true,
      onDragStart: (e: React.DragEvent<HTMLDivElement>) => {
        e.dataTransfer.setData(REORDER_MIME, section);
        e.dataTransfer.effectAllowed = 'move';
        setDrag({ section, from: index });
      },
      onDragOver: (e: React.DragEvent<HTMLDivElement>) => {
        if (drag?.section !== section) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const gap = gapAt(e);
        // 元の位置の前後の隙間は並びが変わらないので印を出さない
        setDropAt(gap === drag.from || gap === drag.from + 1 ? null : gap);
      },
      onDrop: (e: React.DragEvent<HTMLDivElement>) => {
        if (drag?.section !== section) return;
        e.preventDefault();
        const gap = gapAt(e);
        if (gap !== drag.from && gap !== drag.from + 1) applyReorder(section, drag.from, gap);
        endDrag();
      },
      onDragEnd: endDrag,
    };
  };

  /** ドロップ位置の印 (行の上端 / 下端の線) */
  const dropMark = (section: ReorderSection, index: number) => {
    if (drag?.section !== section || dropAt === null) return '';
    if (dropAt === index) return ' drop-before';
    if (dropAt === index + 1) return ' drop-after';
    return '';
  };

  /** 右クリックメニューの「上へ移動 / 下へ移動」 */
  const moveMenu = (section: ReorderSection, index: number, count: number): MenuItem[] => [
    { label: '上へ移動', disabled: index === 0, action: () => applyReorder(section, index, index - 1) },
    {
      label: '下へ移動',
      disabled: index === count - 1,
      action: () => applyReorder(section, index, index + 2),
    },
    { separator: true },
  ];

  const modeToggle = repoRoot !== null && (
    <button
      className={cx(`mode-toggle${showProject ? ' on' : ''}`)}
      aria-pressed={showProject}
      title={showProject ? '通常の表示に戻す' : 'プロジェクトツリーを表示'}
      onClick={toggleMode}
    >
      <ProjectTreeIcon />
    </button>
  );

  if (showProject) {
    return (
      <div className={cx('sidebar')}>
        {modeToggle}
        <ProjectTree key={repoRoot} repoRoot={repoRoot} />
      </div>
    );
  }

  return (
    <div className={cx("sidebar")}>
      {modeToggle}
      <div className={cx(`side-section limited${collapsed.has('quick') ? ' collapsed' : ''}`)}>
        {heading('quick', 'クイックアクセス')}
        {!collapsed.has('quick') && (
          <div className={cx("side-body")}>
            {home && item('home', 'Home', '🏠', home)}
            {favorites.map((f, i) => (
              // ピン項目: ホバーで ✕ を表示。解除は確認ダイアログ必須 (002.md §7.3)。ドラッグで並び替え
              <div
                key={f.path}
                className={cx(`side-item-wrap${dropMark('quick', i)}`)}
                {...reorderProps('quick', i)}
              >
                <button
                  className={cx(`side-item${path === f.path ? ' active' : ''}`)}
                  onClick={(e) => go(e, f.path)}
                  {...middleClickProps((e) => go(e, f.path))}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    openMenu(e.clientX, e.clientY, [
                      ...moveMenu('quick', i, favorites.length),
                      { label: 'ピン止めを解除', action: () => void unpinFolder(f.path, f.label) },
                    ]);
                  }}
                  title={`${f.path}\n(Ctrl+クリック / 中クリックで別タブ)`}
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
        {heading(
          'repos',
          'リポジトリ',
          <button className={cx('heading-action')} title="グループ分け…" onClick={openRepoGroupsDialog}>
            <TagIcon />
          </button>,
        )}
        {!collapsed.has('repos') && (
          <div className={cx("side-body")}>
            {repositories.map((r, i) => {
              const label = repoLabels[r] || baseName(r);
              const badge = repoBadgeOf(repoGroups, r);
              return (
                // ホバー / フォーカスで ✎ (表示名の変更) と ✕ (登録解除) を表示する。ドラッグで並び替え
                <div
                  key={r}
                  className={cx(`side-item-wrap two-actions${dropMark('repos', i)}`)}
                  {...reorderProps('repos', i)}
                >
                  <button
                    className={cx(`side-item${repoRoot === r ? ' active' : ''}`)}
                    title={`${r}\n(Ctrl+クリック / 中クリックで別タブ)`}
                    onClick={(e) => go(e, r, true)}
                    {...middleClickProps((e) => go(e, r, true))}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      openMenu(e.clientX, e.clientY, [
                        ...moveMenu('repos', i, repositories.length),
                        { label: '表示名を変更…', action: () => void renameRepository(r) },
                        { label: 'グループ分け…', action: openRepoGroupsDialog },
                        {
                          label: '一覧から削除',
                          action: () => void unregisterRepository(r, label),
                        },
                      ]);
                    }}
                  >
                    {/* グループに入れたリポジトリは ● をグループの色にする */}
                    <span className={cx("side-icon")} style={badge ? { color: badge.color } : undefined}>
                      ●
                    </span>
                    <span className={cx("side-label")}>
                      {label}
                      {repoRoot === r && status?.branch ? ` (${status.branch})` : ''}
                    </span>
                  </button>
                  <button
                    className={cx("side-rename")}
                    title="表示名を変更"
                    onClick={(e) => {
                      e.stopPropagation();
                      void renameRepository(r);
                    }}
                  >
                    <PencilIcon />
                  </button>
                  <button
                    className={cx("side-unpin")}
                    title="一覧から削除"
                    onClick={(e) => {
                      e.stopPropagation();
                      void unregisterRepository(r, label);
                    }}
                  >
                    ✕
                  </button>
                </div>
              );
            })}
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
