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
import { useUi, osMenuLabels } from '../../stores/ui';
import { useContextMenu, MenuItem } from '../../components/ContextMenu';
import {
  openEntry,
  openWithDefault,
  runExternalTool,
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

const OVERLAY_MARK: Record<OverlayCode, { mark: string; cls: string; title: string }> = {
  normal: { mark: '✔', cls: 'ov-normal', title: '変更なし' },
  modified: { mark: '●', cls: 'ov-modified', title: '変更あり' },
  staged: { mark: '＋', cls: 'ov-staged', title: 'ステージ済み' },
  untracked: { mark: '？', cls: 'ov-untracked', title: 'Git 管理外' },
  conflicted: { mark: '⚠', cls: 'ov-conflicted', title: '競合' },
  ignored: { mark: '－', cls: 'ov-ignored', title: '無視 (.gitignore)' },
};

/**
 * 外部ツールがメニューに出せるか: 対象 (複数選択可) が全て kind / 拡張子条件に合致するか。
 * kind 'any'/未指定は種別不問。extensions 空/未指定は全拡張子対象 (フォルダは拡張子条件に不一致)。
 */
function toolMatches(
  t: { kind?: 'file' | 'dir' | 'any'; extensions?: string[] },
  targets: { kind: 'file' | 'dir'; ext: string }[],
): boolean {
  return targets.every((tg) => {
    const kindOk = !t.kind || t.kind === 'any' || t.kind === tg.kind;
    const extOk =
      !t.extensions || t.extensions.length === 0 || (tg.kind === 'file' && t.extensions.includes(tg.ext));
    return kindOk && extOk;
  });
}

function GitOverlay({ path, dirCode }: { path: string; dirCode?: OverlayCode }) {
  const repoRoot = useGit((s) => s.repoRoot);
  const code = useGit((s) => s.overlay[path]);
  if (!repoRoot || !path.startsWith(repoRoot)) return null;
  // /status 由来 (変更/ステージ/競合) を優先し、無ければフォルダ単位の判定 (無視/管理外)
  const info = OVERLAY_MARK[code ?? dirCode ?? 'normal'];
  return (
    <span className={cx(`git-overlay ${info.cls}`)} title={info.title}>
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

  // --- コンテキストメニュー (出し分けは 002.md §8) ---
  const osLabels = osMenuLabels(platform);
  const menuConfig = useUi((s) => s.menuConfig);
  const externalTools = useUi((s) => s.externalTools);

  /** config.jsonc の contextMenu 設定 (false で非表示、未設定は表示)。サブメニューも同様に間引く */
  type CfgMenuItem = Omit<MenuItem, 'submenu'> & { id?: string; submenu?: CfgMenuItem[] };
  const pruneMenu = (items: CfgMenuItem[]): MenuItem[] => {
    const out: MenuItem[] = [];
    for (const it of items) {
      if (it.id && menuConfig[it.id] === false) continue;
      if (it.submenu) {
        const submenu = pruneMenu(it.submenu);
        if (submenu.length > 0) out.push({ ...it, submenu }); // 中身が空になったグループは出さない
        continue;
      }
      // 非表示により連続/先頭になった separator は除去
      if (it.separator && (out.length === 0 || out[out.length - 1].separator)) continue;
      out.push(it);
    }
    while (out.length > 0 && out[out.length - 1].separator) out.pop();
    return out;
  };

  /**
   * カスタム項目 (設定の externalTools) を group ごとに振り分ける。
   * group が既定グループ名 (開く/削除/Git) ならそのサブメニューに合流し、
   * それ以外の名前なら同名のサブメニューを新設する。group 無しはメニュー直下。
   * targets の種別/拡張子が全て一致するツールだけを表示する。
   */
  const toolItems = (paths: string[], targets: { kind: 'file' | 'dir'; ext: string }[]) => {
    const byGroup = new Map<string, MenuItem[]>();
    const ungrouped: MenuItem[] = [];
    externalTools.forEach((t) => {
      if (!t.label || !toolMatches(t, targets)) return;
      const item: MenuItem = {
        label: t.label,
        action: () => void runExternalTool(t, paths),
      };
      if (t.group) byGroup.set(t.group, [...(byGroup.get(t.group) ?? []), item]);
      else ungrouped.push(item);
    });
    /** 既定グループに合流する項目を取り出す (取り出したグループは新設対象から外れる) */
    const take = (group: string): MenuItem[] => {
      const items = byGroup.get(group) ?? [];
      byGroup.delete(group);
      return items;
    };
    /** 既定グループに属さなかったカスタム項目 (新設サブメニュー + group 無しの項目) */
    const rest = (): CfgMenuItem[] => [
      ...[...byGroup.entries()].map(([label, submenu]) => ({ label, submenu })),
      ...ungrouped,
    ];
    return { take, rest };
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

  /** Git 系のリポジトリ操作 (選択パスに対するステージ/解除/破棄) */
  const gitRepoItems = (sel: string[]): CfgMenuItem[] => {
    if (!repoRoot || !sel.every((p) => p.startsWith(`${repoRoot}/`))) return [];
    const rel = sel.map((p) => p.slice(repoRoot.length + 1));
    return [
      {
        id: 'gitStage',
        label: 'ステージ',
        action: () =>
          void api
            .gitStage(repoRoot, rel)
            .then(() => useGit.getState().refreshStatus())
            .catch(toastError),
      },
      {
        id: 'gitUnstage',
        label: 'ステージ解除',
        action: () =>
          void api
            .gitUnstage(repoRoot, rel)
            .then(() => useGit.getState().refreshStatus())
            .catch(toastError),
      },
      {
        id: 'gitDiscard',
        label: '変更を破棄',
        danger: true,
        action: () =>
          void api
            .gitDiscard(repoRoot, rel)
            .then(() => Promise.all([useGit.getState().refreshStatus(), useExplorer.getState().refresh()]))
            .catch(toastError),
      },
    ];
  };

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
    const isDir = entry.type === 'dir';
    // 外部ツール: 選択中のパス群 (複数可) を引数に起動。group 指定のものは各グループへ合流。
    // 表示条件用に選択エントリの種別/拡張子を渡す
    const selEntriesForTools = displayed.filter((d) => sel.includes(d.path));
    const tools = toolItems(
      sel,
      selEntriesForTools.map((d) => ({ kind: d.type === 'dir' ? 'dir' : 'file', ext: d.ext })),
    );

    // 「開く」系統をサブメニューにまとめる
    const openGroup: CfgMenuItem[] = [
      { id: 'open', label: '開く', action: () => selEntriesForTools.forEach(openWithDefault) },
      ...(isDir
        ? [
            // フォルダ: 対象フォルダ自体を別ウィンドウ (ブラウザの別タブ) で開く
            { id: 'openNewWindow', label: '別ウィンドウで開く', action: () => openInNewWindow(entry.path) },
            { separator: true },
            ...osMenuItems(entry.path),
          ]
        : [
            { id: 'openEditor', label: 'エディタで開く', action: () => openEntry(entry) },
            // ファイル: 同じフォルダを別ウィンドウで開いて対象にフォーカス
            { id: 'openNewWindow', label: '別ウィンドウで開く', action: () => openInNewWindow(path, entry.name) },
          ]),
      ...tools.take('開く'),
    ];

    // 「削除」系統
    const deleteGroup: CfgMenuItem[] = [
      { id: 'delete', label: 'ゴミ箱に移動', action: () => void deleteSelection(false) },
      { id: 'deletePermanent', label: '完全に削除', action: () => void deleteSelection(true), danger: true },
      ...tools.take('削除'),
    ];

    // 「Git」系統 (文脈依存項目 + リポジトリ操作)
    const gitGroup: CfgMenuItem[] = [
      ...gitContextItems(entry.path, !isDir, isDir),
      ...gitRepoItems(sel),
      ...tools.take('Git'),
    ];

    const items: CfgMenuItem[] = [
      { id: 'groupOpen', label: '開く', submenu: openGroup },
      // ピン止め / 解除のトグル (002.md §7.2)。解除は確認フローへ
      ...(isDir
        ? [
            pinned
              ? { id: 'pin', label: 'ピン止めを解除', action: () => void unpinFolder(entry.path, entry.name) }
              : {
                  id: 'pin',
                  label: 'クイックアクセスにピン止め',
                  action: () => void pinFolder(entry.path, entry.name),
                },
          ]
        : []),
      { separator: true },
      { id: 'copy', label: 'コピー', action: copySelection },
      { id: 'cut', label: '切り取り', action: cutSelection },
      {
        id: 'paste',
        label: '貼り付け',
        action: () => void paste(isDir ? entry.path : undefined),
        disabled: !clipboard,
      },
      { separator: true },
      { id: 'rename', label: '名前の変更 (F2)', action: () => setRenaming(entry.path), disabled: !single },
      { id: 'groupDelete', label: '削除', submenu: deleteGroup },
      { separator: true },
      { id: 'groupGit', label: 'Git', submenu: gitGroup },
      { separator: true },
      // 既定グループに属さないカスタム項目 (独自グループ / group 無し)
      ...tools.rest(),
      { separator: true },
      { id: 'properties', label: 'プロパティ', action: () => void showProperties(entry), disabled: !single },
    ];
    openMenu(e.clientX, e.clientY, pruneMenu(items));
  };

  const backgroundMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setSelection([]);
    // 空白 = カレントフォルダを対象とする (002.md §4.1 / §8)
    const currentPinned = useSettings.getState().isPinned(path);
    // 選択が無い場合は表示中のフォルダを引数に起動 (対象はフォルダ 1 件)
    const tools = toolItems([path], [{ kind: 'dir', ext: '' }]);

    const openGroup: CfgMenuItem[] = [
      // フォーカス無し: 表示中のフォルダを別ウィンドウで開く
      { id: 'openNewWindow', label: '別ウィンドウで開く', action: () => openInNewWindow(path) },
      { separator: true },
      ...osMenuItems(path),
      ...tools.take('開く'),
    ];
    const gitGroup: CfgMenuItem[] = [...gitContextItems(path, false, true), ...tools.take('Git')];

    const items: CfgMenuItem[] = [
      { id: 'newFolder', label: '新規フォルダ', action: () => void createFolder() },
      { id: 'newFile', label: '新規ファイル', action: () => void createFile() },
      { separator: true },
      { id: 'groupOpen', label: '開く', submenu: openGroup },
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
      { id: 'groupGit', label: 'Git', submenu: gitGroup },
      { separator: true },
      ...tools.rest(),
      { separator: true },
      { id: 'refresh', label: '最新の情報に更新', action: () => void useExplorer.getState().refresh() },
    ];
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
    className: `${selectedSet.has(entry.path) ? 'selected' : ''}${dropTarget === entry.path ? ' drop-target' : ''}${entry.hidden ? ' hidden-entry' : ''}`,
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
      {searchResults && (
        <div className={cx("search-banner")}>
          「{searchQuery}」の検索結果: {displayed.length} 件
        </div>
      )}
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
                <GitOverlay path={entry.path} dirCode={dirOverlay[entry.path]} />
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
        <div className={cx("empty-hint")}>{searchResults ? '該当なし' : 'このフォルダは空です'}</div>
      )}
    </div>
  );
}
