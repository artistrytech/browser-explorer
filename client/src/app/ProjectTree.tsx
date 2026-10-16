import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import { useExplorer } from '../stores/explorer';
import { useEditor } from '../stores/editor';
import { useGit, type OverlayCode } from '../stores/git';
import { useSettings } from '../stores/settings';
import { useUi } from '../stores/ui';
import { usePreviewTab } from '../features/preview/MarkdownTab';
import { openWithDefault } from '../lib/fileOps';
import { sortEntries } from '../lib/entrySort';
import { baseName, fileIcon } from '../lib/paths';
import { loadProjectExpanded, saveProjectExpanded } from '../lib/sidebarMemory';
import { GitOverlay } from '../components/GitOverlay';
import { Chevron } from './FolderTree';
import type { FsEntry } from '../types';
import styles from './Sidebar.module.scss';
import { createCssModuleClassNames } from '../lib/cssModule';

const cx = createCssModuleClassNames(styles);

/** 子要素の読み込み状態。未読み込みはキー自体が無い */
type Children = FsEntry[] | 'loading' | 'error';

/** ツリーの 1 行 */
type Row =
  | { type: 'entry'; entry: FsEntry; rel: string; depth: number; dirCode?: OverlayCode }
  | { type: 'note'; key: string; text: string; depth: number };

/** abs が root 自身か配下ならリポジトリ相対パス、それ以外は null (Windows のドライブパスは大文字小文字を区別しない) */
function relOf(abs: string, root: string): string | null {
  const ci = /^[A-Za-z]:/.test(root);
  const a = ci ? abs.toLowerCase() : abs;
  const r = ci ? root.toLowerCase() : root;
  if (a === r) return '';
  const prefix = r.endsWith('/') ? r : `${r}/`;
  return a.startsWith(prefix) ? abs.slice(prefix.length) : null;
}

/** リポジトリ相対パスの祖先フォルダ (浅い順)。ルート ('') は含まない */
function ancestorsOf(rel: string): string[] {
  const parts = rel.split('/');
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
}

/** フォルダ直下の「無視 (.gitignore) / Git 管理外」の名前 */
interface DirStatus {
  ignored: Set<string>;
  untracked: Set<string>;
}

/** フォルダの親 (リポジトリ相対)。直下なら '' */
function parentRel(rel: string): string {
  return rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
}

/** すべて折りたたむ (VS Code の同名ボタンと同じ図案) */
function CollapseAllIcon() {
  return (
    <svg className={cx('project-action-icon')} viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
      <line x1="5.5" y1="8" x2="10.5" y2="8" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg className={cx('project-action-icon')} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M13 8a5 5 0 1 1-1.5-3.6" />
      <polyline points="12,1.8 12,4.6 9.2,4.6" />
    </svg>
  );
}

/**
 * プロジェクトツリー (VS Code のエクスプローラ相当)。リポジトリのルート配下のファイル / フォルダを表示する。
 * - フォルダのクリックは開閉のみ、ファイルのクリックでそのファイルを開く (一覧のダブルクリックと同じ既定の開き方)
 * - Git の状態はファイル一覧と同じマーク (✔ ● ＋ ？ ⚠ －) をアイコンの右下に重ねて表示する
 * - ↑↓ で選択の移動、→ / ← で展開 / 折り畳み (親へ移動)、Enter で開く
 */
