import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useContentSearch, CONTENT_SEARCH_LIMIT, useIndexStatus } from '../../stores/searchIndex';
import { useEditor } from '../../stores/editor';
import { useExplorer } from '../../stores/explorer';
import { useSideBar } from '../../stores/sideBar';
import { switchView } from '../../stores/ui';
import { useContextMenu } from '../../components/ContextMenu';
import { Chevron } from '../../app/FolderTree';
import { copyText } from '../../lib/clipboard';
import { fileIcon, joinPath, parentPath } from '../../lib/paths';
import { fileEntryOf } from './fileEntry';
import { IndexStatusBar } from './IndexControls';
import type { ContentFileResult, ContentMatchLine } from '../../types';
import styles from './Search.module.scss';
import { createCssModuleClassNames } from '../../lib/cssModule';

const cx = createCssModuleClassNames(styles);

/** 入力が止まってから検索するまでの待ち時間 */
const DEBOUNCE_MS = 250;

/** 一覧 (ファイルタブ) でファイルの場所を表示する: 親フォルダへ移動して選ぶ */
async function reveal(abs: string): Promise<void> {
  const dir = parentPath(abs);
  const ex = useExplorer.getState();
  if (ex.path !== dir) await ex.navigate(dir);
  else switchView('files');
  useExplorer.getState().setSelection([abs], abs);
  requestAnimationFrame(() => {
    document.querySelector(`[data-entry-path="${CSS.escape(abs)}"]`)?.scrollIntoView({ block: 'nearest' });
  });
}

function openMatch(repo: string, file: ContentFileResult, m: ContentMatchLine): void {
  void useEditor.getState().openAt(joinPath(repo, file.path), m.line, m.column, m.endColumn);
}

/** 一致した範囲を強調した行 */
function MatchText({ text, ranges }: { text: string; ranges: [number, number][] }) {
  const parts: JSX.Element[] = [];
  let pos = 0;
  ranges.forEach(([s, e], i) => {
    if (s > pos) parts.push(<Fragment key={`t${i}`}>{text.slice(pos, s)}</Fragment>);
    if (e > s) parts.push(<mark key={`m${i}`} className={cx('hit')}>{text.slice(Math.max(s, pos), e)}</mark>);
    pos = Math.max(pos, e);
  });
  if (pos < text.length) parts.push(<Fragment key="rest">{text.slice(pos)}</Fragment>);
  return <>{parts}</>;
}

type Row =
  | { kind: 'file'; key: string; file: ContentFileResult }
  | { kind: 'match'; key: string; file: ContentFileResult; match: ContentMatchLine };

/** 入力欄の右端のトグル (大文字小文字の区別・単語単位・正規表現) */
function Toggle({ on, label, title, onClick }: { on: boolean; label: string; title: string; onClick: () => void }) {
  return (
    <button
      className={cx(`toggle${on ? ' on' : ''}`)}
      title={title}
      aria-label={title}
      aria-pressed={on}
      onClick={onClick}
      // 入力欄のフォーカスを奪わない
      onMouseDown={(e) => e.preventDefault()}
    >
      {label}
    </button>
  );
}

/**
 * 左パネルの検索 (インデックスを有効にしたリポジトリ)。VSCode の検索ビューと同様に、
 * 入力に合わせてリポジトリ内のファイルの内容を逐次検索し、ファイルごとに一致した行を一覧にする。
 */
