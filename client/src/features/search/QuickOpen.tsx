import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { api } from '../../api/client';
import { useContextMenu } from '../../components/ContextMenu';
import { useEditor } from '../../stores/editor';
import { useGit } from '../../stores/git';
import { useIndexStatus } from '../../stores/searchIndex';
import { useSettings } from '../../stores/settings';
import { appTabId, isQuickOpenKey, type AppTabWindow } from '../../lib/appTabs';
import { isDialogOpen } from '../../lib/dialogKeys';
import { openWithDefault } from '../../lib/fileOps';
import { fileIcon, joinPath, relativeTo } from '../../lib/paths';
import { fileEntryOf } from './fileEntry';
import { openIndexDialog } from './IndexControls';
import { closeCommandPalette } from '../palette/CommandPalette';
import paletteStyles from '../palette/CommandPalette.module.scss';
import styles from './Search.module.scss';
import { createCssModuleClassNames } from '../../lib/cssModule';

const cx = createCssModuleClassNames(styles, paletteStyles);

/**
 * クイックオープン (VSCode の Ctrl+P と同様)。Ctrl+P / Ctrl+Shift+R (mac は ⌘) で開き、
 * インデックスしたリポジトリのファイルを名前のあいまい一致で絞り込んで開く。
 * 「名前:行」(app.ts:42) と打つとその行を開く。入力が空のときは最近開いたファイルを出す。
 */

interface QuickOpenStore {
  open: boolean;
  /** 開く前にフォーカスがあった要素 (取り消しで閉じたら戻す) */
  restore: Element | null;
}

const useQuickOpen = create<QuickOpenStore>(() => ({ open: false, restore: null }));

export function openQuickOpen(): void {
  if (isDialogOpen()) return;
  useContextMenu.getState().close();
  closeCommandPalette();
  const { open } = useQuickOpen.getState();
  useQuickOpen.setState({ open: true, ...(open ? {} : { restore: document.activeElement }) });
}

interface Row {
  /** リポジトリからの相対パス */
  path: string;
  indices: number[];
}

/** 「名前:行:桁」を分ける */
function parseQuery(input: string): { text: string; line: number | null; column: number | null } {
  const m = /^(.*?):(\d+)(?::(\d+))?$/.exec(input.trim());
  if (!m) return { text: input.trim(), line: null, column: null };
  return { text: m[1], line: Number(m[2]), column: m[3] ? Number(m[3]) : null };
}

function Highlight({ text, offset, indices }: { text: string; offset: number; indices: Set<number> }) {
  const parts: JSX.Element[] = [];
  let i = 0;
  while (i < text.length) {
    const on = indices.has(i + offset);
    let j = i;
    while (j < text.length && indices.has(j + offset) === on) j++;
    const s = text.slice(i, j);
    parts.push(on ? <mark key={i} className={cx('cp-hit')}>{s}</mark> : <Fragment key={i}>{s}</Fragment>);
    i = j;
  }
  return <>{parts}</>;
}

export function QuickOpen() {
  const open = useQuickOpen((s) => s.open);

  // キャプチャで拾い、Monaco などフォーカス中の要素より先に受け取る。
  // Ctrl+P はリポジトリの外でも受け取って案内を出す (ブラウザの印刷を開かない)。
  // Ctrl+Shift+R はリポジトリの外ではブラウザの既定 (キャッシュを使わない再読み込み) のまま
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isQuickOpenKey(e)) return;
      if (e.shiftKey && !useGit.getState().repoRoot) return;
      e.preventDefault();
      e.stopPropagation();
      openQuickOpen();
    };
    window.addEventListener('keydown', onKey, true);
    if (appTabId) (window as AppTabWindow).ebOpenQuickOpen = openQuickOpen;
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  if (!open) return null;
  return <QuickOpenBody />;
}