export function ProjectTree({ repoRoot }: { repoRoot: string }) {
  const status = useGit((s) => s.status);
  const refreshStatus = useGit((s) => s.refreshStatus);
  const explorerPath = useExplorer((s) => s.path);
  const explorerEntries = useExplorer((s) => s.entries);
  const showHidden = useSettings((s) => s.settings.showHidden);
  const repoLabel = useSettings((s) => s.settings.repoLabels[repoRoot]);
  const view = useUi((s) => s.view);
  const editorPath = useEditor((s) => s.activePath);
  const previewPath = usePreviewTab((s) => s.current);

  const [expanded, setExpanded] = useState<Set<string>>(() => loadProjectExpanded(repoRoot));
  const [children, setChildren] = useState<Record<string, Children>>({});
  /** フォルダ (リポジトリ相対) → 直下の無視 / 管理外の判定 */
  const [dirStatus, setDirStatus] = useState<Record<string, DirStatus>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const pendingScroll = useRef(false);
  /** 無視 / 管理外の判定を取得済みの名前の並び (フォルダごと)。中身が変わらなければ取り直さない */
  const statusKey = useRef<Record<string, string>>({});
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  const absOf = useCallback(
    (rel: string) => (rel ? `${repoRoot.replace(/\/$/, '')}/${rel}` : repoRoot),
    [repoRoot],
  );

  /** 直下の無視 / 管理外の判定を取得する。名前の並びが前回と同じなら何もしない */
  const checkEntriesStatus = useCallback(
    (rel: string, entries: FsEntry[]) => {
      const names = entries.map((e) => e.name);
      const key = [...names].sort().join('/');
      if (statusKey.current[rel] === key) return;
      statusKey.current[rel] = key;
      api
        .gitEntriesStatus(repoRoot, rel, names)
        .then((r) =>
          setDirStatus((m) => ({ ...m, [rel]: { ignored: new Set(r.ignored), untracked: new Set(r.untracked) } })),
        )
        .catch(() => {
          delete statusKey.current[rel];
        });
    },
    [repoRoot],
  );

  /** フォルダの中身を取得する。読み込み済みなら表示はそのまま裏で取り直す */
  const load = useCallback(
    (rel: string) => {
      setChildren((c) => (Array.isArray(c[rel]) ? c : { ...c, [rel]: 'loading' }));
      api
        .list(absOf(rel))
        .then((r) => {
          const entries = r.entries.filter((e) => e.name !== '.git');
          setChildren((c) => ({ ...c, [rel]: entries }));
          checkEntriesStatus(rel, entries);
        })
        .catch(() => setChildren((c) => (Array.isArray(c[rel]) ? c : { ...c, [rel]: 'error' })));
    },
    [absOf, checkEntriesStatus],
  );

  /** ルートと展開中のフォルダをすべて取り直す */
  const reloadAll = useCallback(() => {
    load('');
    for (const rel of expandedRef.current) load(rel);
  }, [load]);

  useEffect(() => {
    reloadAll();
  }, [reloadAll]);

  useEffect(() => {
    saveProjectExpanded(repoRoot, expanded);
  }, [repoRoot, expanded]);

  // Git の状態が更新されたとき (フォーカス復帰・ファイル変更・Git 操作の後) に中身も取り直す。
  // ファイル変更の監視は表示中フォルダの直下だけなので、ツリー側はこの契機で追従する
  const statusSeen = useRef(status);
  useEffect(() => {
    if (statusSeen.current === status) return;
    statusSeen.current = status;
    reloadAll();
  }, [status, reloadAll]);

  // 一覧で開いているフォルダがリポジトリ内なら、その中身は一覧の内容で置き換える
  const initialEntries = useRef(explorerEntries);
  useEffect(() => {
    if (explorerEntries === initialEntries.current) return;
    const rel = relOf(explorerPath, repoRoot);
    if (rel === null) return;
    const entries = explorerEntries.filter((e) => e.name !== '.git');
    setChildren((c) => ({ ...c, [rel]: entries }));
    checkEntriesStatus(rel, entries);
  }, [explorerPath, explorerEntries, repoRoot, checkEntriesStatus]);

  /** rel の祖先を展開し、描画後に見える位置へスクロールする */
  const reveal = useCallback(
    (rel: string) => {
      const ancestors = ancestorsOf(rel);
      pendingScroll.current = true;
      const missing = ancestors.filter((p) => !expandedRef.current.has(p));
      if (missing.length === 0) return;
      setExpanded((s) => new Set([...s, ...missing]));
      for (const p of missing) load(p);
    },
    [load],
  );

  // エディタ / プレビューで表示中のファイルを選択状態にして、ツリー上で見える位置まで展開する
  const activeFile = view === 'editor' ? editorPath : view === 'preview' ? previewPath : null;
  useEffect(() => {
    if (!activeFile) return;
    const rel = relOf(activeFile, repoRoot);
    if (rel === null || rel === '') return;
    setSelected(rel);
    reveal(rel);
  }, [activeFile, repoRoot, reveal]);

  const rows = useMemo(() => {
    const out: Row[] = [];
    /** parentCode: 親フォルダが無視 / 管理外なら、配下も同じ扱いにする */
    const walk = (dir: string, depth: number, parentCode: OverlayCode | undefined) => {
      const kids = children[dir];
      if (kids === undefined || kids === 'loading') {
        out.push({ type: 'note', key: `${dir}:loading`, text: '読み込み中…', depth });
        return;
      }
      if (kids === 'error') {
        out.push({ type: 'note', key: `${dir}:error`, text: '(開けません)', depth });
        return;
      }
      const st = dirStatus[dir];
      const list = sortEntries(kids, 'name', true, showHidden);
      if (dir === '' && list.length === 0) {
        out.push({ type: 'note', key: ':empty', text: '(空のフォルダ)', depth });
      }
      for (const entry of list) {
        const rel = dir ? `${dir}/${entry.name}` : entry.name;
        const dirCode: OverlayCode | undefined =
          parentCode === 'ignored' || st?.ignored.has(entry.name)
            ? 'ignored'
            : parentCode === 'untracked' || st?.untracked.has(entry.name)
              ? 'untracked'
              : undefined;
        out.push({ type: 'entry', entry, rel, depth, dirCode });
        if (entry.type === 'dir' && expanded.has(rel)) walk(rel, depth + 1, dirCode);
      }
    };
    walk('', 0, undefined);
    return out;
  }, [children, expanded, dirStatus, showHidden]);

  // 選択の移動や reveal の後、選択中の行を見える位置へスクロールする
  useEffect(() => {
    if (!pendingScroll.current) return;
    const el = rootRef.current?.querySelector('[data-selected="true"]');
    if (!el) return;
    pendingScroll.current = false;
    el.scrollIntoView({ block: 'nearest' });
  });

  const setOpen = (rel: string, open: boolean) => {
    if (open === expanded.has(rel)) return;
    setExpanded((s) => {
      const next = new Set(s);
      if (open) next.add(rel);
      else next.delete(rel);
      return next;
    });
    if (open) load(rel);
  };

  const activate = (entry: FsEntry, rel: string) => {
    setSelected(rel);
    if (entry.type === 'dir') setOpen(rel, !expanded.has(rel));
    else openWithDefault(entry);
  };

  const select = (rel: string) => {
    setSelected(rel);
    pendingScroll.current = true;
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const entryRows = rows.filter((r): r is Extract<Row, { type: 'entry' }> => r.type === 'entry');
    if (entryRows.length === 0) return;
    const idx = entryRows.findIndex((r) => r.rel === selected);
    const cur = idx >= 0 ? entryRows[idx] : null;
    const isDir = cur?.entry.type === 'dir';
    switch (e.key) {
      case 'ArrowDown':
        select(entryRows[Math.min(idx + 1, entryRows.length - 1)].rel);
        break;
      case 'ArrowUp':
        select(entryRows[Math.max(idx - 1, 0)].rel);
        break;
      case 'Home':
        select(entryRows[0].rel);
        break;
      case 'End':
        select(entryRows[entryRows.length - 1].rel);
        break;
      case 'ArrowRight':
        if (!cur || !isDir) return;
        if (!expanded.has(cur.rel)) setOpen(cur.rel, true);
        else if (entryRows[idx + 1]?.depth === cur.depth + 1) select(entryRows[idx + 1].rel);
        break;
      case 'ArrowLeft':
        if (!cur) return;
        if (isDir && expanded.has(cur.rel)) setOpen(cur.rel, false);
        else if (cur.depth > 0) select(parentRel(cur.rel));
        break;
      case 'Enter':
        if (!cur) return;
        activate(cur.entry, cur.rel);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const collapseAll = () => setExpanded(new Set());

  const refresh = () => {
    statusKey.current = {};
    reloadAll();
    void refreshStatus();
  };

  const label = repoLabel || baseName(repoRoot) || repoRoot;

  return (
    <div className={cx('project')}>
      <div className={cx('project-head')}>
        <span className={cx('project-title')} title={repoRoot}>
          {label}
          {status?.branch && <span className={cx('project-branch')}> ({status.branch})</span>}
        </span>
        <button className={cx('project-action')} title="最新の情報に更新" onClick={refresh}>
          <RefreshIcon />
        </button>
        <button className={cx('project-action')} title="すべて折りたたむ" onClick={collapseAll}>
          <CollapseAllIcon />
        </button>
      </div>
      <div
        ref={rootRef}
        className={cx('project-tree side-body')}
        role="tree"
        aria-label={label}
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        {rows.map((row) => {
          const indent = 4 + row.depth * 14;
          if (row.type === 'note') {
            return (
              <div key={row.key} className={cx('tree-note')} style={{ paddingLeft: indent + 20 }}>
                {row.text}
              </div>
            );
          }
          const { entry, rel, dirCode } = row;
          const isDir = entry.type === 'dir';
          const isOpen = isDir && expanded.has(rel);
          const active = selected === rel;
          return (
            <div
              key={rel}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-expanded={isDir ? isOpen : undefined}
              aria-selected={active}
              data-selected={active}
              className={cx(
                `side-item tree-item project-item${active ? ' active' : ''}${entry.hidden ? ' hidden-entry' : ''}`,
              )}
              style={{ paddingLeft: indent }}
              title={entry.path}
              onClick={() => activate(entry, rel)}
            >
              <span className={cx(`tree-twisty${isDir ? '' : ' leaf'}`)}>
                <Chevron open={isOpen} />
              </span>
              <span className={cx('side-icon')}>
                {isDir ? (isOpen ? '📂' : '📁') : fileIcon(entry)}
                <GitOverlay path={entry.path} dirCode={dirCode} />
              </span>
              <span className={cx('side-label')}>{entry.name}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