export function RichSearchPanel({ repo }: { repo: string }) {
  const s = useContentSearch();
  const status = useIndexStatus(repo);
  const focusSeq = useSideBar((x) => x.focusSearchSeq);
  const openMenu = useContextMenu((x) => x.open);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<string | null>(null);

  // レーンのアイコン等で検索を開いたら入力欄へフォーカス
  useEffect(() => {
    if (focusSeq === 0) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusSeq]);

  // 入力・条件が変わったら (止まってから) 検索する
  useEffect(() => {
    const t = setTimeout(() => void useContentSearch.getState().run(repo), s.query ? DEBOUNCE_MS : 0);
    return () => clearTimeout(t);
  }, [repo, s.query, s.matchCase, s.wholeWord, s.regex, s.include, s.exclude]);

  // インデックスの作成中に出した結果は、作成が終わったら出し直す
  const building = status?.state === 'building';
  const prevBuilding = useRef(building);
  useEffect(() => {
    if (prevBuilding.current && !building && useContentSearch.getState().result?.building) {
      void useContentSearch.getState().run(repo);
    }
    prevBuilding.current = building;
  }, [building, repo]);

  const result = s.repo === repo ? s.result : null;

  const rows = useMemo<Row[]>(() => {
    if (!result) return [];
    const out: Row[] = [];
    for (const file of result.files) {
      out.push({ kind: 'file', key: `f:${file.path}`, file });
      if (s.collapsed.has(file.path)) continue;
      file.matches.forEach((match, i) => out.push({ kind: 'match', key: `m:${file.path}:${i}`, file, match }));
    }
    return out;
  }, [result, s.collapsed]);

  useEffect(() => setSelected(null), [result]);

  const activate = (row: Row) => {
    if (row.kind === 'match') openMatch(repo, row.file, row.match);
    else s.toggleCollapsed(row.file.path);
  };

  const scrollTo = (key: string) => {
    listRef.current?.querySelector(`[data-row="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'nearest' });
  };

  const onListKey = (e: React.KeyboardEvent) => {
    if (rows.length === 0) return;
    const idx = rows.findIndex((r) => r.key === selected);
    const select = (i: number) => {
      const r = rows[Math.max(0, Math.min(rows.length - 1, i))];
      setSelected(r.key);
      scrollTo(r.key);
    };
    const row = idx >= 0 ? rows[idx] : null;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      select(idx + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (idx <= 0) inputRef.current?.focus();
      else select(idx - 1);
    } else if (e.key === 'Enter' && row) {
      e.preventDefault();
      activate(row);
    } else if (e.key === 'ArrowLeft' && row) {
      e.preventDefault();
      if (row.kind === 'match') {
        const f = rows.findIndex((r) => r.kind === 'file' && r.file === row.file);
        if (f >= 0) select(f);
      } else if (!s.collapsed.has(row.file.path)) {
        s.toggleCollapsed(row.file.path);
      }
    } else if (e.key === 'ArrowRight' && row?.kind === 'file' && s.collapsed.has(row.file.path)) {
      e.preventDefault();
      s.toggleCollapsed(row.file.path);
    }
  };

  const fileMenu = (e: React.MouseEvent, file: ContentFileResult) => {
    e.preventDefault();
    setSelected(`f:${file.path}`);
    const abs = joinPath(repo, file.path);
    openMenu(e.clientX, e.clientY, [
      { label: '開く', action: () => void useEditor.getState().open(abs) },
      { label: 'フォルダ内に表示', action: () => void reveal(abs) },
      { separator: true },
      { label: 'パスをコピー', detail: abs, action: () => void copyText(abs) },
      { label: '相対パスをコピー', detail: file.path, action: () => void copyText(file.path) },
    ]);
  };

  const matchMenu = (e: React.MouseEvent, row: Extract<Row, { kind: 'match' }>) => {
    e.preventDefault();
    setSelected(row.key);
    const abs = joinPath(repo, row.file.path);
    const loc = `${row.file.path}:${row.match.line}`;
    openMenu(e.clientX, e.clientY, [
      { label: '開く', action: () => openMatch(repo, row.file, row.match) },
      { label: 'フォルダ内に表示', action: () => void reveal(abs) },
      { separator: true },
      { label: '行をコピー', action: () => void copyText(row.match.text) },
      { label: 'パス:行番号をコピー', detail: loc, action: () => void copyText(loc) },
    ]);
  };

  const summary = () => {
    if (s.error) return null;
    if (!result || !s.resultParams) return s.loading ? '検索中…' : null;
    const files = result.files.length;
    if (result.matchCount === 0) return '結果がありません';
    const base = `${files.toLocaleString('ja-JP')} ファイルに ${result.matchCount.toLocaleString('ja-JP')} 件の結果`;
    return result.truncated ? `${base} (上限 ${CONTENT_SEARCH_LIMIT.toLocaleString('ja-JP')} 件で打ち切り)` : base;
  };

  const hasResult = result !== null && result.files.length > 0;
  const allCollapsed = hasResult && result.files.every((f) => s.collapsed.has(f.path));

  return (
    <div className={cx('search-panel')}>
      <div className={cx('heading-row')}>
        <span className={cx('heading')}>検索</span>
        <button
          className={cx('icon-btn')}
          title="検索し直す"
          disabled={!s.query}
          onClick={() => void s.run(repo)}
        >
          ↻
        </button>
        <button
          className={cx('icon-btn')}
          title={allCollapsed ? 'すべて展開' : 'すべて折りたたむ'}
          disabled={!hasResult}
          onClick={() => s.setAllCollapsed(!allCollapsed)}
        >
          {allCollapsed ? '⊞' : '⊟'}
        </button>
        <button className={cx('icon-btn')} title="検索をクリア" disabled={!s.query && !result} onClick={() => s.clear()}>
          ✕
        </button>
      </div>
      <IndexStatusBar repo={repo} />
      <div className={cx('query-box')}>
        <input
          ref={inputRef}
          className={cx('query-input')}
          placeholder="検索"
          value={s.query}
          spellCheck={false}
          onChange={(e) => s.set({ query: e.target.value })}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === 'Enter') {
              e.preventDefault();
              void s.run(repo);
            } else if (e.key === 'Escape') {
              s.clear();
            } else if (e.key === 'ArrowDown' && rows.length > 0) {
              e.preventDefault();
              setSelected(rows[0].key);
              listRef.current?.focus();
            }
          }}
        />
        <Toggle on={s.matchCase} label="Aa" title="大文字と小文字を区別する" onClick={() => s.set({ matchCase: !s.matchCase })} />
        <Toggle on={s.wholeWord} label="ab" title="単語単位で検索する" onClick={() => s.set({ wholeWord: !s.wholeWord })} />
        <Toggle on={s.regex} label=".*" title="正規表現を使う" onClick={() => s.set({ regex: !s.regex })} />
      </div>
      <div className={cx('details-toggle-row')}>
        <button
          className={cx(`icon-btn${s.showDetails ? ' on' : ''}`)}
          title="含める / 除外するファイルの指定"
          aria-expanded={s.showDetails}
          onClick={() => s.set({ showDetails: !s.showDetails })}
        >
          …
        </button>
      </div>
      {s.showDetails && (
        <div className={cx('details')}>
          <label className={cx('detail-label')}>
            含めるファイル
            <input
              className={cx('detail-input')}
              placeholder="例: src, *.ts, docs/**/*.md"
              value={s.include}
              spellCheck={false}
              onChange={(e) => s.set({ include: e.target.value })}
            />
          </label>
          <label className={cx('detail-label')}>
            除外するファイル
            <input
              className={cx('detail-input')}
              placeholder="例: *.test.ts, dist"
              value={s.exclude}
              spellCheck={false}
              onChange={(e) => s.set({ exclude: e.target.value })}
            />
          </label>
        </div>
      )}
      {s.error && <div className={cx('error')}>{s.error}</div>}
      {summary() && (
        <div className={cx('summary')}>
          {summary()}
          {s.loading && result && <span className={cx('loading-dot')}> (検索中…)</span>}
          {result?.building && <span title="インデックスの作成中のため、まだ見つからないファイルがあります"> ・作成中</span>}
        </div>
      )}
      <div ref={listRef} className={cx('results')} tabIndex={0} onKeyDown={onListKey} role="tree">
        {rows.map((row) => {
          if (row.kind === 'file') {
            const name = row.file.path.slice(row.file.path.lastIndexOf('/') + 1);
            const dir = row.file.path.includes('/') ? row.file.path.slice(0, row.file.path.lastIndexOf('/')) : '';
            const open = !s.collapsed.has(row.file.path);
            return (
              <div
                key={row.key}
                data-row={row.key}
                role="treeitem"
                aria-expanded={open}
                className={cx(`file-row${selected === row.key ? ' selected' : ''}`)}
                title={row.file.path}
                onClick={() => {
                  setSelected(row.key);
                  s.toggleCollapsed(row.file.path);
                }}
                onDoubleClick={() => void useEditor.getState().open(joinPath(repo, row.file.path))}
                onContextMenu={(e) => fileMenu(e, row.file)}
              >
                <span className={cx('chevron')}>
                  <Chevron open={open} />
                </span>
                <span className={cx('icon')}>{fileIcon(fileEntryOf(row.file.path))}</span>
                <span className={cx('file-name')}>{name}</span>
                <span className={cx('file-dir')}>{dir}</span>
                <span className={cx('badge')}>{row.file.matches.reduce((n, m) => n + m.ranges.length, 0)}</span>
              </div>
            );
          }
          return (
            <div
              key={row.key}
              data-row={row.key}
              role="treeitem"
              className={cx(`match-row${selected === row.key ? ' selected' : ''}`)}
              title={`${row.file.path}:${row.match.line}`}
              onClick={() => {
                setSelected(row.key);
                openMatch(repo, row.file, row.match);
              }}
              onContextMenu={(e) => matchMenu(e, row)}
            >
              <span className={cx('line-no')}>{row.match.line}</span>
              <span className={cx('match-text')}>
                <MatchText text={row.match.text} ranges={row.match.ranges} />
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
