import { useEffect, useRef, useState } from 'react';
import { useExplorer } from '../stores/explorer';
import { useSearch, relativeTo, SEARCH_LIMIT } from '../stores/search';
import { useSideBar } from '../stores/sideBar';
import { useSettings } from '../stores/settings';
import { switchView } from '../stores/ui';
import { useContextMenu } from '../components/ContextMenu';
import { openWithDefault } from '../lib/fileOps';
import { copyText } from '../lib/clipboard';
import { baseName, fileIcon, parentPath } from '../lib/paths';
import type { FsEntry } from '../types';
import styles from './SearchPanel.module.scss';
import { createCssModuleClassNames } from '../lib/cssModule';

const cx = createCssModuleClassNames(styles);

/** 一覧 (ファイルタブ) で entry の場所を表示する: 親フォルダへ移動して entry を選ぶ */
async function reveal(entry: FsEntry): Promise<void> {
  const dir = parentPath(entry.path);
  const ex = useExplorer.getState();
  if (ex.path !== dir) await ex.navigate(dir);
  else switchView('files');
  useExplorer.getState().setSelection([entry.path], entry.path);
  requestAnimationFrame(() => {
    document.querySelector(`[data-entry-path="${CSS.escape(entry.path)}"]`)?.scrollIntoView({ block: 'nearest' });
  });
}

/**
 * 左パネルの検索: 表示中のフォルダ以下を名前で検索し、結果をファイル名 + 相対パスで一覧にする。
 * クリックで一覧 (ファイルタブ) のその場所を表示、ダブルクリック / Enter で開く。
 */
export function SearchPanel() {
  const path = useExplorer((s) => s.path);
  const { input, query, root, results, loading, setInput, run, clear } = useSearch();
  const showHidden = useSettings((s) => s.settings.showHidden);
  const focusSeq = useSideBar((s) => s.focusSearchSeq);
  const openMenu = useContextMenu((s) => s.open);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<string | null>(null);

  // レーンのアイコン等で検索を開いたら入力欄へフォーカス
  useEffect(() => {
    if (focusSeq === 0) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusSeq]);

  useEffect(() => setSelected(null), [results]);

  const shown = (results ?? []).filter((e) => showHidden || !e.hidden);

  const menu = (e: React.MouseEvent, entry: FsEntry) => {
    e.preventDefault();
    setSelected(entry.path);
    const rel = root ? relativeTo(entry.path, root) : entry.path;
    openMenu(e.clientX, e.clientY, [
      { label: '開く', action: () => openWithDefault(entry) },
      { label: 'フォルダ内に表示', action: () => void reveal(entry) },
      { separator: true },
      { label: 'パスをコピー', detail: entry.path, action: () => void copyText(entry.path) },
      { label: '相対パスをコピー', detail: rel, action: () => void copyText(rel) },
    ]);
  };

  const onListKey = (e: React.KeyboardEvent) => {
    if (shown.length === 0) return;
    const idx = shown.findIndex((x) => x.path === selected);
    const move = (i: number) => {
      const next = shown[Math.max(0, Math.min(shown.length - 1, i))];
      setSelected(next.path);
      document
        .querySelector(`[data-search-path="${CSS.escape(next.path)}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    };
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(idx + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(idx < 0 ? 0 : idx - 1);
    } else if (e.key === 'Enter' && idx >= 0) {
      e.preventDefault();
      openWithDefault(shown[idx]);
    }
  };

  return (
    <div className={cx('search-panel')}>
      <div className={cx('heading')}>検索</div>
      <div className={cx('input-row')}>
        <input
          ref={inputRef}
          className={cx('input')}
          placeholder="名前で検索 (Enter)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void run(path, input);
            if (e.key === 'Escape') clear();
            if (e.key === 'ArrowDown' && shown.length > 0) {
              e.preventDefault();
              setSelected(shown[0].path);
              listRef.current?.focus();
            }
          }}
        />
        {(input || results) && (
          <button className={cx('clear-btn')} title="検索をクリア (Esc)" onClick={() => clear()}>
            ✕
          </button>
        )}
      </div>
      <div className={cx('scope')} title={root ?? path}>
        対象: {baseName(root ?? path) || (root ?? path)}
        {root && root !== path && (
          <button className={cx('rerun')} title={`表示中のフォルダ (${path}) で検索し直す`} onClick={() => void run(path, query)}>
            表示中のフォルダで再検索
          </button>
        )}
      </div>
      {results && (
        <div className={cx('summary')}>
          {loading
            ? '検索中…'
            : `「${query}」: ${shown.length} 件${results.length >= SEARCH_LIMIT ? ` (上限 ${SEARCH_LIMIT} 件まで表示)` : ''}`}
          {!loading && root && (
            <button className={cx('rerun')} title="同じ条件で検索し直す" onClick={() => void run(root, query)}>
              ↻
            </button>
          )}
        </div>
      )}
      {!results && loading && <div className={cx('summary')}>検索中…</div>}
      <div ref={listRef} className={cx('results')} tabIndex={0} onKeyDown={onListKey}>
        {shown.map((entry) => {
          // 名前の横に、検索したフォルダからの相対パス (どのフォルダにあるか) を出す
          const dir = parentPath(entry.path);
          const relDir = root ? relativeTo(dir, root) : dir;
          return (
            <div
              key={entry.path}
              data-search-path={entry.path}
              className={cx(`result${selected === entry.path ? ' selected' : ''}`)}
              title={entry.path}
              onClick={() => {
                setSelected(entry.path);
                void reveal(entry);
              }}
              onDoubleClick={() => openWithDefault(entry)}
              onContextMenu={(e) => menu(e, entry)}
            >
              <span className={cx('icon')}>{fileIcon(entry)}</span>
              <span className={cx('text')}>
                <span className={cx('name')}>{entry.name}</span>
                <span className={cx('rel')}>{relDir ? `${relDir}/` : './'}</span>
              </span>
            </div>
          );
        })}
        {results && !loading && shown.length === 0 && <div className={cx('empty')}>該当なし</div>}
      </div>
    </div>
  );
}
