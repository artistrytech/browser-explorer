import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useExplorer } from '../stores/explorer';
import { useSettings } from '../stores/settings';
import { breadcrumbs } from '../lib/paths';
import type { FsEntry, VolumeInfo } from '../types';
import styles from './Sidebar.module.scss';
import { createCssModuleClassNames } from '../lib/cssModule';

const cx = createCssModuleClassNames(styles);

/** 折り畳みアイコン (「く」の字)。閉じているときは右向き、開いているときは下向き */
export function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={cx(`chevron-icon${open ? ' open' : ''}`)} viewBox="0 0 16 16" aria-hidden="true">
      <polyline points="6,3 11,8 6,13" />
    </svg>
  );
}

/** 子フォルダの読み込み状態。未読み込みはキー自体が無い */
type Children = FsEntry[] | 'loading' | 'error';

/** Windows のドライブパスは大文字小文字を区別しない */
function samePath(a: string, b: string): boolean {
  return /^[A-Za-z]:/.test(a) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** p が root 自身またはその配下か */
function isUnder(p: string, root: string): boolean {
  if (samePath(p, root)) return true;
  const prefix = root.endsWith('/') ? root : `${root}/`;
  return /^[A-Za-z]:/.test(p) ? p.toLowerCase().startsWith(prefix.toLowerCase()) : p.startsWith(prefix);
}

function sortDirs(entries: FsEntry[]): FsEntry[] {
  // シンボリックリンク (Windows のジャンクション含む) は辿らない
  return entries.filter((e) => e.type === 'dir').sort((a, b) => a.name.localeCompare(b.name, 'ja'));
}

/**
 * 「場所」配下のフォルダツリー (Windows エクスプローラのナビゲーション ウィンドウ相当)。
 * - 「>」で子フォルダを遅延読み込みして展開、項目クリックでそのフォルダへ移動
 * - 現在のフォルダの祖先は自動で展開し、現在のフォルダを見える位置へスクロールする
 */
export function FolderTree({
  volumes,
  onOpen,
}: {
  volumes: VolumeInfo[];
  onOpen: (e: React.MouseEvent, path: string) => void;
}) {
  const path = useExplorer((s) => s.path);
  const entries = useExplorer((s) => s.entries);
  const showHidden = useSettings((s) => s.settings.showHidden);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [children, setChildren] = useState<Record<string, Children>>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const pendingScroll = useRef(true);
  // マウント時点の一覧は移動完了前 (空) のことがあるので同期に使わない
  const initialEntries = useRef(entries);

  /** 子フォルダを取得する。読み込み済みなら表示はそのまま裏で取り直す */
  const load = useCallback((dir: string) => {
    setChildren((c) => (Array.isArray(c[dir]) ? c : { ...c, [dir]: 'loading' }));
    api
      .list(dir)
      .then((r) => setChildren((c) => ({ ...c, [dir]: sortDirs(r.entries) })))
      .catch(() => setChildren((c) => (Array.isArray(c[dir]) ? c : { ...c, [dir]: 'error' })));
  }, []);

  const toggle = (dir: string) => {
    const open = !expanded.has(dir);
    setExpanded((s) => {
      const next = new Set(s);
      if (open) next.add(dir);
      else next.delete(dir);
      return next;
    });
    if (open) load(dir);
  };

  // 現在のフォルダの祖先 (所属する場所から親まで) を展開する
  useEffect(() => {
    const volume = volumes
      .filter((v) => isUnder(path, v.path))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (!volume) return;
    const ancestors = breadcrumbs(path)
      .map((b) => b.path)
      .filter((p) => isUnder(p, volume.path) && !samePath(p, path));
    pendingScroll.current = true;
    if (ancestors.length === 0) return;
    setExpanded((s) => {
      const add = ancestors.filter((p) => !s.has(p));
      return add.length === 0 ? s : new Set([...s, ...add]);
    });
    for (const p of ancestors) if (!Array.isArray(children[p])) load(p);
    // children は読み込み済み判定のみに使う (変化のたびに走らせない)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, volumes, load]);

  // 一覧で開いているフォルダの子は一覧の内容で置き換える (作成・リネーム等をツリーへ反映)
  useEffect(() => {
    if (entries === initialEntries.current) return;
    setChildren((c) => ({ ...c, [path]: sortDirs(entries) }));
  }, [path, entries]);

  // 移動後、現在のフォルダの項目が描画されたら見える位置へスクロールする
  useEffect(() => {
    if (!pendingScroll.current) return;
    const el = rootRef.current?.querySelector('[data-tree-active="true"]');
    if (!el) return;
    pendingScroll.current = false;
    el.scrollIntoView({ block: 'nearest' });
  });

  const renderNode = (nodePath: string, label: string, icon: string, depth: number): React.ReactNode => {
    const isOpen = expanded.has(nodePath);
    const kids = children[nodePath];
    const visible = Array.isArray(kids) ? kids.filter((e) => showHidden || !e.hidden) : null;
    // 読み込み済みで子フォルダが無ければ「>」を出さない
    const leaf = visible !== null && visible.length === 0;
    const active = samePath(path, nodePath);
    return (
      <div key={nodePath} role="treeitem" aria-expanded={leaf ? undefined : isOpen}>
        <button
          className={cx(`side-item tree-item${active ? ' active' : ''}`)}
          style={{ paddingLeft: 4 + depth * 14 }}
          data-tree-active={active}
          onClick={(e) => onOpen(e, nodePath)}
          title={`${nodePath}\n(Ctrl+クリックで別タブ)`}
        >
          <span
            className={cx(`tree-twisty${leaf ? ' leaf' : ''}`)}
            onClick={(e) => {
              e.stopPropagation();
              if (!leaf) toggle(nodePath);
            }}
          >
            <Chevron open={isOpen} />
          </span>
          <span className={cx('side-icon')}>{icon}</span>
          <span className={cx('side-label')}>{label}</span>
        </button>
        {isOpen && !leaf && (
          <div role="group">
            {kids === 'loading' || kids === undefined ? (
              <div className={cx('tree-note')} style={{ paddingLeft: 4 + (depth + 1) * 14 + 20 }}>
                読み込み中…
              </div>
            ) : kids === 'error' ? (
              <div className={cx('tree-note')} style={{ paddingLeft: 4 + (depth + 1) * 14 + 20 }}>
                (開けません)
              </div>
            ) : (
              visible!.map((e) => renderNode(e.path, e.name, '📁', depth + 1))
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div ref={rootRef} role="tree">
      {volumes.map((v) => renderNode(v.path, v.name, '💽', 0))}
    </div>
  );
}
