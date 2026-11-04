import { useEffect, useMemo, useRef, useState } from 'react';
import { useExplorer } from '../../stores/explorer';
import {
  useSettings,
  isMod,
  DEFAULT_COLUMN_WIDTHS,
  MIN_COLUMN_WIDTH,
  MAX_COLUMN_WIDTH,
  type ColumnWidths,
} from '../../stores/settings';
import { useGit, OverlayCode } from '../../stores/git';
import { GitOverlay } from '../../components/GitOverlay';
import { useContextMenu } from '../../components/ContextMenu';
import {
  openWithDefault,
  copySelection,
  cutSelection,
  paste,
  deleteSelection,
  renameEntry,
} from '../../lib/fileOps';
import { entryMenuItems, folderMenuItems } from '../../lib/entryMenu';
import { formatSize, formatDate, kindLabel, fileIcon, baseName } from '../../lib/paths';
import { sortEntries } from '../../lib/entrySort';
import { saveFocus, loadFocus, saveEnteredChild } from '../../lib/focusMemory';
import { api } from '../../api/client';
import { toastError } from '../../stores/toast';
import type { FsEntry, SortKey } from '../../types';
import { openInNewTab } from '../../lib/appTabs';
import styles from './FileList.module.scss';
import { createCssModuleClassNames } from '../../lib/cssModule';

const cx = createCssModuleClassNames(styles);

/** 詳細表示のカラム定義 (「一覧」表示では先頭の「名前」のみ使う) */
const COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'name', label: '名前' },
  { key: 'type', label: '種類' },
  { key: 'size', label: 'サイズ' },
  { key: 'mtime', label: '更新日時' },
];