function QuickOpenBody() {
  const repo = useGit((s) => s.repoRoot);
  const status = useIndexStatus(repo);
  const recents = useSettings((s) => s.recents);
  const [input, setInput] = useState('');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const enabled = status?.enabled === true;
  const { text, line, column } = parseQuery(input);

  useEffect(() => inputRef.current?.focus(), []);

  // 入力が空なら最近開いたファイル (このリポジトリの中のもの)
  const recentRows = useMemo<Row[]>(() => {
    if (!repo) return [];
    return recents
      .filter((r) => r.kind === 'file')
      .map((r) => relativeTo(r.path, repo))
      .filter((p): p is string => !!p)
      .slice(0, 20)
      .map((p) => ({ path: p, indices: [] }));
  }, [recents, repo]);

  useEffect(() => {
    if (!repo || !enabled || !text.trim()) {
      setRows(null);
      return;
    }
    const ctl = new AbortController();
    const t = setTimeout(() => {
      api
        .searchIndexFiles(repo, text, 50, ctl.signal)
        .then((r) => setRows(r.items.map((it) => ({ path: it.path, indices: it.indices }))))
        .catch(() => {
          // 取り消し (次の入力) は無視し、失敗なら「一致なし」にする (「検索中…」のまま残さない)
          if (!ctl.signal.aborted) setRows([]);
        });
    }, 40);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [repo, enabled, text]);

  const shown = text.trim() ? (rows ?? []) : recentRows;

  useEffect(() => setActive(0), [rows, text]);

  useEffect(() => {
    const el = listRef.current?.children[active];
    if (el instanceof HTMLElement) el.scrollIntoView({ block: 'nearest' });
  }, [active, shown]);

  const close = () => useQuickOpen.setState({ open: false });

  const cancel = () => {
    const prev = useQuickOpen.getState().restore;
    close();
    if (prev instanceof HTMLElement && prev.isConnected) prev.focus();
  };

  const choose = (row: Row | undefined) => {
    if (!row || !repo) return;
    close();
    const abs = joinPath(repo, row.path);
    if (line !== null) void useEditor.getState().openAt(abs, line, column ?? 1);
    else openWithDefault(fileEntryOf(abs));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const move = (delta: number) => {
      e.preventDefault();
      if (shown.length > 0) setActive((i) => (i + delta + shown.length) % shown.length);
    };
    switch (e.key) {
      case 'ArrowDown':
        move(1);
        break;
      case 'ArrowUp':
        move(-1);
        break;
      case 'Enter':
        e.preventDefault();
        choose(shown[active]);
        break;
      case 'Escape':
        e.preventDefault();
        cancel();
        break;
      default:
        return;
    }
    e.stopPropagation();
  };

  if (!repo) {
    return (
      <div className={cx('cp-layer')} onMouseDown={cancel}>
        <div
          className={cx('cp-box')}
          onMouseDown={(e) => e.stopPropagation()}
          // 案内だけなので、どのキーでも閉じる (フォーカスは枠に置く)
          tabIndex={-1}
          ref={(el) => el?.focus()}
          onKeyDown={(e) => {
            e.preventDefault();
            cancel();
          }}
        >
          <div className={cx('cp-empty')}>
            ファイル名での検索 (Ctrl+P) は、検索インデックスを有効にした Git リポジトリの中で使えます。
          </div>
        </div>
      </div>
    );
  }

  const emptyText = () => {
    if (!status) return '読み込み中…';
    if (text.trim()) return rows === null ? '検索中…' : '一致するファイルはありません';
    return 'ファイル名を入力 (「名前:行」でその行を開く)';
  };

  return (
    <div className={cx('cp-layer')} onMouseDown={cancel}>
      <div className={cx('cp-box')} onMouseDown={(e) => e.stopPropagation()}>
        {enabled && status?.state === 'building' && (
          <div className={cx('cp-title')}>
            インデックスの作成中のため、まだ見つからないファイルがあります
          </div>
        )}
        <input
          ref={inputRef}
          className={cx('cp-input')}
          value={input}
          placeholder="ファイル名で検索 (「名前:行」でその行へ)"
          spellCheck={false}
          autoComplete="off"
          role="combobox"
          aria-expanded="true"
          aria-controls="quick-open-list"
          aria-activedescendant={shown[active] ? `qo-item-${active}` : undefined}
          disabled={!enabled}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {status && !enabled ? (
          <div className={cx('qo-disabled')}>
            <span>このリポジトリは検索インデックスが無効です。有効にするとファイル名で開けるようになります。</span>
            <button
              className={cx('btn primary')}
              onClick={() => {
                close();
                openIndexDialog(repo);
              }}
            >
              有効にする…
            </button>
          </div>
        ) : (
          <div ref={listRef} id="quick-open-list" className={cx('cp-list')} role="listbox">
            {!text.trim() && shown.length > 0 && <div className={cx('qo-section')}>最近開いたファイル</div>}
            {shown.map((row, i) => {
              const slash = row.path.lastIndexOf('/');
              const name = row.path.slice(slash + 1);
              const dir = slash >= 0 ? row.path.slice(0, slash) : '';
              const hit = new Set(row.indices);
              return (
                <div
                  key={row.path}
                  id={`qo-item-${i}`}
                  role="option"
                  aria-selected={i === active}
                  className={cx(`cp-item qo-item${i === active ? ' active' : ''}`)}
                  title={row.path}
                  onMouseMove={() => i !== active && setActive(i)}
                  onClick={() => choose(row)}
                >
                  <span className={cx('icon')}>{fileIcon(fileEntryOf(name))}</span>
                  <span className={cx('cp-label')}>
                    <Highlight text={name} offset={slash + 1} indices={hit} />
                  </span>
                  <span className={cx('cp-detail qo-dir')}>
                    <Highlight text={dir} offset={0} indices={hit} />
                  </span>
                </div>
              );
            })}
            {shown.length === 0 && <div className={cx('cp-empty')}>{emptyText()}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
