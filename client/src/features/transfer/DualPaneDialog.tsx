import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { api } from '../../api/client';
import { useExplorer } from '../../stores/explorer';
import { useSettings, isMod } from '../../stores/settings';
import { toastError } from '../../stores/toast';
import { relocatedPath } from '../../stores/editor';
import { breadcrumbs, fileIcon, isRootPath, parentPath } from '../../lib/paths';
import { sortEntries } from '../../lib/entrySort';
import { useDialogKeys } from '../../lib/dialogKeys';
import { openTransferConfirm } from './TransferConfirmDialog';
import type { FsEntry, TransferOp } from '../../types';
import styles from './Transfer.module.scss';
import { createCssModuleClassNames } from '../../lib/cssModule';

const cx = createCssModuleClassNames(styles);

type Side = 'left' | 'right';

/** 右ペインで最後に開いていたフォルダ (次回の初期表示) */
const RIGHT_PATH_KEY = 'dualPane.rightPath';

function loadRightPath(): string | null {
  try {
    return localStorage.getItem(RIGHT_PATH_KEY);
  } catch {
    return null;
  }
}

function saveRightPath(p: string): void {
  try {
    localStorage.setItem(RIGHT_PATH_KEY, p);
  } catch {
    /* 保存できなくても動作には影響しない */
  }
}

interface DualPaneStore {
  open: boolean;
  left: string;
  right: string;
  /** 左ペインで最初に選択しておく項目 */
  leftSelection: string[];
  close: () => void;
}

const useDualPane = create<DualPaneStore>((set) => ({
  open: false,
  left: '',
  right: '',
  leftSelection: [],
  close: () => set({ open: false }),
}));

/**
 * 「2 画面で整理」ダイアログを開く。
 * 左は指定フォルダ (省略時はファイル一覧で表示中のフォルダ。そのときは一覧の選択も引き継ぐ)、
 * 右は指定フォルダ (省略時は前回右で開いていたフォルダ)。
 */
export function openDualPane(opts: { left?: string; right?: string } = {}): void {
  const ex = useExplorer.getState();
  const left = opts.left ?? ex.path;
  useDualPane.setState({
    open: true,
    left,
    right: opts.right ?? loadRightPath() ?? left,
    leftSelection: left === ex.path && !ex.searchResults ? ex.selection : [],
  });
}

/** p が root 自身またはその配下か (Windows のドライブパスは大文字小文字を区別しない) */
function isSameOrUnder(p: string, root: string): boolean {
  return relocatedPath(p, root, root) !== null;
}

/** ドラッグ中の項目 (ダイアログ内で完結するので、dragover 中も中身を見て可否を判定できる) */
interface DragInfo {
  paths: string[];
  srcDir: string;
}

/** destDir へドロップできるか: ドラッグ元と同じフォルダ、自分自身・自分の配下へは落とせない */
function canDrop(d: DragInfo | null, destDir: string): boolean {
  if (!d || !destDir) return false;
  if (isSameOrUnder(d.srcDir, destDir) && isSameOrUnder(destDir, d.srcDir)) return false;
  return !d.paths.some((p) => isSameOrUnder(destDir, p));
}

/** 複数項目をドラッグするときのドラッグ画像 (「3 項目」) */
function setCountDragImage(e: React.DragEvent, count: number): void {
  if (count < 2) return;
  const ghost = document.createElement('div');
  ghost.textContent = `📄 ${count} 項目`;
  ghost.className = cx('drag-ghost');
  document.body.appendChild(ghost);
  e.dataTransfer.setDragImage(ghost, 12, 12);
  setTimeout(() => ghost.remove(), 0);
}