export function FileList() {
  const {
    path,
    entries,
    loading,
    selection,
    anchor,
    clipboard,
    renaming,
    setSelection,
    setRenaming,
  } = useExplorer();
  const { settings, update } = useSettings();
  const repoRoot = useGit((s) => s.repoRoot);
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

  const displayed = useMemo(
    () => sortEntries(entries, settings.sortKey, settings.sortAsc, settings.showHidden),
    [entries, settings.showHidden, settings.sortKey, settings.sortAsc],
  );

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
      selEntries.forEach(openWithDefault);
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

  // --- コンテキストメニュー (出し分けは 002.md §8。項目は lib/entryMenu.ts でプロジェクトツリーと共通) ---
  /**
   * 「別ウィンドウで開く」: 指定フォルダをブラウザの別タブで開く。
   * focusName を渡すとそのエントリにフォーカスを当てる
   * (フォーカス記録の sessionStorage は別タブで開くときに新タブへ複製される)
   */
  const openInNewWindow = (dir: string, focusName?: string) => {
    if (focusName) {
      saveEnteredChild(dir, focusName, displayed.findIndex((d) => d.name === focusName));
    }
    openInNewTab(`${location.pathname}?path=${encodeURIComponent(dir)}`);
  };

  const entryMenu =(e: React.MouseEvent, entry: FsEntry) => {
    e.preventDefault();
    // コンテナの backgroundMenu へバブリングさせない (背景メニューで上書きされるのを防ぐ)
    e.stopPropagation();
    // 左クリック同様、右クリックでも対象にフォーカスを当てる
    // (選択済みの複数選択は維持しつつ anchor だけ対象へ移す)
    if (!selectedSet.has(entry.path)) setSelection([entry.path], entry.path);
    else setSelection(selection, entry.path);
    containerRef.current?.focus();
    const sel = selectedSet.has(entry.path) ? selection : [entry.path];
    const items = entryMenuItems({
      entry,
      targets: displayed.filter((d) => sel.includes(d.path)),
      fileDir: path,
      untracked: useGit.getState().overlay[entry.path] === 'untracked' || dirOverlay[entry.path] === 'untracked',
      openInNewWindow,
      rename: () => setRenaming(entry.path),
    });
    openMenu(e.clientX, e.clientY, items);
  };

  const backgroundMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setSelection([]);
    // 空白 = カレントフォルダを対象とする (002.md §4.1 / §8)
    const items = folderMenuItems({
      dir: path,
      openInNewWindow,
      refresh: () => void useExplorer.getState().refresh(),
    });
    openMenu(e.clientX, e.clientY, items);
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

  // --- カラム幅 (一覧はフル幅ではなく既定幅の合計で表示し、右側は余白にする) ---
  const columns = settings.viewMode === 'details' ? COLUMNS : COLUMNS.slice(0, 1);
  // ドラッグ中だけローカル値を使い、確定時に設定へ保存する
  const [dragWidths, setDragWidths] = useState<ColumnWidths | null>(null);
  const widths = dragWidths ?? settings.columnWidths;
  const tableWidth = columns.reduce((sum, c) => sum + widths[c.key], 0);

  const startResize = (e: React.MouseEvent, key: SortKey) => {
    e.preventDefault();
    e.stopPropagation(); // ヘッダのソートを発火させない
    const startX = e.clientX;
    const startW = widths[key];
    let next = widths;
    const onMove = (ev: MouseEvent) => {
      const w = Math.round(startW + ev.clientX - startX);
      next = { ...widths, [key]: Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, w)) };
      setDragWidths(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.classList.remove('col-resizing');
      setDragWidths(null);
      update({ columnWidths: next });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.classList.add('col-resizing');
  };

  const columnHeader = ({ key, label }: { key: SortKey; label: string }) => (
    <th
      key={key}
      style={{ width: widths[key] }}
      onClick={() =>
        update(settings.sortKey === key ? { sortAsc: !settings.sortAsc } : { sortKey: key, sortAsc: true })
      }
    >
      {label}
      {settings.sortKey === key && <span className={cx("sort-arrow")}>{settings.sortAsc ? ' ▲' : ' ▼'}</span>}
      <span
        className={cx("col-resizer")}
        title="ドラッグで幅を変更 (ダブルクリックで既定幅)"
        onMouseDown={(e) => startResize(e, key)}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => {
          e.stopPropagation();
          update({ columnWidths: { ...widths, [key]: DEFAULT_COLUMN_WIDTHS[key] } });
        }}
      />
    </th>
  );

  const renderName = (entry: FsEntry) =>
    renaming === entry.path ? (
      <input
        className={cx("rename-input")}
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
      <span className={cx("entry-name")}>
        <span className={cx("entry-icon")}>
          {fileIcon(entry)}
          <GitOverlay path={entry.path} dirCode={dirOverlay[entry.path]} />
        </span>
        <span
          className={cx(`entry-label${clipboard?.op === 'cut' && clipboard.paths.includes(entry.path) ? ' cut-pending' : ''}`)}
        >
          {entry.name}
        </span>
      </span>
    );

  const rowProps = (entry: FsEntry) => ({
    'data-entry-path': entry.path,
    className: cx(`${selectedSet.has(entry.path) ? 'selected' : ''}${dropTarget === entry.path ? ' drop-target' : ''}${entry.hidden ? ' hidden-entry' : ''}`),
    onClick: (e: React.MouseEvent) => clickEntry(e, entry),
    onDoubleClick: () => openWithDefault(entry),
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
      className={cx("file-list")}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onContextMenu={backgroundMenu}
      onClick={(e) => {
        if (e.target === e.currentTarget) setSelection([]);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => void onDropTo(e, path)}
    >
      {loading && (
        <div className={cx("loading-spinner")} role="status" aria-label="読み込み中">
          <div className={cx("spinner-ring")} />
        </div>
      )}

      {settings.viewMode === 'icons' ? (
        <div className={cx("icon-grid")}>
          {displayed.map((entry) => (
            <div key={entry.path} {...rowProps(entry)}>
              <div className={cx("big-icon")}>
                {fileIcon(entry)}
                <GitOverlay path={entry.path} dirCode={dirOverlay[entry.path]} big />
              </div>
              {renaming === entry.path ? renderName(entry) : <div className={cx("icon-label")}>{entry.name}</div>}
            </div>
          ))}
        </div>
      ) : (
        <table className={cx("details-table")} style={{ width: tableWidth }}>
          <colgroup>
            {columns.map((c) => (
              <col key={c.key} style={{ width: widths[c.key] }} />
            ))}
          </colgroup>
          <thead>
            <tr>{columns.map(columnHeader)}</tr>
          </thead>
          <tbody>
            {displayed.map((entry) => (
              <tr key={entry.path} {...rowProps(entry)}>
                <td>{renderName(entry)}</td>
                {settings.viewMode === 'details' && <td>{kindLabel(entry)}</td>}
                {settings.viewMode === 'details' && (
                  <td className={cx("col-size")}>{formatSize(entry.size, entry.type === 'dir')}</td>
                )}
                {settings.viewMode === 'details' && <td>{formatDate(entry.mtime)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!loading && displayed.length === 0 && (
        <div className={cx("empty-hint")}>このフォルダは空です</div>
      )}
    </div>
  );
}
