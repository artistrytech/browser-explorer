import { useEffect, useMemo, useRef, useState } from 'react';
import { useExplorer } from '../../stores/explorer';
import { useSettings, isMod } from '../../stores/settings';
import { useGit, OverlayCode } from '../../stores/git';
import { useUi, osMenuLabels } from '../../stores/ui';
import { useContextMenu, MenuItem } from '../../components/ContextMenu';
import {
  openEntry,
  copySelection,
  cutSelection,
  paste,
  deleteSelection,
  createFolder,
  createFile,
  renameEntry,
  showProperties,
} from '../../lib/fileOps';
import { formatSize, formatDate, kindLabel, fileIcon, baseName } from '../../lib/paths';
import { pinFolder, unpinFolder } from '../../lib/quickaccessOps';
import { saveFocus, loadFocus, saveEnteredChild } from '../../lib/focusMemory';
import { openCloneDialog } from '../git/CloneDialog';
import { openConflictResolver } from '../git/ConflictResolver';
import { api } from '../../api/client';
import { toastError } from '../../stores/toast';
import type { FsEntry, SortKey } from '../../types';

const OVERLAY_MARK: Record<OverlayCode, { mark: string; cls: string; title: string }> = {
  normal: { mark: '✔', cls: 'ov-normal', title: '変更なし' },
  modified: { mark: '●', cls: 'ov-modified', title: '変更あり' },
  staged: { mark: '＋', cls: 'ov-staged', title: 'ステージ済み' },
  untracked: { mark: '？', cls: 'ov-untracked', title: 'Git 管理外' },
  conflicted: { mark: '⚠', cls: 'ov-conflicted', title: '競合' },
  ignored: { mark: '－', cls: 'ov-ignored', title: '無視 (.gitignore)' },
};

function GitOverlay({ path, dirCode }: { path: string; dirCode?: OverlayCode }) {
  const repoRoot = useGit((s) => s.repoRoot);
  const code = useGit((s) => s.overlay[path]);
  if (!repoRoot || !path.startsWith(repoRoot)) return null;
  // /status 由来 (変更/ステージ/競合) を優先し、無ければフォルダ単位の判定 (無視/管理外)
  const info = OVERLAY_MARK[code ?? dirCode ?? 'normal'];
  return (
    <span className={`git-overlay ${info.cls}`} title={info.title}>
      {info.mark}
    </span>
  );
}

