import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import '@xterm/xterm/css/xterm.css';
import { FloatingWindow } from '../../components/FloatingWindow';
import { DockBottomIcon, DockRightIcon, FloatIcon, TerminalIcon } from '../../components/DockIcons';
import { useContextMenu, type MenuItem } from '../../components/ContextMenu';
import { baseName } from '../../lib/paths';
import type { TerminalInfo } from '../../types';
import { closeTerminal, useTerminal, type TerminalPosition } from './terminalStore';
import {
  clearTerminal,
  copyTerminalSelection,
  fitActive,
  hasTerminalSelection,
  mountTerminals,
  pasteClipboard,
  selectAllTerminal,
} from './termManager';
import styles from './Terminal.module.scss';
import { createCssModuleClassNames } from '../../lib/cssModule';

const cx = createCssModuleClassNames(styles);

/**
 * アプリ内のターミナル。タブで複数のシェルを開き、表示位置は
 * 下パネル・右パネルへの固定 (TerminalPanel) か、フローティング (TerminalWindow) を選べる。
 */

/** フローティングで表示するとき (App の最後の方に置く) */
export function TerminalWindow() {
  const open = useTerminal((s) => s.open);
  const position = useTerminal((s) => s.position);
  if (!open || position !== 'float') return null;
  return (
    <FloatingWindow
      title={
        <span className={cx('title')}>
          <TerminalIcon /> ターミナル
        </span>
      }
      storageKey="terminal:rect"
      defaultRect={() => {
        const w = Math.min(900, innerWidth - 40);
        const h = Math.min(420, innerHeight - 80);
        return { x: Math.max(20, (innerWidth - w) / 2), y: innerHeight - h - 48, w, h };
      }}
      onClose={closeTerminal}
      headerExtra={<PositionButtons />}
    >
      <div className={cx('panel')}>
        <div className={cx('bar')}>
          <Tabs />
          <NewButtons />
        </div>
        <TerminalHost />
      </div>
    </FloatingWindow>
  );
}

/** 下パネル・右パネルに固定したとき (App のパネルに置く) */
export function TerminalPanel() {
  return (
    // パネル内のキー操作が背後の画面 (Alt+← 等のグローバルキー) へ伝わらないようにする
    <div className={cx('panel')} onKeyDown={(e) => e.stopPropagation()}>
      <div className={cx('bar')}>
        <span className={cx('bar-icon')} title="ターミナル">
          <TerminalIcon />
        </span>
        <Tabs />
        <NewButtons />
        <span className={cx('bar-sep')} />
        <PositionButtons />
        <button className={cx('title-btn close')} title="閉じる (Ctrl+`)" onClick={closeTerminal}>
          ✕
        </button>
      </div>
      <TerminalHost />
    </div>
  );
}

const POSITIONS: { pos: TerminalPosition; label: string; icon: () => JSX.Element }[] = [
  { pos: 'bottom', label: '下パネルに固定', icon: DockBottomIcon },
  { pos: 'right', label: '右パネルに固定', icon: DockRightIcon },
  { pos: 'float', label: 'フローティングで表示', icon: FloatIcon },
];

/** 表示位置の切り替え (下 / 右 / フローティング) */
function PositionButtons() {
  const position = useTerminal((s) => s.position);
  return (
    <span className={cx('positions')}>
      {POSITIONS.map(({ pos, label, icon: Icon }) => (
        <button
          key={pos}
          className={cx(`title-btn${pos === position ? ' active' : ''}`)}
          title={label}
          aria-pressed={pos === position}
          onClick={() => useTerminal.getState().setPosition(pos)}
        >
          <Icon />
        </button>
      ))}
    </span>
  );
}

function tabLabel(t: TerminalInfo): string {
  return t.name || baseName(t.cwd) || t.cwd;
}