/** ペイン 1 つ分の状態 (フォルダ・一覧・選択・ペイン内の戻る履歴) */
function usePane() {
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [selection, setSelection] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const seq = useRef(0);
  const pathRef = useRef(path);
  pathRef.current = path;

  /** フォルダを開く。push=true なら今のフォルダを戻る履歴に積む。select で開いた後の選択を指定 */
  const navigate = async (target: string, push = true, select: string[] = []) => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const r = await api.list(target);
      if (mine !== seq.current) return;
      const prev = pathRef.current;
      if (push && prev && prev !== r.path) setHistory((h) => [...h, prev]);
      setPath(r.path);
      setEntries(r.entries);
      const alive = new Set(r.entries.map((e) => e.path));
      const sel = select.filter((p) => alive.has(p));
      setSelection(sel);
      setAnchor(sel[sel.length - 1] ?? null);
    } catch (e) {
      if (mine === seq.current) toastError(e);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  };

  /** 今のフォルダを読み直す (選択は残っている項目だけ維持) */
  const refresh = async () => {
    const target = pathRef.current;
    if (!target) return;
    const mine = ++seq.current;
    try {
      const r = await api.list(target);
      if (mine !== seq.current) return;
      setEntries(r.entries);
      const alive = new Set(r.entries.map((e) => e.path));
      setSelection((s) => s.filter((p) => alive.has(p)));
      setAnchor((a) => (a && alive.has(a) ? a : null));
    } catch (e) {
      if (mine === seq.current) toastError(e);
    }
  };

  const back = () => {
    const prev = history[history.length - 1];
    if (!prev) return;
    setHistory((h) => h.slice(0, -1));
    void navigate(prev, false, [pathRef.current]);
  };

  const up = () => {
    if (!path || isRootPath(path)) return;
    // 上へ移動したら、今いたフォルダを選択しておく (Windows と同じ)
    void navigate(parentPath(path), true, [path]);
  };

  return {
    path,
    entries,
    loading,
    selection,
    anchor,
    canBack: history.length > 0,
    editing,
    setEditing,
    setSelection: (sel: string[], a?: string | null) => {
      setSelection(sel);
      if (a !== undefined) setAnchor(a);
    },
    /** ダイアログを開き直したとき用: 前回の戻る履歴・入力状態を捨てる */
    reset: () => {
      setHistory([]);
      setEditing(false);
    },
    navigate,
    refresh,
    back,
    up,
  };
}

type PaneState = ReturnType<typeof usePane>;
type DropProps = (destDir: string, key: string) => {
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
};

