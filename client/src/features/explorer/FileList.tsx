import { useEffect, useMemo, useRef, useState } from 'react';
import { useExplorer } from '../../stores/explorer';
import { useSettings, isMod } from '../../stores/settings';
import { useGit, OverlayCode } from '../../stores/git';
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
import { formatSize, formatDate, kindLabel, fileIcon } from '../../lib/paths';
import { api } from '../../api/client';
import { toastError } from '../../stores/toast';
import type { FsEntry, SortKey } from '../../types';

const OVERLAY_MARK: Record<OverlayCode, { mark: string; cls: string; title: string }> = {
  normal: { mark: '✔', cls: 'ov-normal', title: '変更なし' },
  modified: { mark: '●', cls: 'ov-modified', title: '変更あり' },
  staged: { mark: '＋', cls: 'ov-staged', title: 'ステージ済み' },
  untracked: { mark: '？', cls: 'ov-untracked', title: '未追跡' },
  conflicted: { mark: '⚠', cls: 'ov-conflicted', title: '競合' },
};

function GitOverlay({ path }: { path: string }) {
  const repoRoot = useGit((s) => s.repoRoot);
  const code = useGit((s) => s.overlay[path]);
  if (!repoRoot || !path.startsWith(repoRoot)) return null;
  const info = OVERLAY_MARK[code ?? 'normal'];
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
  const openMenu = useContextMenu((s) => s.open);
  const containerRef = useRef<HTMLDivElement>(null);
  const [renameValue, setRenameValue] = useState('');
  const [dropTarget, setDropTarget] = useState<string | null>(null);

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

  // --- コンテキストメニュー ---
  const entryMenu = (e: React.MouseEvent, entry: FsEntry) => {
    e.preventDefault();
    if (!selectedSet.has(entry.path)) setSelection([entry.path], entry.path);
    const sel = selectedSet.has(entry.path) ? selection : [entry.path];
    const single = sel.length === 1;
    const items: MenuItem[] = [
      { label: '開く', action: () => displayed.filter((d) => sel.includes(d.path)).forEach(openEntry) },
      ...(entry.type !== 'dir'
        ? [{ label: 'エディタで開く', action: () => openEntry(entry) }]
        : [
            {
              label: 'クイックアクセスにピン留め',
              action: () => useSettings.getState().addFavorite({ path: entry.path, label: entry.name }),
            },
          ]),
      { separator: true },
      { label: 'コピー', action: copySelection },
      { label: '切り取り', action: cutSelection },
      { label: '貼り付け', action: () => void paste(entry.type === 'dir' ? entry.path : undefined), disabled: !clipboard },
      { separator: true },
      { label: '名前の変更 (F2)', action: () => setRenaming(entry.path), disabled: !single },
      { label: '削除 (ゴミ箱)', action: () => void deleteSelection(false) },
      { label: '完全に削除', action: () => void deleteSelection(true), danger: true },
      { separator: true },
    ];
    if (repoRoot && entry.path.startsWith(repoRoot)) {
      const rel = sel.map((p) => p.slice(repoRoot.length + 1));
      items.push(
        {
          label: 'Git: ステージ',
          action: () =>
            void api
              .gitStage(repoRoot, rel)
              .then(() => useGit.getState().refreshStatus())
              .catch(toastError),
        },
        {
          label: 'Git: ステージ解除',
          action: () =>
            void api
              .gitUnstage(repoRoot, rel)
              .then(() => useGit.getState().refreshStatus())
              .catch(toastError),
        },
        {
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
    items.push({ label: 'プロパティ', action: () => void showProperties(entry), disabled: !single });
    openMenu(e.clientX, e.clientY, items);
  };

  const backgroundMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setSelection([]);
    openMenu(e.clientX, e.clientY, [
      { label: '新規フォルダ', action: () => void createFolder() },
      { label: '新規ファイル', action: () => void createFile() },
      { separator: true },
      { label: '貼り付け', action: () => void paste(), disabled: !clipboard },
      { separator: true },
      { label: '最新の情報に更新', action: () => void useExplorer.getState().refresh() },
    ]);
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
          <GitOverlay path={entry.path} />
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
      {loading && <div className="loading-bar">読み込み中…</div>}

      {settings.viewMode === 'icons' ? (
        <div className="icon-grid">
          {displayed.map((entry) => (
            <div key={entry.path} {...rowProps(entry)}>
              <div className="big-icon">
                {fileIcon(entry)}
                <GitOverlay path={entry.path} />
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