/** ターミナルのタブ (クリックで切り替え、ダブルクリックで名前の変更、中クリック・✕ で終了) */
function Tabs() {
  const terminals = useTerminal((s) => s.terminals);
  const activeId = useTerminal((s) => s.activeId);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const activeRef = useRef<HTMLDivElement>(null);

  // 選んだタブが見えるようにスクロールする
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeId]);

  const openMenu = (e: React.MouseEvent, t: TerminalInfo) => {
    e.preventDefault();
    useContextMenu.getState().open(e.clientX, e.clientY, [
      { label: '名前の変更', action: () => setRenamingId(t.id) },
      { separator: true },
      { label: 'ターミナルを終了', danger: true, action: () => void useTerminal.getState().kill(t.id) },
    ]);
  };

  return (
    <div className={cx('tabs')} role="tablist">
      {terminals.map((t) => (
        <div
          key={t.id}
          ref={t.id === activeId ? activeRef : undefined}
          className={cx(`tab${t.id === activeId ? ' active' : ''}`)}
          role="tab"
          aria-selected={t.id === activeId}
          title={`${t.shellLabel}\n${t.cwd}`}
          onClick={() => useTerminal.getState().select(t.id)}
          onDoubleClick={() => setRenamingId(t.id)}
          onMouseDown={(e) => {
            if (e.button === 1) {
              e.preventDefault();
              void useTerminal.getState().kill(t.id);
            }
          }}
          onContextMenu={(e) => openMenu(e, t)}
        >
          {renamingId === t.id ? (
            <RenameInput terminal={t} onDone={() => setRenamingId(null)} />
          ) : (
            <>
              <span className={cx('tab-name')}>{tabLabel(t)}</span>
              <span className={cx('tab-shell')}>{t.shellLabel}</span>
            </>
          )}
          <button
            className={cx('tab-close')}
            title="ターミナルを終了"
            onClick={(e) => {
              e.stopPropagation();
              void useTerminal.getState().kill(t.id);
            }}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

function RenameInput({ terminal, onDone }: { terminal: TerminalInfo; onDone: () => void }) {
  const [value, setValue] = useState(tabLabel(terminal));
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.select(), []);
  const commit = () => {
    const name = value.trim();
    // 作業フォルダ名のままなら既定の表示名に戻す (フォルダ名を追従させる)
    const next = name === baseName(terminal.cwd) ? '' : name;
    if (next !== terminal.name) void useTerminal.getState().rename(terminal.id, next);
    onDone();
  };
  return (
    <input
      ref={ref}
      className={cx('tab-rename')}
      value={value}
      placeholder={baseName(terminal.cwd)}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') onDone();
      }}
    />
  );
}

/** 「＋」(既定のシェルで開く) と「▾」(シェルを選んで開く) */
function NewButtons() {
  const shells = useTerminal((s) => s.shells);
  const defaultShell = useTerminal((s) => s.defaultShell);
  const defaultLabel = shells.find((s) => s.id === defaultShell)?.label ?? shells[0]?.label ?? '';

  const openShellMenu = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const items: MenuItem[] = shells.map((s) => ({
      label: s.label,
      detail: s.id === defaultShell ? '既定 (設定の「ターミナル」で変更)' : undefined,
      action: () => void useTerminal.getState().create({ shellId: s.id }),
    }));
    useContextMenu.getState().open(r.left, r.bottom + 2, items);
  };

  return (
    <span className={cx('new-btns')}>
      <button
        className={cx('title-btn')}
        title={`新しいターミナル${defaultLabel ? ` (${defaultLabel})` : ''} — 表示中のフォルダで開きます`}
        onClick={() => void useTerminal.getState().create()}
      >
        ＋
      </button>
      <button className={cx('title-btn narrow')} title="シェルを選んで開く" onClick={openShellMenu}>
        ▾
      </button>
    </span>
  );
}

/** xterm の画面を置く領域。表示位置を変えたときは、新しい領域へ要素を付け替える */
function TerminalHost() {
  const ref = useRef<HTMLDivElement>(null);
  // 配列だと読み直すたびに別物になるので、id の並びで比べる
  const idsKey = useTerminal((s) => s.terminals.map((t) => t.id).join(','));
  const activeId = useTerminal((s) => s.activeId);
  const loaded = useTerminal((s) => s.loaded);
  // サーバが再起動したら、id が同じでも画面を作り直す
  const instance = useTerminal((s) => s.instance);
  const empty = idsKey === '';

  useLayoutEffect(() => {
    if (!ref.current) return;
    mountTerminals(ref.current, idsKey ? idsKey.split(',').map(Number) : [], activeId);
  }, [idsKey, activeId, instance]);

  // パネルの大きさを変えたら、ターミナルの桁数・行数を合わせる
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const id = useTerminal.getState().activeId;
        if (id !== null) fitActive(id);
      });
    });
    ro.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, []);

  const openMenu = (e: React.MouseEvent) => {
    if (activeId === null) return;
    e.preventDefault();
    const id = activeId;
    useContextMenu.getState().open(e.clientX, e.clientY, [
      { label: 'コピー', disabled: !hasTerminalSelection(id), action: () => copyTerminalSelection(id) },
      { label: '貼り付け', action: () => void pasteClipboard(id) },
      { label: 'すべて選択', action: () => selectAllTerminal(id) },
      { separator: true },
      { label: '画面をクリア', action: () => clearTerminal(id) },
    ]);
  };

  return (
    <div className={cx('host')} ref={ref} onContextMenu={openMenu}>
      {empty && (
        <div className={cx('empty')}>
          {loaded ? (
            <button className={cx('empty-btn')} onClick={() => void useTerminal.getState().create()}>
              ＋ 新しいターミナル
            </button>
          ) : (
            '読み込み中…'
          )}
        </div>
      )}
    </div>
  );
}
