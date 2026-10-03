import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useExplorer } from '../stores/explorer';
import { useSettings } from '../stores/settings';
import { useGit } from '../stores/git';
import { useReview } from '../stores/review';
import { pushReviewView, switchView, useUi, type MainView } from '../stores/ui';
import { useContextMenu, type MenuItem } from '../components/ContextMenu';
import { baseName } from '../lib/paths';
import { renameRepository, unpinFolder, unregisterRepository } from '../lib/quickaccessOps';
import { loadCollapsedSections, saveCollapsedSections } from '../lib/sidebarMemory';
import { Chevron, FolderTree } from './FolderTree';
import type { VolumeInfo } from '../types';
import styles from './Sidebar.module.scss';
import { createCssModuleClassNames } from '../lib/cssModule';

const cx = createCssModuleClassNames(styles);

/** リポジトリ選択時にそのまま保持する最上位タブ。それ以外 (エディタ等) は「ファイル」へ移る */
const REPO_KEEP_VIEWS: readonly MainView[] = ['files', 'commit', 'log', 'branches', 'review'];

/** 編集ペン (右上から左下へ、ペン先が左下)。文字の ✎ はフォントで向きや形が変わるので SVG で描く */
function PencilIcon() {
  return (
    <svg className={cx('pencil-icon')} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M11.3 2a1.9 1.9 0 1 1 2.7 2.7L5 13.7 1.3 14.7l1-3.7z" />
      <line x1="9.8" y1="3.5" x2="12.5" y2="6.2" />
    </svg>
  );
}

/** 並び替えできるセクション */
type ReorderSection = 'quick' | 'repos';

/** サイドバー内の並び替えドラッグ。ファイルの D&D (application/x-entries) と区別する */
const REORDER_MIME = 'application/x-sidebar-reorder';

/** from 番目の要素を挿入位置 to (0..length、元の並びでの隙間) へ移す */
function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to > from ? to - 1 : to, 0, item);
  return next;
}

/** 並び替えを確定する。クイックアクセスは専用 API、リポジトリは状態保存で永続化する */
function applyReorder(section: ReorderSection, from: number, to: number): void {
  const s = useSettings.getState();
  if (section === 'quick') s.setFavorites(moveItem(s.favorites, from, to));
  else s.setRepositories(moveItem(s.repositories, from, to));
}

export function Sidebar() {
  const { path, navigate } = useExplorer();
  const { favorites, repositories, settings: { repoLabels } } = useSettings();
  const repoRoot = useGit((s) => s.repoRoot);
  const status = useGit((s) => s.status);
  const openMenu = useContextMenu((s) => s.open);
  const [volumes, setVolumes] = useState<VolumeInfo[]>([]);
  const [home, setHome] = useState<string>('');
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsedSections);
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

  return (
    <div className={cx("sidebar")}>
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
                  onContextMenu={(e) => {
                    e.preventDefault();
                    openMenu(e.clientX, e.clientY, [
                      ...moveMenu('quick', i, favorites.length),
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
            {repositories.map((r, i) => {
              const label = repoLabels[r] || baseName(r);
              return (
                // ホバー / フォーカスで ✎ (表示名の変更) と ✕ (登録解除) を表示する。ドラッグで並び替え
                <div
                  key={r}
                  className={cx(`side-item-wrap two-actions${dropMark('repos', i)}`)}
                  {...reorderProps('repos', i)}
                >
                  <button
                    className={cx(`side-item${repoRoot === r ? ' active' : ''}`)}
                    title={`${r}\n(Ctrl+クリックで別タブ)`}
                    onClick={(e) => go(e, r, true)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      openMenu(e.clientX, e.clientY, [
                        ...moveMenu('repos', i, repositories.length),
                        { label: '表示名を変更…', action: () => void renameRepository(r) },
                        {
                          label: '一覧から削除',
                          action: () => void unregisterRepository(r, label),
                        },
                      ]);
                    }}
                  >
                    <span className={cx("side-icon")}>●</span>
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