export function DualPaneDialog() {
  const { open, left: initLeft, right: initRight, leftSelection, close } = useDualPane();
  const settings = useSettings((s) => s.settings);
  const left = usePane();
  const right = usePane();
  const panes: Record<Side, PaneState> = { left, right };
  const [active, setActive] = useState<Side>('left');
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const drag = useRef<DragInfo | null>(null);
  const listRefs = useRef<Record<Side, HTMLDivElement | null>>({ left: null, right: null });

  useEffect(() => {
    if (!open) return;
    left.reset();
    right.reset();
    void left.navigate(initLeft, false, leftSelection);
    void right.navigate(initRight, false);
    setActive('left');
    setTimeout(() => listRefs.current.left?.focus(), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 右ペインのフォルダは次回の初期表示のために覚えておく
  useEffect(() => {
    if (open && right.path) saveRightPath(right.path);
  }, [open, right.path]);

  const displayed = (pane: PaneState) =>
    sortEntries(pane.entries, settings.sortKey, settings.sortAsc, settings.showHidden);
  const leftShown = useMemo(() => displayed(left), [left.entries, settings]); // eslint-disable-line react-hooks/exhaustive-deps
  const rightShown = useMemo(() => displayed(right), [right.entries, settings]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown: Record<Side, FsEntry[]> = { left: leftShown, right: rightShown };

  const other = (side: Side): Side => (side === 'left' ? 'right' : 'left');
  const anyEditing = left.editing || right.editing;

  /** 確認ダイアログを経てコピー / 移動し、両ペインを読み直す */
  const transfer = async (src: string[], destDir: string, op: TransferOp) => {
    if (src.length === 0 || busy) return;
    setBusy(true);
    try {
      const results = await openTransferConfirm({ src, destDir, op });
      if (results) await Promise.all([left.refresh(), right.refresh()]);
    } finally {
      setBusy(false);
      listRefs.current[active]?.focus();
    }
  };

  /** F5 / F6・ボタン: アクティブなペインの選択を反対側のフォルダへ */
  const transferToOther = (side: Side, op: TransferOp) => {
    const dest = panes[other(side)].path;
    void transfer(panes[side].selection, dest, op);
  };

  // --- D&D ---
  const dragOver = (e: React.DragEvent, destDir: string, key: string) => {
    e.stopPropagation();
    if (!canDrop(drag.current, destDir)) {
      e.dataTransfer.dropEffect = 'none';
      setDropTarget(null);
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = e.ctrlKey || e.metaKey ? 'copy' : 'move';
    setDropTarget(key);
  };

  const dragLeave = (e: React.DragEvent, key: string) => {
    // 子要素への出入りでは消さない (ハイライトのちらつき防止)
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDropTarget((t) => (t === key ? null : t));
  };

  const drop = (e: React.DragEvent, destDir: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    const d = drag.current;
    drag.current = null;
    if (!d || !canDrop(d, destDir)) return;
    void transfer(d.paths, destDir, e.ctrlKey || e.metaKey ? 'copy' : 'move');
  };

  /** ドロップ先として受け付ける要素の props */
  const dropProps = (destDir: string, key: string) => ({
    onDragOver: (e: React.DragEvent) => dragOver(e, destDir, key),
    onDragLeave: (e: React.DragEvent) => dragLeave(e, key),
    onDrop: (e: React.DragEvent) => drop(e, destDir),
  });

  const dialogRef = useDialogKeys({
    enabled: open,
    // アドレス入力中の Escape は入力の取り消しに使う
    onEscape: anyEditing || busy ? null : close,
  });

  if (!open) return null;

  const renderPane = (side: Side) => {
    const pane = panes[side];
    const list = shown[side];
    const selected = new Set(pane.selection);
    const paneKey = `@pane:${side}`;

    const click = (e: React.MouseEvent, entry: FsEntry) => {
      if (e.shiftKey && pane.anchor) {
        const ai = list.findIndex((d) => d.path === pane.anchor);
        const bi = list.findIndex((d) => d.path === entry.path);
        if (ai >= 0 && bi >= 0) {
          const [lo, hi] = ai < bi ? [ai, bi] : [bi, ai];
          pane.setSelection(list.slice(lo, hi + 1).map((d) => d.path));
          return;
        }
      }
      if (isMod(e)) {
        pane.setSelection(
          selected.has(entry.path) ? pane.selection.filter((p) => p !== entry.path) : [...pane.selection, entry.path],
          entry.path,
        );
        return;
      }
      pane.setSelection([entry.path], entry.path);
    };

    const openEntryInPane = (entry: FsEntry) => {
      // 整理専用なのでファイルは開かない (エディタはダイアログの後ろに隠れるため)
      if (entry.type === 'dir' || entry.type === 'symlink') void pane.navigate(entry.path);
    };

    const moveCursor = (delta: number, extend: boolean) => {
      if (list.length === 0) return;
      const cur = pane.anchor ? list.findIndex((d) => d.path === pane.anchor) : -1;
      const next = Math.max(0, Math.min(list.length - 1, cur < 0 ? 0 : cur + delta));
      const target = list[next];
      if (extend && pane.anchor && cur >= 0) {
        // Shift: 起点 (選択の先頭) から対象まで
        const startPath = pane.selection[0] ?? pane.anchor;
        const si = Math.max(0, list.findIndex((d) => d.path === startPath));
        const [lo, hi] = si < next ? [si, next] : [next, si];
        const range = list.slice(lo, hi + 1).map((d) => d.path);
        pane.setSelection(si <= next ? range : range.reverse(), target.path);
      } else {
        pane.setSelection([target.path], target.path);
      }
      listRefs.current[side]
        ?.querySelector(`[data-pane-path="${CSS.escape(target.path)}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    };

    const keyDown = (e: React.KeyboardEvent) => {
      if (busy) return;
      const k = e.key;
      let handled = true;
      if (k === 'F5') transferToOther(side, 'copy');
      else if (k === 'F6') transferToOther(side, 'move');
      else if (k === 'ArrowDown') moveCursor(1, e.shiftKey);
      else if (k === 'ArrowUp' && e.altKey) pane.up();
      else if (k === 'ArrowUp') moveCursor(-1, e.shiftKey);
      else if (k === 'ArrowLeft' && e.altKey) pane.back();
      else if (k === 'Home') moveCursor(-list.length, e.shiftKey);
      else if (k === 'End') moveCursor(list.length, e.shiftKey);
      else if (k === 'Backspace') pane.up();
      else if (k === 'Enter') {
        const entry = list.find((d) => d.path === pane.anchor);
        if (entry) openEntryInPane(entry);
      } else if (isMod(e) && (k === 'a' || k === 'A')) pane.setSelection(list.map((d) => d.path));
      else if (k === 'Tab' && !e.shiftKey && !isMod(e)) {
        setActive(other(side));
        listRefs.current[other(side)]?.focus();
      } else handled = false;
      if (handled) e.preventDefault();
    };

    return (
      <div
        className={cx(`pane${active === side ? ' active' : ''}${dropTarget === paneKey ? ' drop-target' : ''}`)}
        onMouseDown={() => setActive(side)}
        {...dropProps(pane.path, paneKey)}
      >
        <PaneHeader pane={pane} side={side} dropTarget={dropTarget} dropProps={dropProps} />
        <div
          ref={(el) => {
            listRefs.current[side] = el;
          }}
          className={cx('pane-list')}
          tabIndex={0}
          onFocus={() => setActive(side)}
          onKeyDown={keyDown}
          onClick={(e) => {
            if (e.target === e.currentTarget) pane.setSelection([], null);
          }}
        >
          {list.map((entry) => {
            const isDir = entry.type === 'dir';
            return (
              <div
                key={entry.path}
                data-pane-path={entry.path}
                className={cx(
                  `pane-row${selected.has(entry.path) ? ' selected' : ''}${dropTarget === entry.path ? ' drop-target' : ''}${entry.hidden ? ' hidden-entry' : ''}`,
                )}
                title={entry.name}
                draggable
                onClick={(e) => click(e, entry)}
                onDoubleClick={() => openEntryInPane(entry)}
                onDragStart={(e) => {
                  const paths = selected.has(entry.path) ? pane.selection : [entry.path];
                  if (!selected.has(entry.path)) pane.setSelection([entry.path], entry.path);
                  drag.current = { paths, srcDir: pane.path };
                  e.dataTransfer.setData('application/x-entries', JSON.stringify(paths));
                  e.dataTransfer.effectAllowed = 'copyMove';
                  setCountDragImage(e, paths.length);
                }}
                onDragEnd={() => {
                  drag.current = null;
                  setDropTarget(null);
                }}
                {...(isDir ? dropProps(entry.path, entry.path) : {})}
              >
                <span className={cx('pane-icon')}>{fileIcon(entry)}</span>
                <span className={cx('pane-name')}>{entry.name}</span>
              </div>
            );
          })}
          {!pane.loading && list.length === 0 && <div className={cx('pane-empty')}>このフォルダは空です</div>}
        </div>
        <div className={cx('pane-status')}>
          {list.length} 項目{pane.selection.length > 0 ? ` / ${pane.selection.length} 項目を選択` : ''}
        </div>
      </div>
    );
  };

  const activeSel = panes[active].selection.length;
  const arrow = active === 'left' ? '→' : '←';

  return (
    <div
      ref={dialogRef}
      className={cx('dialog-backdrop')}
      // ダイアログ内のキー操作が背後の画面 (Alt+← 等のグローバルキー) へ伝わらないようにする
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className={cx('dialog dual-dialog')}>
        <div className={cx('dual-title')}>
          <span className={cx('dialog-title')}>2 画面で整理</span>
          <span className={cx('dual-hint')}>
            ドラッグ&ドロップで反対側のフォルダやフォルダ行へ (Ctrl でコピー)。実行前に確認します
          </span>
          <button className={cx('dual-close')} title="閉じる (Esc)" onClick={close}>
            ✕
          </button>
        </div>
        <PanelGroup direction="horizontal" autoSaveId="dual-pane-split" className={cx('dual-split')}>
          <Panel minSize={20} defaultSize={50}>
            {renderPane('left')}
          </Panel>
          <PanelResizeHandle className={cx('dual-resize')} />
          <Panel minSize={20} defaultSize={50}>
            {renderPane('right')}
          </Panel>
        </PanelGroup>
        <div className={cx('dual-footer')}>
          <span className={cx('confirm-dim')}>
            {activeSel > 0 ? `選択中の ${activeSel} 項目を ${arrow} 反対側へ:` : '項目を選択すると反対側へ送れます'}
          </span>
          <button
            className={cx('btn')}
            disabled={activeSel === 0 || busy}
            onClick={() => transferToOther(active, 'copy')}
          >
            {arrow} コピー (F5)
          </button>
          <button
            className={cx('btn')}
            disabled={activeSel === 0 || busy}
            onClick={() => transferToOther(active, 'move')}
          >
            {arrow} 移動 (F6)
          </button>
          <span className={cx('dual-spacer')} />
          <button
            className={cx('btn')}
            title="両方の一覧を読み直す"
            onClick={() => void Promise.all([left.refresh(), right.refresh()])}
          >
            更新
          </button>
          <button className={cx('btn')} onClick={close}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}

/** ペイン上部: 戻る / 上へ + パンくず (クリックでアドレス入力。各階層はドロップ先にもなる) */
function PaneHeader({
  pane,
  side,
  dropTarget,
  dropProps,
}: {
  pane: PaneState;
  side: Side;
  dropTarget: string | null;
  dropProps: DropProps;
}) {
  const [value, setValue] = useState(pane.path);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (pane.editing) inputRef.current?.select();
  }, [pane.editing]);

  const submit = () => {
    pane.setEditing(false);
    const v = value.trim().replace(/\\/g, '/');
    if (v && v !== pane.path) void pane.navigate(v);
  };

  return (
    <div className={cx('pane-header')}>
      <button className={cx('pane-btn')} title="戻る (Alt+←)" disabled={!pane.canBack} onClick={pane.back}>
        ←
      </button>
      <button
        className={cx('pane-btn')}
        title="上の階層へ (Alt+↑ / Backspace)"
        disabled={!pane.path || isRootPath(pane.path)}
        onClick={pane.up}
      >
        ↑
      </button>
      <div
        className={cx('pane-address')}
        onClick={() => {
          if (pane.editing) return;
          setValue(pane.path);
          pane.setEditing(true);
        }}
      >
        {pane.editing ? (
          <input
            ref={inputRef}
            className={cx('pane-address-input')}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onBlur={submit}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') submit();
              if (e.key === 'Escape') pane.setEditing(false);
            }}
          />
        ) : (
          breadcrumbs(pane.path).map((c, i, arr) => (
            <span key={c.path} className={cx('pane-crumb-wrap')}>
              <button
                className={cx(`pane-crumb${dropTarget === `@crumb:${side}:${c.path}` ? ' drop-target' : ''}`)}
                {...dropProps(c.path, `@crumb:${side}:${c.path}`)}
                onClick={(e) => {
                  e.stopPropagation();
                  void pane.navigate(c.path);
                }}
              >
                {c.name}
              </button>
              {i < arr.length - 1 && <span className={cx('pane-crumb-sep')}>›</span>}
            </span>
          ))
        )}
      </div>
    </div>
  );
}