export function FileList() {
  const {
    path,
    entries,
    loading,
    selection,
    anchor,
    clipboard,
    renaming,
    searchResults,
    searchQuery,
    setSelection,
    setRenaming,
  } = useExplorer();
  const { settings, update } = useSettings();
  const repoRoot = useGit((s) => s.repoRoot);
  const mergeState = useGit((s) => s.mergeState);
  const platform = useUi((s) => s.platform);
  const openMenu = useContextMenu((s) => s.open);
  const containerRef = useRef<HTMLDivElement>(null);
  const [renameValue, setRenameValue] = useState('');
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  /** 絶対パス → リポジトリルート相対 (repo 外は null) */
  const relOf = (abs: string): string | null => {
    if (!repoRoot) return null;
    if (abs === repoRoot) return '';
    return abs.startsWith(`${repoRoot}/`) ? abs.slice(repoRoot.length + 1) : null;
  };

  /** 指定フォルダ (repo 相対) 配下に競合ファイルがあるか (002.md §2.2) */
  const conflictsUnder = (relDir: string): boolean =>
    mergeState.conflicted.some((c) => relDir === '' || c === relDir || c.startsWith(`${relDir}/`));

  // 表示中フォルダ直下の「無視 (.gitignore) / Git 管理外」判定 (abs path → code)
  const [dirOverlay, setDirOverlay] = useState<Record<string, OverlayCode>>({});
  useEffect(() => {
    const relDir = repoRoot ? relOf(path) : null;
    if (relDir === null || entries.length === 0) {
      setDirOverlay({});
      return;
    }
    let cancelled = false;
    api
      .gitEntriesStatus(repoRoot!, relDir, entries.map((e) => e.name))
      .then((r) => {
        if (cancelled) return;
        const map: Record<string, OverlayCode> = {};
        const abs = (n: string) => (path.endsWith('/') ? path + n : `${path}/${n}`);
        for (const n of r.ignored) map[abs(n)] = 'ignored';
        for (const n of r.untracked) map[abs(n)] = 'untracked';
        setDirOverlay(map);
      })
      .catch(() => setDirOverlay({}));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, repoRoot, path]);

  const displayed = useMemo(() => {
    const base = searchResults ?? entries;
    const filtered = settings.showHidden ? base : base.filter((e) => !e.hidden);
    const dir = settings.sortAsc ? 1 : -1;
    const key = settings.sortKey;
    return [...filtered].sort((a, b) => {
      // フォルダを常に先に
      const aDir = a.type === 'dir' ? 0 : 1;
      const bDir = b.type === 'dir' ? 0 : 1;
      if (aDir !== bDir) return aDir - bDir;
      let cmp = 0;
      if (key === 'name') cmp = a.name.localeCompare(b.name, 'ja');
      else if (key === 'type') cmp = kindLabel(a).localeCompare(kindLabel(b), 'ja');
      else if (key === 'size') cmp = a.size - b.size;
      else cmp = a.mtime - b.mtime;
      return cmp * dir || a.name.localeCompare(b.name, 'ja');
    });
  }, [entries, searchResults, settings.showHidden, settings.sortKey, settings.sortAsc]);

  const selectedSet = useMemo(() => new Set(selection), [selection]);

  useEffect(() => {
    if (renaming) {
      const e = displayed.find((d) => d.path === renaming);
      setRenameValue(e?.name ?? '');
    }
  }, [renaming]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- フォーカス/選択位置の保存 (002.md §6.3): 変更時にデバウンス書き込み ---
  const focusStateRef = useRef({ path, selection, anchor });
  focusStateRef.current = { path, selection, anchor };
  const writeFocus = () => {
    const { path: p, selection: sel, anchor: an } = focusStateRef.current;
    const anchorName = an ? baseName(an) : null;
    saveFocus(p, {
      focused: anchorName,
      focusedIndex: an ? displayed.findIndex((d) => d.path === an) : -1,
      selected: sel.map(baseName),
      scrollTop: containerRef.current?.scrollTop ?? 0,
    });
  };
  const writeFocusRef = useRef(writeFocus);
  writeFocusRef.current = writeFocus;

  useEffect(() => {
    if (loading) return;
    const t = setTimeout(() => writeFocusRef.current(), 200);
    return () => clearTimeout(t);
  }, [selection, anchor, loading]);

  // スクロール位置の保存 (§6.2)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let t: ReturnType<typeof setTimeout>;
    const onScroll = () => {
      clearTimeout(t);
      t = setTimeout(() => writeFocusRef.current(), 250);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      clearTimeout(t);
      el.removeEventListener('scroll', onScroll);
    };
  }, []);

  // 離脱/リロード直前にも最新化 (§6.3)
  useEffect(() => {
    const flush = () => writeFocusRef.current();
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', flush);
    };
  }, []);

  // --- 復元 (002.md §6.4): 一覧読み込み後にスクロール位置とフォーカス項目を適用 ---
  const restoredForRef = useRef<string | null>(null);
  useEffect(() => {
    if (loading || restoredForRef.current === path) return;
    restoredForRef.current = path;
    const rec = loadFocus(path);
    if (!containerRef.current) return;
    containerRef.current.scrollTop = rec?.scrollTop ?? 0;
    const target = anchor ?? (rec?.focused ? entries.find((e) => e.name === rec.focused)?.path : null);
    if (target) {
      document
        .querySelector(`[data-entry-path="${CSS.escape(target)}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    }
  }, [path, loading]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- 選択処理 ---
  const clickEntry = (e: React.MouseEvent, entry: FsEntry) => {
    if (e.shiftKey && anchor) {
      const ai = displayed.findIndex((d) => d.path === anchor);
      const bi = displayed.findIndex((d) => d.path === entry.path);
      if (ai >= 0 && bi >= 0) {
        const [lo, hi] = ai < bi ? [ai, bi] : [bi, ai];
        setSelection(displayed.slice(lo, hi + 1).map((d) => d.path));
        return;
      }
    }
    if (isMod(e)) {
      if (selectedSet.has(entry.path)) {
        setSelection(selection.filter((p) => p !== entry.path), entry.path);
      } else {
        setSelection([...selection, entry.path], entry.path);
      }
      return;
    }
    setSelection([entry.path], entry.path);
  };

  const moveSelection = (delta: number, extend: boolean) => {
    if (displayed.length === 0) return;
    const currentIdx = anchor ? displayed.findIndex((d) => d.path === anchor) : -1;
    const next = Math.max(0, Math.min(displayed.length - 1, currentIdx + delta));
    const target = displayed[next];
    if (extend && anchor) {
      // 簡易版: anchor は動かさず対象まで
      const ai = displayed.findIndex((d) => d.path === anchor);
      const [lo, hi] = ai < next ? [ai, next] : [next, ai];
      setSelection(displayed.slice(lo, hi + 1).map((d) => d.path));
    } else {
      setSelection([target.path], target.path);
    }
    document
      .querySelector(`[data-entry-path="${CSS.escape(target.path)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  };

  // --- キーボード (plan §6.3 Windows 流) ---
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (renaming) return;
    const selEntries = displayed.filter((d) => selectedSet.has(d.path));

    if (e.key === 'Enter' && selEntries.length > 0) {
      e.preventDefault();
      selEntries.forEach(openEntry);
    } else if (e.key === 'F2' && selEntries.length === 1) {
      e.preventDefault();
      setRenaming(selEntries[0].path);
    } else if (e.key === 'Delete') {
      e.preventDefault();
      void deleteSelection(e.shiftKey);
    } else if (isMod(e) && (e.key === 'c' || e.key === 'C')) {
      e.preventDefault();
      copySelection();
    } else if (isMod(e) && (e.key === 'x' || e.key === 'X')) {
      e.preventDefault();
      cutSelection();
    } else if (isMod(e) && (e.key === 'v' || e.key === 'V')) {
      e.preventDefault();
      void paste();
    } else if (isMod(e) && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      setSelection(displayed.map((d) => d.path));
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveSelection(anchor ? 1 : 0, e.shiftKey);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveSelection(anchor ? -1 : 0, e.shiftKey);
    } else if (e.key === 'Escape') {
      setSelection([]);
    }
  };

  // --- コンテキストメニュー (出し分けは 002.md §8) ---
  const osLabels = osMenuLabels(platform);
  const menuConfig = useUi((s) => s.menuConfig);

  /** config.jsonc の contextMenu 設定 (false で非表示、未設定は表示) */
  type CfgMenuItem = MenuItem & { id?: string };
  const pruneMenu = (items: CfgMenuItem[]): MenuItem[] => {
    const kept = items.filter((it) => it.separator || !it.id || menuConfig[it.id] !== false);
    // 非表示により連続/先頭/末尾になった separator を除去
    const out: MenuItem[] = [];
    for (const it of kept) {
      if (it.separator && (out.length === 0 || out[out.length - 1].separator)) continue;
      out.push(it);
    }
    while (out.length > 0 && out[out.length - 1].separator) out.pop();
    return out;
  };

  /**
   * 「別ウィンドウで開く」: 指定フォルダをブラウザの別タブで開く。
   * focusName を渡すとそのエントリにフォーカスを当てる
   * (フォーカス記録の sessionStorage は window.open 時に新タブへ複製される)
   */
  const openInNewWindow = (dir: string, focusName?: string) => {
    if (focusName) {
      saveEnteredChild(dir, focusName, displayed.findIndex((d) => d.name === focusName));
    }
    window.open(`${location.pathname}?path=${encodeURIComponent(dir)}`, '_blank');
  };

  /** フォルダ/空白共通の OS 連携項目 (002.md §4): 対象がファイルでない場合のみ */
  const osMenuItems = (dirPath: string): CfgMenuItem[] => [
    {
      id: 'osFileManager',
      label: osLabels.fileManager,
      action: () => void api.osOpenFileManager(dirPath).catch(toastError),
    },
    { id: 'osTerminal', label: osLabels.terminal, action: () => void api.osOpenTerminal(dirPath).catch(toastError) },
  ];

  /** Git 系の文脈依存項目 (ログを表示 / 競合を解消 / Git Clone…) */
  const gitContextItems = (targetPath: string, isFile: boolean, isDir: boolean): CfgMenuItem[] => {
    const rel = relOf(targetPath);
    const items: CfgMenuItem[] = [];
    if (rel !== null) {
      // Git 管理下: パス絞り込みログ (002.md §1)。Ctrl+クリック (mac は ⌘) は別タブで開く
      items.push({
        id: 'gitLog',
        label: 'Gitログ',
        action: (e) => useGit.getState().showLogFor(rel, isFile, e.ctrlKey || e.metaKey),
      });
      // 進行中 かつ 配下に競合あり → 競合を解消 (002.md §2)
      if (isDir && mergeState.inProgress && conflictsUnder(rel)) {
        items.push({ id: 'resolveConflict', label: '競合を解消…', action: () => openConflictResolver(rel) });
      }
    } else if (isDir) {
      // Git 管理外のフォルダ → Git Clone… (002.md §3)
      items.push({ id: 'gitClone', label: 'Git Clone…', action: () => openCloneDialog(targetPath) });
    }
    return items;
  };

  const entryMenu = (e: React.MouseEvent, entry: FsEntry) => {
    e.preventDefault();
    // コンテナの backgroundMenu へバブリングさせない (背景メニューで上書きされるのを防ぐ)
    e.stopPropagation();
    // 左クリック同様、右クリックでも対象にフォーカスを当てる
    // (選択済みの複数選択は維持しつつ anchor だけ対象へ移す)
    if (!selectedSet.has(entry.path)) setSelection([entry.path], entry.path);
    else setSelection(selection, entry.path);
    containerRef.current?.focus();
    const sel = selectedSet.has(entry.path) ? selection : [entry.path];
    const single = sel.length === 1;
    const pinned = useSettings.getState().isPinned(entry.path);
    const items: CfgMenuItem[] = [
      { id: 'open', label: '開く', action: () => displayed.filter((d) => sel.includes(d.path)).forEach(openEntry) },
      ...(entry.type !== 'dir'
        ? [
            { id: 'openEditor', label: 'エディタで開く', action: () => openEntry(entry) },
            // ファイル: 同じフォルダを別ウィンドウで開いて対象にフォーカス
            { id: 'openNewWindow', label: '別ウィンドウで開く', action: () => openInNewWindow(path, entry.name) },
          ]
        : [
            // フォルダ: 対象フォルダ自体を別ウィンドウで開く
            { id: 'openNewWindow', label: '別ウィンドウで開く', action: () => openInNewWindow(entry.path) },
            // ピン止め / 解除のトグル (002.md §7.2)。解除は確認フローへ
            pinned
              ? { id: 'pin', label: 'ピン止めを解除', action: () => void unpinFolder(entry.path, entry.name) }
              : {
                  id: 'pin',
                  label: 'クイックアクセスにピン止め',
                  action: () => void pinFolder(entry.path, entry.name),
                },
            { separator: true },
            ...osMenuItems(entry.path),
          ]),
      { separator: true },
      { id: 'copy', label: 'コピー', action: copySelection },
      { id: 'cut', label: '切り取り', action: cutSelection },
      {
        id: 'paste',
        label: '貼り付け',
        action: () => void paste(entry.type === 'dir' ? entry.path : undefined),
        disabled: !clipboard,
      },
      { separator: true },
      { id: 'rename', label: '名前の変更 (F2)', action: () => setRenaming(entry.path), disabled: !single },
      { id: 'delete', label: '削除 (ゴミ箱)', action: () => void deleteSelection(false) },
      { id: 'deletePermanent', label: '完全に削除', action: () => void deleteSelection(true), danger: true },
      { separator: true },
    ];
    const gitItems = gitContextItems(entry.path, entry.type === 'file', entry.type === 'dir');
    if (gitItems.length > 0) items.push(...gitItems, { separator: true });
    if (repoRoot && entry.path.startsWith(repoRoot)) {
      const rel = sel.map((p) => p.slice(repoRoot.length + 1));
      items.push(
        {
          id: 'gitStage',
          label: 'Git: ステージ',
          action: () =>
            void api
              .gitStage(repoRoot, rel)
              .then(() => useGit.getState().refreshStatus())
              .catch(toastError),
        },
        {
          id: 'gitUnstage',
          label: 'Git: ステージ解除',
          action: () =>
            void api
              .gitUnstage(repoRoot, rel)
              .then(() => useGit.getState().refreshStatus())
              .catch(toastError),
        },
        {
          id: 'gitDiscard',
          label: 'Git: 変更を破棄',
          danger: true,
          action: () =>
            void api
              .gitDiscard(repoRoot, rel)
              .then(() => Promise.all([useGit.getState().refreshStatus(), useExplorer.getState().refresh()]))
              .catch(toastError),
        },
        { separator: true },
      );
    }
    items.push({ id: 'properties', label: 'プロパティ', action: () => void showProperties(entry), disabled: !single });
    openMenu(e.clientX, e.clientY, pruneMenu(items));
  };

  const backgroundMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setSelection([]);
    // 空白 = カレントフォルダを対象とする (002.md §4.1 / §8)
    const currentPinned = useSettings.getState().isPinned(path);
    const items: CfgMenuItem[] = [
      { id: 'newFolder', label: '新規フォルダ', action: () => void createFolder() },
      { id: 'newFile', label: '新規ファイル', action: () => void createFile() },
      { separator: true },
      // フォーカス無し: 表示中のフォルダを別ウィンドウで開く
      { id: 'openNewWindow', label: '別ウィンドウで開く', action: () => openInNewWindow(path) },
      { separator: true },
      { id: 'paste', label: '貼り付け', action: () => void paste(), disabled: !clipboard },
      { separator: true },
      currentPinned
        ? { id: 'pin', label: 'ピン止めを解除', action: () => void unpinFolder(path, baseName(path)) }
        : {
            id: 'pin',
            label: 'クイックアクセスにピン止め',
            action: () => void pinFolder(path, baseName(path)),
          },
      { separator: true },
      ...osMenuItems(path),
      { separator: true },
    ];
    const gitItems = gitContextItems(path, false, true);
    if (gitItems.length > 0) items.push(...gitItems, { separator: true });
    items.push({ id: 'refresh', label: '最新の情報に更新', action: () => void useExplorer.getState().refresh() });
    openMenu(e.clientX, e.clientY, pruneMenu(items));
  };

  // --- ドラッグ & ドロップ (Ctrl でコピー、通常は移動) ---
  const onDragStart = (e: React.DragEvent, entry: FsEntry) => {
    const sel = selectedSet.has(entry.path) ? selection : [entry.path];
    if (!selectedSet.has(entry.path)) setSelection([entry.path], entry.path);
    e.dataTransfer.setData('application/x-entries', JSON.stringify(sel));
    e.dataTransfer.effectAllowed = 'copyMove';
  };

  const onDropTo = async (e: React.DragEvent, destDir: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    const raw = e.dataTransfer.getData('application/x-entries');
    if (!raw) return;
    const src = JSON.parse(raw) as string[];
    if (src.includes(destDir)) return;
    try {
      if (e.ctrlKey || e.metaKey) await api.copy(src, destDir);
      else await api.move(src, destDir);
      await useExplorer.getState().refresh();
      void useGit.getState().refreshStatus();
    } catch (err) {
      toastError(err);
    }
  };

  // --- リネーム確定 ---
  const commitRename = async () => {
    const target = renaming;
    setRenaming(null);
    if (!target) return;
    const entry = displayed.find((d) => d.path === target);
    if (entry && renameValue && renameValue !== entry.name) {
      await renameEntry(target, renameValue);
    }
  };

  const sortHeader = (key: SortKey, label: string) => (
    <th
      onClick={() =>
        update(settings.sortKey === key ? { sortAsc: !settings.sortAsc } : { sortKey: key, sortAsc: true })
      }
    >
      {label}
      {settings.sortKey === key && <span className="sort-arrow">{settings.sortAsc ? ' ▲' : ' ▼'}</span>}
    </th>
  );

  const renderName = (entry: FsEntry) =>
    renaming === entry.path ? (
      <input
        className="rename-input"
        autoFocus
        value={renameValue}
        onChange={(ev) => setRenameValue(ev.target.value)}
        onFocus={(ev) => {
          const dot = renameValue.lastIndexOf('.');
          ev.target.setSelectionRange(0, entry.type !== 'dir' && dot > 0 ? dot : renameValue.length);
        }}
        onBlur={() => void commitRename()}
        onKeyDown={(ev) => {
          ev.stopPropagation();
          if (ev.key === 'Enter') void commitRename();
          if (ev.key === 'Escape') setRenaming(null);
        }}
        onClick={(ev) => ev.stopPropagation()}
      />
    ) : (
      <span className="entry-name">
        <span className="entry-icon">
          {fileIcon(entry)}
          <GitOverlay path={entry.path} dirCode={dirOverlay[entry.path]} />
        </span>
        <span className={clipboard?.op === 'cut' && clipboard.paths.includes(entry.path) ? 'cut-pending' : ''}>
          {entry.name}
        </span>
      </span>
    );

  const rowProps = (entry: FsEntry) => ({
    'data-entry-path': entry.path,
    className: `${selectedSet.has(entry.path) ? 'selected' : ''}${dropTarget === entry.path ? ' drop-target' : ''}${entry.hidden ? ' hidden-entry' : ''}`,
    onClick: (e: React.MouseEvent) => clickEntry(e, entry),
    onDoubleClick: () => openEntry(entry),
    onContextMenu: (e: React.MouseEvent) => entryMenu(e, entry),
    draggable: renaming !== entry.path,
    onDragStart: (e: React.DragEvent) => onDragStart(e, entry),
    ...(entry.type === 'dir'
      ? {
          onDragOver: (e: React.DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
            setDropTarget(entry.path);
          },
          onDragLeave: () => setDropTarget((t) => (t === entry.path ? null : t)),
          onDrop: (e: React.DragEvent) => void onDropTo(e, entry.path),
        }
      : {}),
  });

  return (
    <div
      ref={containerRef}
      className="file-list"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onContextMenu={backgroundMenu}
      onClick={(e) => {
        if (e.target === e.currentTarget) setSelection([]);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => void onDropTo(e, path)}
    >
      {searchResults && (
        <div className="search-banner">
          「{searchQuery}」の検索結果: {displayed.length} 件
        </div>
      )}
      {loading && (
        <div className="loading-spinner" role="status" aria-label="読み込み中">
          <div className="spinner-ring" />
        </div>
      )}

      {settings.viewMode === 'icons' ? (
        <div className="icon-grid">
          {displayed.map((entry) => (
            <div key={entry.path} {...rowProps(entry)}>
              <div className="big-icon">
                {fileIcon(entry)}
                <GitOverlay path={entry.path} dirCode={dirOverlay[entry.path]} />
              </div>
              {renaming === entry.path ? renderName(entry) : <div className="icon-label">{entry.name}</div>}
            </div>
          ))}
        </div>
      ) : (
        <table className="details-table">
          <thead>
            <tr>
              {sortHeader('name', '名前')}
              {settings.viewMode === 'details' && sortHeader('type', '種類')}
              {settings.viewMode === 'details' && sortHeader('size', 'サイズ')}
              {settings.viewMode === 'details' && sortHeader('mtime', '更新日時')}
            </tr>
          </thead>
          <tbody>
            {displayed.map((entry) => (
              <tr key={entry.path} {...rowProps(entry)}>
                <td>{renderName(entry)}</td>
                {settings.viewMode === 'details' && <td>{kindLabel(entry)}</td>}
                {settings.viewMode === 'details' && (
                  <td className="col-size">{formatSize(entry.size, entry.type === 'dir')}</td>
                )}
                {settings.viewMode === 'details' && <td>{formatDate(entry.mtime)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!loading && displayed.length === 0 && (
        <div className="empty-hint">{searchResults ? '該当なし' : 'このフォルダは空です'}</div>
      )}
    </div>
  );
}
